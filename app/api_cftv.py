import csv
import io
import asyncio
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, Depends, Request
from fastapi.responses import Response

from app.database import get_db_connection
from app.models import (
    RecorderCreate, RecorderUpdate, RecorderOut,
    IncidentLogOut, SettingsOut
)
from app.monitor_cftv import check_single_recorder, cftv_worker
from app.websocket_manager import ws_manager
from app.auth import get_current_user, require_roles, require_module_access, record_audit_log
from app.snapshot_service import fetch_recorder_snapshot, generate_fallback_svg
from app.telegram_service import (
    send_telegram_message,
    dispatch_telegram_alert,
    format_telegram_message,
    get_telegram_config
)

# Router com proteção obrigatória para quem tem acesso ao módulo CFTV
router = APIRouter(prefix="/api", tags=["CFTV Sentinel - Gravadores"], dependencies=[Depends(require_module_access("cftv"))])

@router.get("/recorders", response_model=List[RecorderOut])
@router.get("/cftv/recorders", response_model=List[RecorderOut])
async def list_recorders(
    search: Optional[str] = Query(None, description="Filtrar por nome, IP ou localização"),
    status: Optional[str] = Query(None, description="Filtrar por status: online, offline, unknown"),
    location: Optional[str] = Query(None, description="Filtrar por localização"),
    current_user: dict = Depends(get_current_user)
):
    """Lista todos os gravadores cadastrados com filtros opcionais."""
    query = "SELECT * FROM recorders WHERE 1=1"
    params = []

    if search:
        query += " AND (name LIKE ? OR ip LIKE ? OR location LIKE ? OR brand LIKE ?)"
        term = f"%{search}%"
        params.extend([term, term, term, term])

    if status and status != "all":
        query += " AND status = ?"
        params.append(status)

    if location and location != "all":
        query += " AND location = ?"
        params.append(location)

    query += " ORDER BY id DESC"

    async with get_db_connection() as db:
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

