import os
import io
from pathlib import Path
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Response
from fastapi.responses import PlainTextResponse

from app.database import get_db_connection
from app.models import (
    PrinterCreate, PrinterUpdate, PrinterOut,
    TestPrintRequest, TestPrintResult, DashboardMetrics
)
from app.auth import get_current_user, require_roles, require_module_access, record_audit_log
from app.monitor_printers import printer_worker
from app.print_service import send_network_test_print
from app.import_export import (
    parse_xlsx_sheets, parse_csv_data, process_imported_data, generate_printers_csv
)

router = APIRouter(prefix="/api", tags=["Print Sentinel - Impressoras"], dependencies=[Depends(require_module_access("printers"))])

@router.get("/printers")
async def list_printers(
    branch: Optional[str] = Query(None, description="Filtrar por filial"),
    status: Optional[str] = Query(None, description="Filtrar por status: online, offline, warning"),
    search: Optional[str] = Query(None, description="Buscar por nome, IP, DNS, Gateway, Modelo, NS"),
    current_user: dict = Depends(get_current_user)
):
    """Retorna lista de impressoras com filtros e dados de rede."""
    query = "SELECT * FROM printers WHERE is_active = 1"
    params = []

    if branch and branch != "Todas":
        query += " AND branch = ?"
        params.append(branch)

    if status and status != "all":
        query += " AND status = ?"
        params.append(status)

    if search:
        s_term = f"%{search.strip()}%"
        query += """ AND (
            name LIKE ? OR ip LIKE ? OR dns LIKE ? OR gateway LIKE ? OR
            model LIKE ? OR brand LIKE ? OR serial_number LIKE ? OR department LIKE ?
        )"""
        params.extend([s_term] * 8)

    query += " ORDER BY branch ASC, name ASC"

    async with get_db_connection() as db:
        cursor = await db.execute(query, params)
        rows = [dict(r) for r in await cursor.fetchall()]

    return rows

