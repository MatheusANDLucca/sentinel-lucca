import io
import csv
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, Depends, Request, Response

from app.database import get_db_connection
from app.models import (
    RmaProviderCreate, RmaProviderUpdate, RmaProviderOut,
    RmaCarrierCreate, RmaCarrierUpdate, RmaCarrierOut,
    RmaItemCreate, RmaItemUpdate, RmaItemOut,
    RmaRequestCreate, RmaRequestUpdate, RmaRequestOut, RmaRequestItemOut,
    RmaDashboardMetrics
)
from app.auth import get_current_user, require_roles, require_module_access, record_audit_log
from app.websocket_manager import ws_manager

router = APIRouter(
    prefix="/api/rma",
    tags=["RMA & Controle Patrimonial"]
)

# ==================== FORNECEDORES / TERCEIRIZADAS ====================

@router.get("/providers", response_model=List[RmaProviderOut])
async def list_providers(current_user: dict = Depends(get_current_user)):
    """Lista empresas terceirizadas / assistências técnicas de manutenção."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_providers WHERE is_active = 1 ORDER BY name ASC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

@router.post("/providers", response_model=RmaProviderOut, status_code=201)
async def create_provider(
    payload: RmaProviderCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Cadastra uma nova empresa terceirizada para envio de manutenção."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            INSERT INTO rma_providers (
                name, trade_name, cnpj, state_registration, contact_name,
                phone, email, address, district, city, state, cep, notes,
                is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                payload.name.strip(), payload.trade_name.strip() if payload.trade_name else "",
                payload.cnpj.strip() if payload.cnpj else "",
                payload.state_registration.strip() if payload.state_registration else "",
                payload.contact_name.strip() if payload.contact_name else "",
                payload.phone.strip() if payload.phone else "",
                payload.email.strip() if payload.email else "",
                payload.address.strip() if payload.address else "",
                payload.district.strip() if payload.district else "",
                payload.city.strip() if payload.city else "",
                payload.state.strip() if payload.state else "",
                payload.cep.strip() if payload.cep else "",
                payload.notes.strip() if payload.notes else "",
                now_str, now_str
            )
        )
        new_id = cursor.lastrowid
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_providers WHERE id = ?", (new_id,))
        created = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_PROVIDER_CREATE",
        target_type="rma_provider",
        target_id=new_id,
        details=f"Cadastrou assistência terceirizada '{payload.name}' (CNPJ: {payload.cnpj or '-'})",
        ip_address=client_ip
    )

    return created

@router.put("/providers/{provider_id}", response_model=RmaProviderOut)
async def update_provider(
    provider_id: int,
    payload: RmaProviderUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza dados cadastrais de uma empresa terceirizada."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_providers WHERE id = ?", (provider_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Terceirizada não encontrada.")

        update_dict = {k: v for k, v in payload.model_dump().items() if v is not None}
        if not update_dict:
            return dict(existing)

        update_dict["updated_at"] = now_str
        set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()])
        values = list(update_dict.values()) + [provider_id]

        await db.execute(f"UPDATE rma_providers SET {set_clause} WHERE id = ?", values)
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_providers WHERE id = ?", (provider_id,))
        updated = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_PROVIDER_UPDATE",
        target_type="rma_provider",
        target_id=provider_id,
        details=f"Atualizou dados da terceirizada '{updated['name']}'",
        ip_address=client_ip
    )

    return updated

@router.delete("/providers/{provider_id}")
async def delete_provider(
    provider_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Remove uma terceirizada cadastrada."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT name FROM rma_providers WHERE id = ?", (provider_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Terceirizada não encontrada.")

        # Verificar se existem solicitações atreladas
        cursor = await db.execute("SELECT COUNT(*) FROM rma_requests WHERE provider_id = ?", (provider_id,))
        count = (await cursor.fetchone())[0]
        if count > 0:
            # Soft delete para não quebrar integridade das solicitações
            await db.execute("UPDATE rma_providers SET is_active = 0 WHERE id = ?", (provider_id,))
        else:
            await db.execute("DELETE FROM rma_providers WHERE id = ?", (provider_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="RMA_PROVIDER_DELETE",
        target_type="rma_provider",
        target_id=provider_id,
        details=f"Excluiu terceirizada '{existing['name']}'",
        ip_address=client_ip
    )

    return {"message": "Terceirizada removida com sucesso."}

# ==================== TRANSPORTADORAS (FRETE) ====================

@router.get("/carriers", response_model=List[RmaCarrierOut])
async def list_carriers(current_user: dict = Depends(get_current_user)):
    """Lista empresas de transporte / frete cadastradas."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_carriers WHERE is_active = 1 ORDER BY name ASC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