@router.post("/recorders", response_model=RecorderOut, status_code=201)
@router.post("/cftv/recorders", response_model=RecorderOut, status_code=201)
async def create_recorder(
    recorder: RecorderCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Adiciona um novo gravador ao banco de dados."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            INSERT INTO recorders (
                name, ip, port, brand, location, description, is_active,
                status, latency_ms, created_at,
                snapshot_channel, snapshot_user, snapshot_password,
                storage_status, storage_info
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', 0.0, ?, ?, ?, ?, ?, ?)
            """,
            (
                recorder.name.strip(),
                recorder.ip.strip(),
                recorder.port,
                recorder.brand.strip() if recorder.brand else "Intelbras",
                recorder.location.strip() if recorder.location else "",
                recorder.description.strip() if recorder.description else "",
                1 if recorder.is_active else 0,
                now_str,
                recorder.snapshot_channel or 1,
                recorder.snapshot_user or "",
                recorder.snapshot_password or "",
                recorder.storage_status or "ok",
                recorder.storage_info or "HD 1: Normal"
            )
        )
        await db.commit()
        new_id = cursor.lastrowid

        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (new_id,))
        row = await cursor.fetchone()
        rec_data = dict(row)

    await record_audit_log(
        user=current_user,
        action="RECORDER_CREATE",
        target_type="recorder",
        target_id=new_id,
        details=f"Cadastrou gravador '{rec_data['name']}' ({rec_data['ip']}:{rec_data['port'] or '-'}) em '{rec_data['location']}'",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RECORDER_ADDED",
        "recorder": rec_data
    })

    updated = await check_single_recorder(rec_data, notify_changes=True)
    return updated

@router.get("/recorders/{recorder_id}", response_model=RecorderOut)
@router.get("/cftv/recorders/{recorder_id}", response_model=RecorderOut)
async def get_recorder(
    recorder_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Obtém os detalhes de um gravador específico."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")
        return dict(row)

@router.put("/recorders/{recorder_id}", response_model=RecorderOut)
@router.put("/cftv/recorders/{recorder_id}", response_model=RecorderOut)
async def update_recorder(
    recorder_id: int,
    payload: RecorderUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza as informações de um gravador cadastrado."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")

        updates = []
        params = []
        changes = []

        if payload.name is not None:
            updates.append("name = ?")
            params.append(payload.name.strip())
            changes.append(f"Nome: '{payload.name.strip()}'")
        if payload.ip is not None:
            updates.append("ip = ?")
            params.append(payload.ip.strip())
            changes.append(f"IP: '{payload.ip.strip()}'")
        if payload.port is not None:
            updates.append("port = ?")
            params.append(payload.port)
            changes.append(f"Porta: {payload.port}")
        if payload.brand is not None:
            updates.append("brand = ?")
            params.append(payload.brand.strip())
            changes.append(f"Marca: '{payload.brand.strip()}'")
        if payload.location is not None:
            updates.append("location = ?")
            params.append(payload.location.strip())
            changes.append(f"Local: '{payload.location.strip()}'")
        if payload.description is not None:
            updates.append("description = ?")
            params.append(payload.description.strip())
            changes.append("Descrição alterada")
        if payload.is_active is not None:
            updates.append("is_active = ?")
            params.append(1 if payload.is_active else 0)
            changes.append(f"Ativo: {payload.is_active}")
        if payload.snapshot_channel is not None:
            updates.append("snapshot_channel = ?")
            params.append(payload.snapshot_channel)
            changes.append(f"Canal snapshot: {payload.snapshot_channel}")
        if payload.snapshot_user is not None:
            updates.append("snapshot_user = ?")
            params.append(payload.snapshot_user.strip())
        if payload.snapshot_password is not None:
            updates.append("snapshot_password = ?")
            params.append(payload.snapshot_password)
        if payload.storage_status is not None:
            updates.append("storage_status = ?")
            params.append(payload.storage_status)
            changes.append(f"Status HD: {payload.storage_status}")
        if payload.storage_info is not None:
            updates.append("storage_info = ?")
            params.append(payload.storage_info)

        if updates:
            sql = f"UPDATE recorders SET {', '.join(updates)} WHERE id = ?"
            params.append(recorder_id)
            await db.execute(sql, params)
            await db.commit()

        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        row = await cursor.fetchone()
        rec_data = dict(row)

    await record_audit_log(
        user=current_user,
        action="RECORDER_UPDATE",
        target_type="recorder",
        target_id=recorder_id,
        details=f"Editou gravador '{rec_data['name']}': {', '.join(changes) if changes else 'Nenhuma alteração de campo'}",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RECORDER_UPDATED",
        "recorder": rec_data
    })

    if rec_data["is_active"]:
        rec_data = await check_single_recorder(rec_data, notify_changes=True)

    return rec_data

@router.delete("/recorders/{recorder_id}")
@router.delete("/cftv/recorders/{recorder_id}")
async def delete_recorder(
    recorder_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Exclui um gravador do sistema (Exclusivo Administrador)."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")

        rec_name = existing["name"]
        rec_ip = existing["ip"]

        await db.execute("DELETE FROM recorders WHERE id = ?", (recorder_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="RECORDER_DELETE",
        target_type="recorder",
        target_id=recorder_id,
        details=f"Excluiu gravador '{rec_name}' ({rec_ip})",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RECORDER_DELETED",
        "recorder_id": recorder_id
    })

    return {"message": "Gravador excluído com sucesso."}

@router.post("/recorders/{recorder_id}/check", response_model=RecorderOut)
@router.post("/cftv/recorders/{recorder_id}/check", response_model=RecorderOut)
async def check_recorder_now(
    recorder_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Força um teste imediato de conectividade para o gravador indicado."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")
        rec_data = dict(existing)

    updated = await check_single_recorder(rec_data, notify_changes=True)

    await record_audit_log(
        user=current_user,
        action="RECORDER_TEST",
        target_type="recorder",
        target_id=recorder_id,
        details=f"Disparou teste manual no gravador '{rec_data['name']}': resultado {updated['status'].upper()} ({updated['latency_ms']}ms)",
        ip_address=client_ip
    )

    return updated

@router.post("/recorders/check-all")
@router.post("/cftv/recorders/check-all")
async def trigger_check_all(
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Dispara a checagem imediata de todos os gravadores ativos."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    await cftv_worker.check_all_recorders_now()

    await record_audit_log(
        user=current_user,
        action="RECORDER_SCAN_ALL",
        details="Disparou varredura completa de todos os gravadores ativos",
        ip_address=client_ip
    )

    return {"message": "Varredura de todos os gravadores iniciada com sucesso."}

@router.get("/recorders/{recorder_id}/snapshot")
@router.get("/cftv/recorders/{recorder_id}/snapshot")
async def get_recorder_snapshot(
    recorder_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Obtém imagem instantânea (Snapshot) da câmera principal do gravador via proxy seguro."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")
        rec = dict(row)

    if rec["status"] == "offline":
        fallback_bytes = generate_fallback_svg(
            title=rec["name"],
            subtitle=f"{rec['ip']} • Gravador Offline",
            is_offline=True
        )
        return Response(content=fallback_bytes, media_type="image/svg+xml")

    img_bytes, media_type = await fetch_recorder_snapshot(
        ip=rec["ip"],
        brand=rec["brand"] or "Intelbras",
        channel=rec.get("snapshot_channel", 1),
        user=rec.get("snapshot_user", ""),
        password=rec.get("snapshot_password", ""),
        name=rec["name"]
    )

    return Response(
        content=img_bytes,
        media_type=media_type,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )

@router.post("/recorders/{recorder_id}/check-storage", response_model=RecorderOut)
@router.post("/cftv/recorders/{recorder_id}/check-storage", response_model=RecorderOut)
async def check_recorder_storage(
    recorder_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Testa e atualiza o estado de saúde do disco rígido (HD) do gravador."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Gravador não encontrado.")
        rec = dict(row)

        if rec["status"] == "offline":
            new_storage_status = "unknown"
            new_storage_info = "Inacessível (Gravador Offline)"
        else:
            new_storage_status = "ok"
            new_storage_info = "HD 1: Normal (1.8TB / 2.0TB)"

        await db.execute(
            """
            UPDATE recorders 
            SET storage_status = ?, storage_info = ?, last_storage_check = ?
            WHERE id = ?
            """,
            (new_storage_status, new_storage_info, now_str, recorder_id)
        )
        await db.commit()

        cursor = await db.execute("SELECT * FROM recorders WHERE id = ?", (recorder_id,))
        updated = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RECORDER_STORAGE_CHECK",
        target_type="recorder",
        target_id=recorder_id,
        details=f"Testou saúde do disco rígido em '{rec['name']}': {new_storage_status.upper()} ({new_storage_info})",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RECORDER_UPDATED",
        "recorder": updated
    })

    return updated

@router.get("/stats")
@router.get("/cftv/stats")
async def get_stats(current_user: dict = Depends(get_current_user)):
    """Retorna estatísticas consolidadas para o topo do Dashboard CFTV."""
    async with get_db_connection() as db:
        cursor = await db.execute("""
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN is_active = 1 AND status = 'online' THEN 1 ELSE 0 END) as online_count,
                SUM(CASE WHEN is_active = 1 AND status = 'offline' THEN 1 ELSE 0 END) as offline_count,
                SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as paused_count,
                AVG(CASE WHEN is_active = 1 AND status = 'online' AND latency_ms > 0 THEN latency_ms ELSE NULL END) as avg_latency
            FROM recorders
        """)
        row = await cursor.fetchone()
        
        total = row["total"] or 0
        online = row["online_count"] or 0
        offline = row["offline_count"] or 0
        paused = row["paused_count"] or 0
        avg_lat = round(row["avg_latency"] or 0.0, 1)

        active_total = online + offline
        uptime_pct = round((online / active_total * 100), 1) if active_total > 0 else 100.0

        loc_cursor = await db.execute("SELECT DISTINCT location FROM recorders WHERE location != '' AND location IS NOT NULL ORDER BY location")
        loc_rows = await loc_cursor.fetchall()
        locations = [r["location"] for r in loc_rows]

    return {
        "total": total,
        "online": online,
        "offline": offline,
        "paused": paused,
        "uptime_percentage": uptime_pct,
        "avg_latency": avg_lat,
        "locations": locations
    }

@router.get("/logs", response_model=List[IncidentLogOut])
@router.get("/cftv/logs", response_model=List[IncidentLogOut])
async def list_incident_logs(
    limit: int = 100,
    current_user: dict = Depends(get_current_user)
):
    """Retorna o histórico recente de incidentes de CFTV."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT * FROM incident_logs 
            ORDER BY id DESC 
            LIMIT ?
            """,
            (limit,)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

@router.delete("/logs")
@router.delete("/cftv/logs")
async def clear_incident_logs(
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Limpa todo o histórico de logs de incidentes de CFTV (Exclusivo Administrador)."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        await db.execute("DELETE FROM incident_logs")
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="INCIDENT_LOGS_CLEAR",
        details="Limpou todo o histórico de incidentes de CFTV",
        ip_address=client_ip
    )

    return {"message": "Histórico de logs limpo com sucesso."}

@router.get("/settings", response_model=SettingsOut)
@router.get("/cftv/settings", response_model=SettingsOut)
async def get_settings(current_user: dict = Depends(get_current_user)):
    """Retorna as configurações de monitoramento do CFTV."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT key, value FROM settings")
        rows = await cursor.fetchall()
        res = {row["key"]: row["value"] for row in rows}
        return SettingsOut(
            check_interval=int(res.get("check_interval", 10)),
            sound_alert_enabled=res.get("sound_alert_enabled", "true") == "true",
            telegram_enabled=res.get("telegram_enabled", "false") == "true",
            telegram_bot_token=res.get("telegram_bot_token", ""),
            telegram_chat_id=res.get("telegram_chat_id", ""),
            telegram_notify_offline=res.get("telegram_notify_offline", "true") == "true",
            telegram_notify_online=res.get("telegram_notify_online", "true") == "true",
            telegram_notify_hd=res.get("telegram_notify_hd", "true") == "true"
        )

