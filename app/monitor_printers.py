import asyncio
import logging
import platform
import re
import time
from datetime import datetime
from typing import Dict, Any, Tuple, List

from app.config import PING_TIMEOUT_SECONDS, TCP_TIMEOUT_SECONDS, DEFAULT_PRINTER_INTERVAL
from app.database import get_db_connection
from app.websocket_manager import ws_manager

logger = logging.getLogger("sentinel.printers_worker")

PING_TIME_REGEX = re.compile(r"(?:tempo|time)[=<](\d+)ms", re.IGNORECASE)

async def check_tcp_port(ip: str, port: int, timeout: float = TCP_TIMEOUT_SECONDS) -> Tuple[bool, float]:
    """Testa conexão TCP direta à porta de impressão (ex: 9100 RAW, 80 HTTP)."""
    start = time.perf_counter()
    try:
        conn = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        latency = (time.perf_counter() - start) * 1000
        return True, max(1.0, round(latency, 1))
    except ConnectionRefusedError:
        latency = (time.perf_counter() - start) * 1000
        return False, max(1.0, round(latency, 1))
    except (asyncio.TimeoutError, OSError):
        return False, 0.0

async def check_icmp_ping(ip: str, timeout_seconds: float = PING_TIMEOUT_SECONDS) -> Tuple[bool, float]:
    """Executa ping ICMP assíncrono compatível com Windows e Linux."""
    start = time.perf_counter()
    is_windows = platform.system().lower() == "windows"
    timeout_ms = int(timeout_seconds * 1000)

    try:
        if is_windows:
            cmd = ["ping", "-n", "1", "-w", str(timeout_ms), ip]
        else:
            cmd = ["ping", "-c", "1", "-W", str(int(timeout_seconds)), ip]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds + 1.0)
        encoding = "cp850" if is_windows else "utf-8"
        output = stdout.decode(encoding, errors="ignore")

        if proc.returncode == 0 and ("TTL=" in output or "ttl=" in output):
            match = PING_TIME_REGEX.search(output)
            if match:
                lat = float(match.group(1))
                return True, max(1.0, lat)
            fallback_lat = (time.perf_counter() - start) * 1000
            return True, max(1.0, round(fallback_lat, 1))
        return False, 0.0
    except Exception as e:
        logger.debug("Ping ICMP falhou para impressora %s: %s", ip, e)
        return False, 0.0

async def check_printer_connectivity(ip: str, port: int = 9100, web_port: int = 80) -> Tuple[str, float, int]:
    """Avalia conectividade da impressora via Ping e TCP (porta 9100 / Web EWS)."""
    icmp_ok, icmp_lat = await check_icmp_ping(ip)
    tcp_ok, tcp_lat = await check_tcp_port(ip, port)

    if not tcp_ok and web_port:
        web_ok, web_lat = await check_tcp_port(ip, web_port)
        if web_ok:
            tcp_ok = True
            tcp_lat = web_lat

    latency = tcp_lat if tcp_ok and tcp_lat > 0 else (icmp_lat if icmp_ok else 0.0)

    if icmp_ok and tcp_ok:
        return "online", latency, 1
    elif icmp_ok and not tcp_ok:
        return "warning", latency, 0
    elif tcp_ok and not icmp_ok:
        return "online", latency, 1
    else:
        return "offline", 0.0, 0

class PrinterMonitorWorker:
    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None
        self._semaphore = asyncio.Semaphore(25)

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("Worker de monitoramento de impressoras iniciado com sucesso.")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Worker de monitoramento de impressoras finalizado.")

    async def _monitor_loop(self):
        while self._running:
            try:
                await self.check_all_printers()
            except Exception as e:
                logger.error("Erro no ciclo de monitoramento de impressoras: %s", e)
            await asyncio.sleep(DEFAULT_PRINTER_INTERVAL)

    async def check_all_printers(self) -> List[Dict[str, Any]]:
        async with get_db_connection() as db:
            cursor = await db.execute("SELECT * FROM printers WHERE is_active = 1")
            printers = [dict(r) for r in await cursor.fetchall()]

        if not printers:
            return []

        tasks = [self._check_and_update_printer(p) for p in printers]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        valid_results = [r for r in results if isinstance(r, dict)]

        await ws_manager.broadcast({
            "type": "BATCH_STATUS_UPDATE",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "printers": valid_results
        })

        return valid_results

    async def check_single_printer_now(self, printer_id: int) -> Dict[str, Any]:
        async with get_db_connection() as db:
            cursor = await db.execute("SELECT * FROM printers WHERE id = ?", (printer_id,))
            row = await cursor.fetchone()
            if not row:
                raise ValueError("Impressora não encontrada")
            printer = dict(row)

        result = await self._check_and_update_printer(printer)

        await ws_manager.broadcast({
            "type": "SINGLE_STATUS_UPDATE",
            "printer": result
        })

        return result

    async def _check_and_update_printer(self, printer: Dict[str, Any]) -> Dict[str, Any]:
        async with self._semaphore:
            ip = printer["ip"]
            port = printer.get("port") or 9100
            web_port = printer.get("web_port") or 80

            status, latency, tcp_status = await check_printer_connectivity(ip, port, web_port)
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            last_seen = now_str if status in ("online", "warning") else printer.get("last_seen")
            old_status = printer.get("status")

            async with get_db_connection() as db:
                await db.execute(
                    """
                    UPDATE printers
                    SET status = ?, latency_ms = ?, tcp_status = ?, last_seen = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (status, latency, tcp_status, last_seen, now_str, printer["id"])
                )
                await db.commit()

            printer["status"] = status
            printer["latency_ms"] = latency
            printer["tcp_status"] = tcp_status
            printer["last_seen"] = last_seen
            printer["updated_at"] = now_str

            if old_status != status:
                await ws_manager.broadcast({
                    "type": "PRINTER_STATUS_CHANGED",
                    "printer_id": printer["id"],
                    "printer_name": printer["name"],
                    "branch": printer["branch"],
                    "ip": printer["ip"],
                    "old_status": old_status,
                    "new_status": status,
                    "timestamp": now_str
                })

            return printer

printer_worker = PrinterMonitorWorker()
