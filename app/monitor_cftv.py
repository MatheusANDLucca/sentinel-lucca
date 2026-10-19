import asyncio
import logging
import re
import socket
import time
from datetime import datetime
from typing import Dict, Any, Tuple
import aiosqlite

from app.config import DEFAULT_TIMEOUT
from app.database import get_db_connection
from app.websocket_manager import ws_manager
from app.telegram_service import dispatch_telegram_alert

logger = logging.getLogger("sentinel.cftv_worker")

PING_TIME_REGEX = re.compile(r"(?:tempo|time)[=<](\d+)ms", re.IGNORECASE)

async def check_tcp_port(ip: str, port: int, timeout: float = DEFAULT_TIMEOUT) -> Tuple[bool, float]:
    """Testa conexão TCP direta à porta do gravador."""
    start = time.perf_counter()
    try:
        conn = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        latency = (time.perf_counter() - start) * 1000
        return True, round(latency, 1)
    except ConnectionRefusedError:
        latency = (time.perf_counter() - start) * 1000
        return True, round(latency, 1)
    except (asyncio.TimeoutError, OSError):
        return False, 0.0

async def check_icmp_ping(ip: str, timeout_ms: int = 1500) -> Tuple[bool, float]:
    """Executa ping ICMP assíncrono compatível com Windows."""
    start = time.perf_counter()
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-n", "1", "-w", str(timeout_ms), ip,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=(timeout_ms / 1000.0) + 1.0)
        output = stdout.decode("cp850", errors="ignore")

        if proc.returncode == 0 and ("TTL=" in output or "ttl=" in output):
            match = PING_TIME_REGEX.search(output)
            if match:
                lat = float(match.group(1))
                return True, max(1.0, lat)
            fallback_lat = (time.perf_counter() - start) * 1000
            return True, round(fallback_lat, 1)
        return False, 0.0
    except Exception as e:
        logger.debug("Falha no ping ICMP para %s: %s", ip, e)
        return False, 0.0

async def check_recorder_status(ip: str, port: int | None = None) -> Tuple[str, float]:
    """Estratégia híbrida: tenta porta de serviço TCP e fallback para ICMP."""
    if port and port > 0:
        tcp_ok, tcp_lat = await check_tcp_port(ip, port)
        if tcp_ok:
            return "online", tcp_lat

    icmp_ok, icmp_lat = await check_icmp_ping(ip)
    if icmp_ok:
        return "online", icmp_lat

    return "offline", 0.0

async def check_single_recorder(recorder_data: Dict[str, Any], notify_changes: bool = True) -> Dict[str, Any]:
    """Verifica um único gravador, atualiza seu estado no SQLite e notifica clientes via WebSocket."""
    rec_id = recorder_data["id"]
    name = recorder_data["name"]
    ip = recorder_data["ip"]
    port = recorder_data["port"]
    old_status = recorder_data["status"]
    is_active = bool(recorder_data["is_active"])

    if not is_active:
        return recorder_data

    new_status, latency = await check_recorder_status(ip, port)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    status_changed = (old_status != "unknown" and old_status != new_status)

    async with get_db_connection() as db:
        if status_changed:
            event_type = new_status
            if new_status == "offline":
                msg = f"Gravador '{name}' ({ip}:{port or '-'}) ficou OFFLINE. Falha de comunicação."
            else:
                msg = f"Gravador '{name}' ({ip}:{port or '-'}) restabelecido. Gravador voltou a ficar ONLINE."

            await db.execute(
                """
                INSERT INTO incident_logs (recorder_id, recorder_name, recorder_ip, event_type, message, latency_ms, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (rec_id, name, ip, event_type, msg, latency, now_str)
            )

            await db.execute(
                """
                UPDATE recorders 
                SET status = ?, latency_ms = ?, last_checked = ?, last_status_change = ?
                WHERE id = ?
                """,
                (new_status, latency, now_str, now_str, rec_id)
            )
        else:
            await db.execute(
                """
                UPDATE recorders 
                SET status = ?, latency_ms = ?, last_checked = ?
                WHERE id = ?
                """,
                (new_status, latency, now_str, rec_id)
            )

        await db.commit()

    updated_rec = dict(recorder_data)
    updated_rec["status"] = new_status
    updated_rec["latency_ms"] = latency
    updated_rec["last_checked"] = now_str
    if status_changed:
        updated_rec["last_status_change"] = now_str

    if notify_changes:
        if status_changed:
            await ws_manager.broadcast({
                "type": "RECORDER_ALERT",
                "alert": {
                    "event_type": new_status,
                    "recorder_id": rec_id,
                    "recorder_name": name,
                    "ip": ip,
                    "timestamp": now_str,
                    "message": f"O gravador {name} ({ip}) agora está {new_status.upper()}!"
                }
            })
            asyncio.create_task(dispatch_telegram_alert(new_status, updated_rec))

        await ws_manager.broadcast({
            "type": "RECORDER_STATUS_UPDATE",
            "recorder": updated_rec
        })

    return updated_rec

class CFTVMonitorWorker:
    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        logger.info("Worker de monitoramento CFTV iniciado com sucesso.")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Worker de monitoramento CFTV finalizado.")

    async def get_check_interval(self) -> int:
        try:
            async with get_db_connection() as db:
                cursor = await db.execute("SELECT value FROM settings WHERE key = 'check_interval'")
                row = await cursor.fetchone()
                if row and row["value"]:
                    return max(3, int(row["value"]))
        except Exception:
            pass
        return 10

    async def check_all_recorders_now(self):
        """Verifica todos os gravadores ativos cadastrados concorrentemente."""
        async with get_db_connection() as db:
            cursor = await db.execute("SELECT * FROM recorders WHERE is_active = 1")
            rows = await cursor.fetchall()
            recorders = [dict(row) for row in rows]

        if not recorders:
            return

        tasks = [check_single_recorder(rec, notify_changes=True) for rec in recorders]
        await asyncio.gather(*tasks, return_exceptions=True)

        await ws_manager.broadcast({
            "type": "CYCLE_COMPLETED",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })

    async def _run_loop(self):
        await asyncio.sleep(2)
        while self._running:
            try:
                await self.check_all_recorders_now()
            except Exception as e:
                logger.error("Erro durante ciclo de monitoramento CFTV: %s", e)

            interval = await self.get_check_interval()
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break

cftv_worker = CFTVMonitorWorker()