@router.post("/carriers", response_model=RmaCarrierOut, status_code=201)
async def create_carrier(
    payload: RmaCarrierCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Cadastra uma transportadora de frete."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            INSERT INTO rma_carriers (
                name, trade_name, cnpj, state_registration, phone, contact_name, notes, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                payload.name.strip(), payload.trade_name.strip() if payload.trade_name else "",
                payload.cnpj.strip() if payload.cnpj else "",
                payload.state_registration.strip() if payload.state_registration else "",
                payload.phone.strip() if payload.phone else "",
                payload.contact_name.strip() if payload.contact_name else "",
                payload.notes.strip() if payload.notes else "",
                now_str, now_str
            )
        )
        new_id = cursor.lastrowid
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_carriers WHERE id = ?", (new_id,))
        created = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_CARRIER_CREATE",
        target_type="rma_carrier",
        target_id=new_id,
        details=f"Cadastrou transportadora '{payload.name}' (CNPJ: {payload.cnpj or '-'})",
        ip_address=client_ip
    )

    return created

@router.put("/carriers/{carrier_id}", response_model=RmaCarrierOut)
async def update_carrier(
    carrier_id: int,
    payload: RmaCarrierUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza dados cadastrais de uma transportadora."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_carriers WHERE id = ?", (carrier_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Transportadora não encontrada.")

        update_dict = {k: v for k, v in payload.model_dump().items() if v is not None}
        if not update_dict:
            return dict(existing)

        update_dict["updated_at"] = now_str
        set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()])
        values = list(update_dict.values()) + [carrier_id]

        await db.execute(f"UPDATE rma_carriers SET {set_clause} WHERE id = ?", values)
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_carriers WHERE id = ?", (carrier_id,))
        updated = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_CARRIER_UPDATE",
        target_type="rma_carrier",
        target_id=carrier_id,
        details=f"Atualizou dados da transportadora '{updated['name']}'",
        ip_address=client_ip
    )

    return updated

@router.delete("/carriers/{carrier_id}")
async def delete_carrier(
    carrier_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Remove uma transportadora cadastrada."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT name FROM rma_carriers WHERE id = ?", (carrier_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Transportadora não encontrada.")

        cursor = await db.execute("SELECT COUNT(*) FROM rma_requests WHERE carrier_id = ?", (carrier_id,))
        count = (await cursor.fetchone())[0]
        if count > 0:
            await db.execute("UPDATE rma_carriers SET is_active = 0 WHERE id = ?", (carrier_id,))
        else:
            await db.execute("DELETE FROM rma_carriers WHERE id = ?", (carrier_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="RMA_CARRIER_DELETE",
        target_type="rma_carrier",
        target_id=carrier_id,
        details=f"Excluiu transportadora '{existing['name']}'",
        ip_address=client_ip
    )

    return {"message": "Transportadora removida com sucesso."}

# ==================== ITENS / EQUIPAMENTOS PATRIMONIAIS ====================

@router.get("/items", response_model=List[RmaItemOut])
async def list_items(
    search: Optional[str] = Query(None, description="Busca por patrimônio, serial, código ou descrição"),
    status: Optional[str] = Query(None, description="Filtrar por status: na_ti, aguardando_nf, em_conserto, retornado"),
    branch: Optional[str] = Query(None, description="Filtrar por filial de origem"),
    available_only: bool = Query(False, description="Apenas itens disponíveis para vincular a nova solicitação (status na_ti)"),
    current_user: dict = Depends(get_current_user)
):
    """Lista todos os itens em manutenção ou recebidos."""
    query = "SELECT * FROM rma_items WHERE is_active = 1"
    params = []

    if available_only:
        query += " AND status = 'na_ti'"
    elif status and status != "all":
        query += " AND status = ?"
        params.append(status)

    if branch and branch != "all":
        query += " AND origin_branch = ?"
        params.append(branch)

    if search:
        s = f"%{search.strip()}%"
        query += " AND (patrimony_number LIKE ? OR serial_number LIKE ? OR item_code LIKE ? OR description LIKE ? OR brand LIKE ?)"
        params.extend([s, s, s, s, s])

    query += " ORDER BY id DESC"

    async with get_db_connection() as db:
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

@router.post("/items", response_model=RmaItemOut, status_code=201)
async def create_item(
    payload: RmaItemCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Cadastra um novo equipamento que deu entrada na TI com defeito."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            INSERT INTO rma_items (
                patrimony_number, serial_number, item_code, description, brand, model,
                item_type, origin_branch, origin_department, ec, estimated_value,
                defect_reported, status, notes, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                payload.patrimony_number.strip(),
                payload.serial_number.strip() if payload.serial_number else "",
                payload.item_code.strip() if payload.item_code else "",
                payload.description.strip(),
                payload.brand.strip() if payload.brand else "",
                payload.model.strip() if payload.model else "",
                payload.item_type.strip() if payload.item_type else "Outro",
                payload.origin_branch.strip() if payload.origin_branch else "Matriz",
                payload.origin_department.strip() if payload.origin_department else "",
                payload.ec.strip() if payload.ec else "Bom",
                payload.estimated_value or 0.0,
                payload.defect_reported.strip() if payload.defect_reported else "",
                payload.status or "na_ti",
                payload.notes.strip() if payload.notes else "",
                now_str, now_str
            )
        )
        new_id = cursor.lastrowid
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_items WHERE id = ?", (new_id,))
        created = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_ITEM_CREATE",
        target_type="rma_item",
        target_id=new_id,
        details=f"Cadastrou equipamento: '{created['description']}' | Patrimônio: {created['patrimony_number']} | NS: {created['serial_number'] or '-'} | Filial: {created['origin_branch']}",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_ITEM_ADDED",
        "item": created
    })

    return created