@router.get("/printers/{printer_id}")
async def get_printer_detail(printer_id: int, current_user: dict = Depends(get_current_user)):
    """Retorna os dados completos de uma impressora específica."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM printers WHERE id = ?", (printer_id,))
        row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Impressora não encontrada.")
    return dict(row)

@router.post("/printers")
async def create_printer(
    data: PrinterCreate,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Cadastra uma nova impressora na rede."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT id FROM printers WHERE ip = ? AND is_active = 1", (data.ip.strip(),))
        if await cursor.fetchone():
            raise HTTPException(status_code=400, detail=f"Já existe uma impressora cadastrada com o IP {data.ip}.")

        from datetime import datetime
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        cursor = await db.execute(
            """
            INSERT INTO printers (
                name, branch, department, brand, model, printer_type,
                ip, dns, gateway, subnet_mask, mac_address, port, web_port,
                serial_number, pin, toner_model, ownership, vendor_contact,
                notes, is_active, status, latency_ms, tcp_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', 0.0, 0, ?, ?)
            """,
            (
                data.name.strip(), data.branch.strip(), data.department.strip() if data.department else "",
                data.brand.strip(), data.model.strip() if data.model else "", data.printer_type,
                data.ip.strip(), data.dns.strip() if data.dns else "", data.gateway.strip() if data.gateway else "",
                data.subnet_mask.strip() if data.subnet_mask else "255.255.255.0",
                data.mac_address.strip() if data.mac_address else "",
                data.port, data.web_port,
                data.serial_number.strip() if data.serial_number else "",
                data.pin.strip() if data.pin else "",
                data.toner_model.strip() if data.toner_model else "",
                data.ownership, data.vendor_contact.strip() if data.vendor_contact else "",
                data.notes.strip() if data.notes else "", data.is_active,
                now_str, now_str
            )
        )
        new_id = cursor.lastrowid
        await db.commit()

    await record_audit_log(
        current_user,
        "CREATE_PRINTER",
        f"Cadastrou impressora '{data.name}' ({data.ip}) na filial '{data.branch}'",
        target_type="printer",
        target_id=new_id
    )

    import asyncio
    asyncio.create_task(printer_worker.check_single_printer_now(new_id))

    return {"message": "Impressora cadastrada com sucesso.", "id": new_id}

@router.put("/printers/{printer_id}")
async def update_printer(
    printer_id: int,
    data: PrinterUpdate,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza dados cadastrais e de rede de uma impressora."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM printers WHERE id = ?", (printer_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Impressora não encontrada.")

        current = dict(row)

        if data.ip and data.ip.strip() != current["ip"]:
            chk = await db.execute("SELECT id FROM printers WHERE ip = ? AND id != ? AND is_active = 1", (data.ip.strip(), printer_id))
            if await chk.fetchone():
                raise HTTPException(status_code=400, detail=f"O IP {data.ip} já está em uso por outra impressora.")

        from datetime import datetime
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        update_dict = {k: v for k, v in data.model_dump().items() if v is not None}
        if not update_dict:
            return {"message": "Nenhum campo para atualizar."}

        update_dict["updated_at"] = now_str
        set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()])
        values = list(update_dict.values()) + [printer_id]

        await db.execute(f"UPDATE printers SET {set_clause} WHERE id = ?", values)
        await db.commit()

    await record_audit_log(
        current_user,
        "UPDATE_PRINTER",
        f"Atualizou impressora ID {printer_id} ({current['name']})",
        target_type="printer",
        target_id=printer_id
    )

    if "ip" in update_dict or "port" in update_dict:
        import asyncio
        asyncio.create_task(printer_worker.check_single_printer_now(printer_id))

    return {"message": "Impressora atualizada com sucesso."}

@router.delete("/printers/{printer_id}")
async def delete_printer(
    printer_id: int,
    current_user: dict = Depends(require_roles("admin"))
):
    """Exclui uma impressora do sistema (Apenas Administrador)."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT name, ip, branch FROM printers WHERE id = ?", (printer_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Impressora não encontrada.")

        p_name = row["name"]
        p_ip = row["ip"]

        await db.execute("DELETE FROM printers WHERE id = ?", (printer_id,))
        await db.execute("DELETE FROM test_print_logs WHERE printer_id = ?", (printer_id,))
        await db.commit()

    await record_audit_log(
        current_user,
        "DELETE_PRINTER",
        f"Excluiu permanentemente a impressora '{p_name}' ({p_ip})",
        target_type="printer",
        target_id=printer_id
    )

    return {"message": "Impressora excluída com sucesso."}

@router.post("/printers/{printer_id}/check")
async def check_printer_manual(printer_id: int, current_user: dict = Depends(get_current_user)):
    """Executa checagem imediata de ping e portas de uma impressora específica."""
    try:
        result = await printer_worker.check_single_printer_now(printer_id)
        return {
            "status": result["status"],
            "latency_ms": result["latency_ms"],
            "tcp_status": result["tcp_status"],
            "message": f"Conexão avaliada: {result['status'].upper()} ({result['latency_ms']}ms)"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/printers/check-all")
async def check_all_printers_manual(current_user: dict = Depends(get_current_user)):
    """Dispara uma varredura completa imediata em todas as impressoras cadastradas."""
    results = await printer_worker.check_all_printers()
    return {"message": f"Varredura iniciada para {len(results)} impressoras.", "count": len(results)}

@router.post("/printers/{printer_id}/test-print")
async def execute_test_print(
    printer_id: int,
    request_data: TestPrintRequest,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Envia um job de impressão de teste direto pela rede via Socket RAW (porta 9100)."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM printers WHERE id = ?", (printer_id,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Impressora não encontrada.")
        printer = dict(row)

    operator_name = current_user.get("full_name") or current_user.get("username", "Operador TI")
    
    success, message, bytes_sent = await send_network_test_print(
        printer=printer,
        test_type=request_data.test_type,
        custom_msg=request_data.custom_message,
        requested_by=operator_name
    )

    await record_audit_log(
        current_user,
        "TEST_PRINT",
        f"Disparou impressão de teste para '{printer['name']}' ({printer['ip']}) - Tipo: {request_data.test_type} - Resultado: {'Sucesso' if success else 'Falha'}",
        target_type="printer",
        target_id=printer_id
    )

    return {
        "success": success,
        "message": message,
        "bytes_sent": bytes_sent,
        "printer_name": printer["name"],
        "printer_ip": printer["ip"],
        "port": printer.get("port", 9100)
    }

@router.get("/printers/{printer_id}/test-logs")
async def get_test_print_logs(printer_id: int, current_user: dict = Depends(get_current_user)):
    """Retorna o histórico de impressões de teste enviadas para a impressora."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT * FROM test_print_logs
            WHERE printer_id = ?
            ORDER BY created_at DESC LIMIT 30
            """,
            (printer_id,)
        )
        logs = [dict(r) for r in await cursor.fetchall()]
    return logs

@router.get("/branches")
@router.get("/printers/branches")
async def list_branches(current_user: dict = Depends(get_current_user)):
    """Retorna todas as filiais cadastradas com estatísticas em tempo real."""
    async with get_db_connection() as db:
        cursor = await db.execute("""
            SELECT
                branch,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
                SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warning,
                SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline
            FROM printers
            WHERE is_active = 1
            GROUP BY branch
            ORDER BY branch ASC
        """)
        branches = [dict(r) for r in await cursor.fetchall()]

    return branches

@router.get("/metrics")
@router.get("/printers/metrics")
@router.get("/printers-metrics")
async def get_printers_metrics(current_user: dict = Depends(get_current_user)):
    """Retorna métricas consolidadas de impressoras para o dashboard."""
    async with get_db_connection() as db:
        cursor = await db.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
                SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warning,
                SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
                AVG(CASE WHEN status = 'online' AND latency_ms > 0 THEN latency_ms ELSE NULL END) as avg_latency
            FROM printers
            WHERE is_active = 1
        """)
        m_row = await cursor.fetchone()

        total = m_row["total"] or 0
        online = m_row["online"] or 0
        warning = m_row["warning"] or 0
        offline = m_row["offline"] or 0
        avg_lat = round(m_row["avg_latency"] or 0.0, 1)

        sla = round(((online + (warning * 0.5)) / total * 100), 1) if total > 0 else 100.0

        cursor = await db.execute("""
            SELECT brand, COUNT(*) as count
            FROM printers
            WHERE is_active = 1
            GROUP BY brand
            ORDER BY count DESC
        """)
        brands = [dict(r) for r in await cursor.fetchall()]

        cursor = await db.execute("SELECT COUNT(DISTINCT branch) as total_branches FROM printers WHERE is_active = 1")
        b_row = await cursor.fetchone()
        total_branches = b_row["total_branches"] or 0

    return {
        "total_printers": total,
        "online_printers": online,
        "warning_printers": warning,
        "offline_printers": offline,
        "branches_count": total_branches,
        "average_latency_ms": avg_lat,
        "sla_percentage": sla,
        "brands_distribution": brands
    }

@router.get("/printers/export/csv")
@router.get("/export-printers/csv")
async def export_printers_csv(
    branch: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user)
):
    """Exporta inventário de impressoras para CSV."""
    csv_content = await generate_printers_csv(branch or "")
    filename = f"inventario_impressoras_{branch or 'todas'}.csv".replace(" ", "_").lower()
    return Response(
        content=csv_content.encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@router.post("/import/file")
@router.post("/printers/import/file")
async def import_printers_file(
    file: UploadFile = File(...),
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Upload e processamento de planilha Excel (.xlsx) ou CSV para cadastro em lote."""
    filename = file.filename.lower()
    content = await file.read()

    if filename.endswith(".xlsx"):
        try:
            rows = parse_xlsx_sheets(content)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Erro ao processar arquivo Excel: {str(e)}")
    elif filename.endswith(".csv") or filename.endswith(".txt"):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = content.decode("latin-1")
            except Exception:
                text = content.decode("cp1252", errors="ignore")
        rows = parse_csv_data(text)
    else:
        raise HTTPException(status_code=400, detail="Formato não suportado. Por favor, envie uma planilha .xlsx ou .csv.")

    result = await process_imported_data(rows)

    await record_audit_log(
        current_user,
        "IMPORT_EXCEL",
        f"Importou arquivo '{file.filename}': {result['inserted']} inseridos, {result['updated']} atualizados.",
        target_type="printers_batch"
    )

    import asyncio
    asyncio.create_task(printer_worker.check_all_printers())

    return result

@router.post("/import/quick-local-sheet")
@router.post("/printers/import/quick-local-sheet")
async def import_local_documents_sheet(current_user: dict = Depends(require_roles("admin", "operador"))):
    """Importa automaticamente a planilha 'Planilha impressoras IP Ns e pin.xlsx' da pasta Documents."""
    docs_path = Path.home() / "Documents" / "Planilha impressoras IP Ns e pin.xlsx"
    if not docs_path.exists():
        alt_path = Path("C:/Users/TI-4817/Documents/Planilha impressoras IP Ns e pin.xlsx")
        if alt_path.exists():
            docs_path = alt_path
        else:
            raise HTTPException(status_code=404, detail="Planilha 'Planilha impressoras IP Ns e pin.xlsx' não encontrada na pasta Documents.")

    try:
        with open(docs_path, "rb") as f:
            content = f.read()
        rows = parse_xlsx_sheets(content)
        result = await process_imported_data(rows)

        await record_audit_log(
            current_user,
            "IMPORT_LOCAL_EXCEL",
            f"Importação rápida da planilha local: {result['inserted']} novos, {result['updated']} atualizados."
        )

        import asyncio
        asyncio.create_task(printer_worker.check_all_printers())
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro ao ler planilha local: {str(e)}")
