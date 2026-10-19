from fastapi import APIRouter, Depends
from app.database import get_db_connection
from app.auth import get_current_user

router = APIRouter(prefix="/api/portal", tags=["Portal Central & Hub"])

@router.get("/summary")
async def get_portal_summary(current_user: dict = Depends(get_current_user)):
    """Retorna métricas consolidadas dos módulos para alimentar os cards do Portal Central."""
    role = current_user.get("role", "operador")
    allowed = current_user.get("allowed_modules", "all")
    user_modules = [m.strip().lower() for m in allowed.split(",")]

    cftv_access = (role == "admin" or allowed == "all" or "cftv" in user_modules)
    printers_access = (role == "admin" or allowed == "all" or "printers" in user_modules)
    rma_access = (role == "admin" or allowed == "all" or "rma" in user_modules)

    cftv_summary = {
        "has_access": cftv_access,
        "total": 0,
        "online": 0,
        "offline": 0,
        "paused": 0,
        "sla": 100.0
    }

    printers_summary = {
        "has_access": printers_access,
        "total": 0,
        "online": 0,
        "offline": 0,
        "warning": 0,
        "branches": 0,
        "sla": 100.0
    }

    rma_summary = {
        "has_access": rma_access,
        "items_na_ti": 0,
        "items_em_conserto": 0,
        "requests_aguardando_nf": 0,
        "total_requests": 0
    }

    async with get_db_connection() as db:
        # Se tiver acesso a CFTV, coletar métricas rápidas
        if cftv_access:
            c_cur = await db.execute("""
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN is_active = 1 AND status = 'online' THEN 1 ELSE 0 END) as online,
                    SUM(CASE WHEN is_active = 1 AND status = 'offline' THEN 1 ELSE 0 END) as offline,
                    SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as paused
                FROM recorders
            """)
            c_row = await c_cur.fetchone()
            tot = c_row["total"] or 0
            onl = c_row["online"] or 0
            off = c_row["offline"] or 0
            pau = c_row["paused"] or 0
            act = onl + off
            sla = round((onl / act * 100), 1) if act > 0 else 100.0

            cftv_summary.update({
                "total": tot,
                "online": onl,
                "offline": off,
                "paused": pau,
                "sla": sla
            })

        # Se tiver acesso a Impressoras, coletar métricas rápidas
        if printers_access:
            p_cur = await db.execute("""
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
                    SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warning,
                    SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
                    COUNT(DISTINCT branch) as branches
                FROM printers
                WHERE is_active = 1
            """)
            p_row = await p_cur.fetchone()
            p_tot = p_row["total"] or 0
            p_onl = p_row["online"] or 0
            p_war = p_row["warning"] or 0
            p_off = p_row["offline"] or 0
            p_bra = p_row["branches"] or 0
            p_sla = round(((p_onl + (p_war * 0.5)) / p_tot * 100), 1) if p_tot > 0 else 100.0

            printers_summary.update({
                "total": p_tot,
                "online": p_onl,
                "warning": p_war,
                "offline": p_off,
                "branches": p_bra,
                "sla": p_sla
            })

        # Se tiver acesso a RMA, coletar métricas rápidas
        if rma_access:
            r_cur = await db.execute("""
                SELECT 
                    SUM(CASE WHEN status = 'na_ti' THEN 1 ELSE 0 END) as na_ti,
                    SUM(CASE WHEN status IN ('em_conserto', 'aguardando_nf') THEN 1 ELSE 0 END) as em_conserto
                FROM rma_items
                WHERE is_active = 1
            """)
            r_row = await r_cur.fetchone()

            q_cur = await db.execute("""
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(CASE WHEN status = 'aguardando_nf' THEN 1 ELSE 0 END) as aguardando_nf
                FROM rma_requests
            """)
            q_row = await q_cur.fetchone()

            rma_summary.update({
                "items_na_ti": r_row["na_ti"] or 0,
                "items_em_conserto": r_row["em_conserto"] or 0,
                "requests_aguardando_nf": q_row["aguardando_nf"] or 0,
                "total_requests": q_row["total_requests"] or 0
            })

    return {
        "user": {
            "id": current_user["id"],
            "username": current_user["username"],
            "full_name": current_user["full_name"],
            "role": current_user["role"],
            "allowed_modules": allowed
        },
        "cftv": cftv_summary,
        "printers": printers_summary,
        "rma": rma_summary
    }