@router.put("/items/{item_id}", response_model=RmaItemOut)
async def update_item(
    item_id: int,
    payload: RmaItemUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza dados de um item/equipamento cadastrado."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_items WHERE id = ?", (item_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Item não encontrado.")

        update_dict = {k: v for k, v in payload.model_dump().items() if v is not None}
        if not update_dict:
            return dict(existing)

        update_dict["updated_at"] = now_str
        set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()])
        values = list(update_dict.values()) + [item_id]

        await db.execute(f"UPDATE rma_items SET {set_clause} WHERE id = ?", values)
        await db.commit()

        cursor = await db.execute("SELECT * FROM rma_items WHERE id = ?", (item_id,))
        updated = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="RMA_ITEM_UPDATE",
        target_type="rma_item",
        target_id=item_id,
        details=f"Atualizou item: '{updated['description']}' (Patrimônio: {updated['patrimony_number']})",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_ITEM_UPDATED",
        "item": updated
    })

    return updated

@router.delete("/items/{item_id}")
async def delete_item(
    item_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Exclui ou arquiva um item de patrimônio."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT patrimony_number, description FROM rma_items WHERE id = ?", (item_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Item não encontrado.")

        await db.execute("DELETE FROM rma_items WHERE id = ?", (item_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="RMA_ITEM_DELETE",
        target_type="rma_item",
        target_id=item_id,
        details=f"Excluiu item '{existing['description']}' (Patrimônio: {existing['patrimony_number']})",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_ITEM_DELETED",
        "item_id": item_id
    })

    return {"message": "Item excluído com sucesso."}

# ==================== SOLICITAÇÕES DE CONTROLE PATRIMONIAL ====================

@router.get("/requests", response_model=List[RmaRequestOut])
async def list_requests(
    status: Optional[str] = Query(None),
    provider_id: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user)
):
    """Lista todas as solicitações de envio para conserto emitidas."""
    query = """
        SELECT 
            r.*,
            p.name as provider_name,
            p.trade_name as provider_trade_name,
            p.cnpj as provider_cnpj,
            p.state_registration as provider_ie,
            p.address as provider_address,
            p.phone as provider_phone,
            c.name as carrier_name,
            c.cnpj as carrier_cnpj,
            c.state_registration as carrier_ie
        FROM rma_requests r
        LEFT JOIN rma_providers p ON p.id = r.provider_id
        LEFT JOIN rma_carriers c ON c.id = r.carrier_id
        WHERE 1=1
    """
    params = []

    if status and status != "all":
        query += " AND r.status = ?"
        params.append(status)

    if provider_id:
        query += " AND r.provider_id = ?"
        params.append(provider_id)

    query += " ORDER BY r.id DESC"

    async with get_db_connection() as db:
        cursor = await db.execute(query, params)
        req_rows = [dict(row) for row in await cursor.fetchall()]

        results = []
        for req_dict in req_rows:
            # Buscar itens vinculados
            c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (req_dict["id"],))
            items = [dict(it) for it in await c_items.fetchall()]
            req_dict["items"] = items
            req_dict["total_value"] = sum(it.get("value", 0.0) or 0.0 for it in items)
            results.append(req_dict)

        return results