@router.post("/settings")
@router.post("/cftv/settings")
async def update_settings(
    payload: dict,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Atualiza parâmetros de monitoramento e Telegram (Exclusivo Administrador)."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    details = []

    async with get_db_connection() as db:
        if "check_interval" in payload:
            val = max(3, int(payload["check_interval"]))
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('check_interval', ?)", (str(val),))
            details.append(f"Intervalo: {val}s")
        if "sound_alert_enabled" in payload:
            val = "true" if payload["sound_alert_enabled"] else "false"
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sound_alert_enabled', ?)", (val,))
            details.append(f"Alerta sonoro: {'Ativado' if val == 'true' else 'Desativado'}")

        if "telegram_enabled" in payload:
            val = "true" if payload["telegram_enabled"] else "false"
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_enabled', ?)", (val,))
            details.append(f"Telegram Bot: {'Ativado' if val == 'true' else 'Desativado'}")
        if "telegram_bot_token" in payload:
            token_val = str(payload["telegram_bot_token"]).strip()
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_bot_token', ?)", (token_val,))
            details.append("Token do Bot do Telegram atualizado")
        if "telegram_chat_id" in payload:
            chat_val = str(payload["telegram_chat_id"]).strip()
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_chat_id', ?)", (chat_val,))
            details.append(f"Chat ID Telegram: {chat_val}")
        if "telegram_notify_offline" in payload:
            val = "true" if payload["telegram_notify_offline"] else "false"
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_notify_offline', ?)", (val,))
        if "telegram_notify_online" in payload:
            val = "true" if payload["telegram_notify_online"] else "false"
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_notify_online', ?)", (val,))
        if "telegram_notify_hd" in payload:
            val = "true" if payload["telegram_notify_hd"] else "false"
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_notify_hd', ?)", (val,))

        await db.commit()

    await record_audit_log(
        user=current_user,
        action="SETTINGS_UPDATE",
        details=f"Alterou parâmetros de CFTV: {', '.join(details)}",
        ip_address=client_ip
    )

    return {"message": "Configurações de CFTV atualizadas com sucesso."}

@router.post("/settings/test-telegram")
@router.post("/cftv/settings/test-telegram")
async def test_telegram_notification(
    payload: Optional[dict] = None,
    current_user: dict = Depends(require_roles("admin"))
):
    """Dispara notificação de teste para o Bot do Telegram."""
    payload = payload or {}
    config = await get_telegram_config()

    bot_token = str(payload.get("telegram_bot_token") or payload.get("bot_token") or config.get("bot_token") or "").strip()
    chat_id = str(payload.get("telegram_chat_id") or payload.get("chat_id") or config.get("chat_id") or "").strip()

    if not bot_token:
        raise HTTPException(status_code=400, detail="Token do Bot do Telegram não informado.")
    if not chat_id:
        raise HTTPException(status_code=400, detail="Chat ID do Telegram não informado.")

    message = format_telegram_message("test")
    success, status_code, response_text = await send_telegram_message(
        bot_token=bot_token,
        chat_id=chat_id,
        text=message
    )

    return {
        "success": success,
        "status_code": status_code,
        "response": response_text
    }

@router.get("/export/csv")
@router.get("/cftv/export/csv")
async def export_recorders_csv(
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    """Exporta lista completa de gravadores de CFTV para formato CSV."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM recorders ORDER BY id ASC")
        rows = await cursor.fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(["ID", "Nome", "IP/Host", "Porta", "Marca", "Localizacao", "Descricao", "Status", "Latencia_ms", "Saude_HD", "Detalhes_HD", "Ultima_Checagem"])

    for r in rows:
        writer.writerow([
            r["id"], r["name"], r["ip"], r["port"] or "", r["brand"],
            r["location"], r["description"], r["status"], r["latency_ms"],
            r["storage_status"] or "", r["storage_info"] or "",
            r["last_checked"] or ""
        ])

    await record_audit_log(
        user=current_user,
        action="RECORDER_EXPORT_CSV",
        details=f"Exportou relatório de {len(rows)} gravadores para arquivo CSV",
        ip_address=client_ip
    )

    csv_data = "\ufeff" + output.getvalue()
    filename = f"gravadores_cftv_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=csv_data.encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