@router.post("/requests", response_model=RmaRequestOut, status_code=201)
async def create_request(
    payload: RmaRequestCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Cria uma nova Solicitação de Controle Patrimonial agrupando os itens selecionados."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    year = datetime.now().strftime("%Y")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        # Obter próximo número sequencial
        cursor = await db.execute("SELECT COUNT(*) FROM rma_requests")
        count = (await cursor.fetchone())[0] + 1
        req_number = f"SOL-{year}-{count:04d}"

        # Verificar se os itens existem
        placeholders = ", ".join(["?"] * len(payload.item_ids))
        cursor = await db.execute(f"SELECT * FROM rma_items WHERE id IN ({placeholders})", payload.item_ids)
        items_db = [dict(r) for r in await cursor.fetchall()]

        if len(items_db) == 0:
            raise HTTPException(status_code=400, detail="Nenhum item válido selecionado para a solicitação.")

        # Inserir Solicitação
        cursor = await db.execute(
            """
            INSERT INTO rma_requests (
                request_number, sender_name, sender_department, provider_id, recipient_department,
                subject_type, carrier_id, justification_notes, status, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_nf', ?, ?, ?)
            """,
            (
                req_number,
                payload.sender_name.strip(),
                payload.sender_department.strip(),
                payload.provider_id,
                payload.recipient_department.strip(),
                payload.subject_type,
                payload.carrier_id,
                payload.justification_notes.strip() if payload.justification_notes else "",
                current_user["id"],
                now_str, now_str
            )
        )
        new_req_id = cursor.lastrowid

        # Inserir itens vinculados e atualizar status dos itens
        for it in items_db:
            await db.execute(
                """
                INSERT INTO rma_request_items (
                    request_id, item_id, patrimony_number, description, serial_number,
                    item_code, origin_branch, ec, value, defect_notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_req_id,
                    it["id"],
                    it["patrimony_number"],
                    it["description"],
                    it.get("serial_number", ""),
                    it.get("item_code", ""),
                    it.get("origin_branch", ""),
                    it.get("ec", "Bom"),
                    it.get("estimated_value", 0.0),
                    it.get("defect_reported", ""),
                    now_str
                )
            )

            # Atualizar status do item para 'aguardando_nf'
            await db.execute(
                "UPDATE rma_items SET status = 'aguardando_nf', current_request_id = ?, updated_at = ? WHERE id = ?",
                (new_req_id, now_str, it["id"])
            )

        await db.commit()

        # Carregar objeto completo gerado
        cursor = await db.execute(
            """
            SELECT 
                r.*,
                p.name as provider_name,
                p.trade_name as provider_trade_name,
                p.cnpj as provider_cnpj,
                p.state_registration as provider_ie,
                p.address as provider_address,
                p.phone as provider_phone,
                c.name as carrier_name,
                c.cnpj as carrier_cnpj,
                c.state_registration as carrier_ie
            FROM rma_requests r
            LEFT JOIN rma_providers p ON p.id = r.provider_id
            LEFT JOIN rma_carriers c ON c.id = r.carrier_id
            WHERE r.id = ?
            """,
            (new_req_id,)
        )
        created_req = dict(await cursor.fetchone())

        c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (new_req_id,))
        created_req["items"] = [dict(it) for it in await c_items.fetchall()]
        created_req["total_value"] = sum(it.get("value", 0.0) or 0.0 for it in created_req["items"])

    await record_audit_log(
        user=current_user,
        action="RMA_REQUEST_CREATE",
        target_type="rma_request",
        target_id=new_req_id,
        details=f"Gerou solicitação {req_number} com {len(created_req['items'])} itens para {created_req.get('provider_name')}",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_REQUEST_CREATED",
        "request": created_req
    })

    return created_req

@router.get("/requests/{request_id}", response_model=RmaRequestOut)
async def get_request_detail(request_id: int, current_user: dict = Depends(get_current_user)):
    """Obtém os detalhes completos de uma solicitação com seus itens."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT 
                r.*,
                p.name as provider_name,
                p.trade_name as provider_trade_name,
                p.cnpj as provider_cnpj,
                p.state_registration as provider_ie,
                p.address as provider_address,
                p.district as provider_district,
                p.city as provider_city,
                p.state as provider_state,
                p.cep as provider_cep,
                p.phone as provider_phone,
                c.name as carrier_name,
                c.cnpj as carrier_cnpj,
                c.state_registration as carrier_ie
            FROM rma_requests r
            LEFT JOIN rma_providers p ON p.id = r.provider_id
            LEFT JOIN rma_carriers c ON c.id = r.carrier_id
            WHERE r.id = ?
            """,
            (request_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

        req_dict = dict(row)
        c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (request_id,))
        req_dict["items"] = [dict(it) for it in await c_items.fetchall()]
        req_dict["total_value"] = sum(it.get("value", 0.0) or 0.0 for it in req_dict["items"])
        return req_dict

@router.get("/requests/{request_id}/print-data")
async def get_request_print_data(request_id: int):
    """Retorna os dados estruturados formatados para impressão em folha A4 oficial."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT 
                r.*,
                p.name as provider_name,
                p.trade_name as provider_trade_name,
                p.cnpj as provider_cnpj,
                p.state_registration as provider_ie,
                p.address as provider_address,
                p.district as provider_district,
                p.city as provider_city,
                p.state as provider_state,
                p.cep as provider_cep,
                p.phone as provider_phone,
                c.name as carrier_name,
                c.cnpj as carrier_cnpj,
                c.state_registration as carrier_ie
            FROM rma_requests r
            LEFT JOIN rma_providers p ON p.id = r.provider_id
            LEFT JOIN rma_carriers c ON c.id = r.carrier_id
            WHERE r.id = ?
            """,
            (request_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

        req_dict = dict(row)
        c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (request_id,))
        req_dict["items"] = [dict(it) for it in await c_items.fetchall()]
        req_dict["total_value"] = sum(it.get("value", 0.0) or 0.0 for it in req_dict["items"])
        return {"request": req_dict}

@router.put("/requests/{request_id}", response_model=RmaRequestOut)
async def update_request(
    request_id: int,
    payload: RmaRequestUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "operador"))
):
    """Atualiza dados, status e Notas Fiscais de saída/retorno de uma solicitação."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM rma_requests WHERE id = ?", (request_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

        update_dict = {k: v for k, v in payload.model_dump().items() if v is not None}
        if update_dict:
            update_dict["updated_at"] = now_str
            set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()])
            values = list(update_dict.values()) + [request_id]
            await db.execute(f"UPDATE rma_requests SET {set_clause} WHERE id = ?", values)

            # Atualizar status dos itens caso o status da solicitação tenha mudado
            if "status" in update_dict:
                new_st = update_dict["status"]
                item_new_status = "na_ti"
                if new_st in ("aguardando_nf", "rascunho"):
                    item_new_status = "aguardando_nf"
                elif new_st in ("em_conserto", "em_transito"):
                    item_new_status = "em_conserto"
                elif new_st == "retornado":
                    item_new_status = "retornado"

                # Atualizar os itens vinculados a esta solicitação
                await db.execute(
                    """
                    UPDATE rma_items 
                    SET status = ?, updated_at = ?
                    WHERE id IN (SELECT item_id FROM rma_request_items WHERE request_id = ?)
                    """,
                    (item_new_status, now_str, request_id)
                )

            await db.commit()

        cursor = await db.execute(
            """
            SELECT 
                r.*,
                p.name as provider_name,
                p.trade_name as provider_trade_name,
                p.cnpj as provider_cnpj,
                p.state_registration as provider_ie,
                p.address as provider_address,
                p.phone as provider_phone,
                c.name as carrier_name,
                c.cnpj as carrier_cnpj,
                c.state_registration as carrier_ie
            FROM rma_requests r
            LEFT JOIN rma_providers p ON p.id = r.provider_id
            LEFT JOIN rma_carriers c ON c.id = r.carrier_id
            WHERE r.id = ?
            """,
            (request_id,)
        )
        updated_req = dict(await cursor.fetchone())
        c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (request_id,))
        updated_req["items"] = [dict(it) for it in await c_items.fetchall()]
        updated_req["total_value"] = sum(it.get("value", 0.0) or 0.0 for it in updated_req["items"])

    await record_audit_log(
        user=current_user,
        action="RMA_REQUEST_UPDATE",
        target_type="rma_request",
        target_id=request_id,
        details=f"Atualizou solicitação {updated_req['request_number']} (Status: {updated_req['status']})",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_REQUEST_UPDATED",
        "request": updated_req
    })

    return updated_req

@router.delete("/requests/{request_id}")
async def delete_request(
    request_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Exclui ou cancela uma solicitação de remessa e libera os itens de volta para a TI."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT request_number FROM rma_requests WHERE id = ?", (request_id,))
        existing = await cursor.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

        # Liberar os itens de volta para status 'na_ti'
        await db.execute(
            """
            UPDATE rma_items 
            SET status = 'na_ti', current_request_id = NULL, updated_at = ?
            WHERE id IN (SELECT item_id FROM rma_request_items WHERE request_id = ?)
            """,
            (now_str, request_id)
        )

        # Deletar itens vinculados e a solicitação
        await db.execute("DELETE FROM rma_request_items WHERE request_id = ?", (request_id,))
        await db.execute("DELETE FROM rma_requests WHERE id = ?", (request_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="RMA_REQUEST_DELETE",
        target_type="rma_request",
        target_id=request_id,
        details=f"Excluiu a solicitação de envio {existing['request_number']}",
        ip_address=client_ip
    )

    await ws_manager.broadcast({
        "type": "RMA_REQUEST_DELETED",
        "request_id": request_id
    })

    return {"message": "Solicitação excluída com sucesso e itens liberados."}

# ==================== DADOS PARA IMPRESSÃO DO DOCUMENTO ====================

@router.get("/requests/{request_id}/print-data")
async def get_print_document_data(request_id: int, current_user: dict = Depends(get_current_user)):
    """Retorna os dados consolidados e formatados para gerar o impresso de Controle Patrimonial."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT 
                r.*,
                p.name as provider_name,
                p.trade_name as provider_trade_name,
                p.cnpj as provider_cnpj,
                p.state_registration as provider_ie,
                p.address as provider_address,
                p.district as provider_district,
                p.city as provider_city,
                p.state as provider_state,
                p.cep as provider_cep,
                p.phone as provider_phone,
                c.name as carrier_name,
                c.trade_name as carrier_trade_name,
                c.cnpj as carrier_cnpj,
                c.state_registration as carrier_ie
            FROM rma_requests r
            LEFT JOIN rma_providers p ON p.id = r.provider_id
            LEFT JOIN rma_carriers c ON c.id = r.carrier_id
            WHERE r.id = ?
            """,
            (request_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Solicitação não encontrada.")

        req_dict = dict(row)
        c_items = await db.execute("SELECT * FROM rma_request_items WHERE request_id = ?", (request_id,))
        req_dict["items"] = [dict(it) for it in await c_items.fetchall()]

        return {
            "company_header": "COOPERATIVA AGROPECUÁRIA UNAÍ LTDA",
            "document_title": "CONTROLE PATRIMONIAL",
            "request": req_dict
        }

# ==================== MÉTRICAS & KPIS ====================

@router.get("/stats", response_model=RmaDashboardMetrics)
async def get_rma_stats(current_user: dict = Depends(get_current_user)):
    """Retorna estatísticas consolidadas para os cards do módulo RMA."""
    async with get_db_connection() as db:
        cur_it = await db.execute("""
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'na_ti' THEN 1 ELSE 0 END) as na_ti,
                SUM(CASE WHEN status IN ('em_conserto', 'aguardando_nf') THEN 1 ELSE 0 END) as em_conserto,
                SUM(CASE WHEN status = 'retornado' THEN 1 ELSE 0 END) as retornados
            FROM rma_items
            WHERE is_active = 1
        """)
        it_row = await cur_it.fetchone()

        cur_rq = await db.execute("""
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'aguardando_nf' THEN 1 ELSE 0 END) as aguardando_nf,
                SUM(CASE WHEN status IN ('em_conserto', 'em_transito') THEN 1 ELSE 0 END) as em_conserto,
                SUM(CASE WHEN status = 'retornado' THEN 1 ELSE 0 END) as finalizados
            FROM rma_requests
        """)
        rq_row = await cur_rq.fetchone()

    return RmaDashboardMetrics(
        total_items=it_row["total"] or 0,
        items_na_ti=it_row["na_ti"] or 0,
        items_em_conserto=it_row["em_conserto"] or 0,
        items_retornados=it_row["retornados"] or 0,
        total_requests=rq_row["total"] or 0,
        requests_aguardando_nf=rq_row["aguardando_nf"] or 0,
        requests_em_conserto=rq_row["em_conserto"] or 0,
        requests_finalizados=rq_row["finalizados"] or 0
    )
