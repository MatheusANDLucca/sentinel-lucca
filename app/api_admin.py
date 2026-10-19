import csv
import io
import sqlite3
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import Response

from app.database import get_db_connection
from app.config import DB_PATH, BACKUP_DIR
from app.auth import (
    hash_password, require_roles, record_audit_log, get_current_user
)
from app.models import (
    UserOut, UserCreate, UserUpdate, ResetPasswordRequest, AuditLogOut
)

router = APIRouter(prefix="/api/admin", tags=["Administração & Gestão de Módulos"])

@router.get("/users", response_model=List[UserOut])
async def list_users(current_user: dict = Depends(require_roles("admin"))):
    """Lista todos os colaboradores cadastrados no sistema com seus módulos permitidos."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT id, username, full_name, role, allowed_modules, is_active, last_login, created_at 
            FROM users 
            ORDER BY id ASC
            """
        )
        rows = await cursor.fetchall()
        users = []
        for r in rows:
            u = dict(r)
            if not u.get("allowed_modules"):
                u["allowed_modules"] = "all"
            users.append(u)
        return users

@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    payload: UserCreate,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Cria um novo usuário e define explicitamente quais módulos ele terá permissão de acesso."""
    username = payload.username.strip().lower()
    client_ip = request.client.host if request.client else "127.0.0.1"

    allowed_mods = payload.allowed_modules or "all"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT id FROM users WHERE username = ?", (username,))
        if await cursor.fetchone():
            raise HTTPException(status_code=400, detail=f"O nome de usuário '{username}' já está em uso.")

        pw_hash, salt = hash_password(payload.password)
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        cursor = await db.execute(
            """
            INSERT INTO users (username, password_hash, salt, full_name, role, allowed_modules, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (username, pw_hash, salt, payload.full_name.strip(), payload.role, allowed_mods, 1 if payload.is_active else 0, now_str)
        )
        await db.commit()
        new_id = cursor.lastrowid

        cursor = await db.execute("SELECT id, username, full_name, role, allowed_modules, is_active, last_login, created_at FROM users WHERE id = ?", (new_id,))
        created_user = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="USER_CREATE",
        target_type="user",
        target_id=new_id,
        details=f"Criou usuário '{username}' ({payload.full_name}) | Perfil: '{payload.role}' | Módulos: '{allowed_mods}'",
        ip_address=client_ip
    )

    return created_user

@router.put("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Atualiza dados, cargo, status e módulos permitidos de um usuário."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        target_user = await cursor.fetchone()
        if not target_user:
            raise HTTPException(status_code=404, detail="Usuário não encontrado.")

        target = dict(target_user)

        # Regras de proteção do próprio admin
        if target["id"] == current_user["id"]:
            if payload.is_active is False:
                raise HTTPException(status_code=400, detail="Você não pode desativar sua própria conta de administrador.")
            if payload.role and payload.role != "admin":
                raise HTTPException(status_code=400, detail="Você não pode alterar seu próprio cargo para fora de administrador.")

        updates = []
        params = []
        changes_desc = []

        if payload.full_name is not None:
            updates.append("full_name = ?")
            params.append(payload.full_name.strip())
            changes_desc.append(f"Nome: '{payload.full_name}'")

        if payload.role is not None:
            updates.append("role = ?")
            params.append(payload.role)
            changes_desc.append(f"Perfil: '{payload.role}'")

        if payload.allowed_modules is not None:
            updates.append("allowed_modules = ?")
            params.append(payload.allowed_modules)
            changes_desc.append(f"Módulos: '{payload.allowed_modules}'")

        if payload.is_active is not None:
            updates.append("is_active = ?")
            params.append(1 if payload.is_active else 0)
            status_text = "Ativado" if payload.is_active else "Desativado"
            changes_desc.append(f"Status: {status_text}")

        if payload.new_password:
            pwd_hash, salt = hash_password(payload.new_password)
            updates.append("password_hash = ?")
            params.append(pwd_hash)
            updates.append("salt = ?")
            params.append(salt)
            changes_desc.append("Senha redefinida")

        if updates:
            sql = f"UPDATE users SET {', '.join(updates)} WHERE id = ?"
            params.append(user_id)
            await db.execute(sql, params)
            await db.commit()

        cursor = await db.execute("SELECT id, username, full_name, role, allowed_modules, is_active, last_login, created_at FROM users WHERE id = ?", (user_id,))
        updated_user = dict(await cursor.fetchone())

    await record_audit_log(
        user=current_user,
        action="USER_UPDATE",
        target_type="user",
        target_id=user_id,
        details=f"Atualizou o usuário '{target['username']}': {', '.join(changes_desc)}",
        ip_address=client_ip
    )

    return updated_user

@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Exclui permanentemente um usuário e encerra suas sessões ativas."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="Você não pode excluir sua própria conta conectada.")

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT username, role FROM users WHERE id = ?", (user_id,))
        target = await cursor.fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Usuário não encontrado.")

        await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="USER_DELETE",
        target_type="user",
        target_id=user_id,
        details=f"Excluiu permanentemente o usuário '{target['username']}' (Perfil: {target['role']})",
        ip_address=client_ip
    )

    return {"message": f"Usuário '{target['username']}' excluído com sucesso."}

@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: int,
    payload: ResetPasswordRequest,
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Redefine a senha de um colaborador pelo administrador."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT username FROM users WHERE id = ?", (user_id,))
        target = await cursor.fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Usuário não encontrado.")

        new_hash, new_salt = hash_password(payload.new_password)
        await db.execute(
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
            (new_hash, new_salt, user_id)
        )
        await db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="PASSWORD_RESET_BY_ADMIN",
        target_type="user",
        target_id=user_id,
        details=f"Redefiniu a senha do usuário '{target['username']}'",
        ip_address=client_ip
    )

    return {"message": f"Senha do usuário '{target['username']}' redefinida com sucesso."}

# ==================== AUDITORIA ====================

@router.get("/audit-logs", response_model=List[AuditLogOut])
async def list_audit_logs(
    search: Optional[str] = Query(None, description="Busca textual por usuário, ação ou detalhe"),
    action: Optional[str] = Query(None, description="Filtrar por ação específica"),
    limit: int = Query(100, ge=10, le=500),
    current_user: dict = Depends(require_roles("admin"))
):
    """Consulta os registros unificados de auditoria do sistema."""
    query = "SELECT * FROM audit_logs WHERE 1=1"
    params = []

    if search:
        query += " AND (username LIKE ? OR action LIKE ? OR details LIKE ? OR ip_address LIKE ?)"
        term = f"%{search}%"
        params.extend([term, term, term, term])

    if action and action != "all":
        query += " AND action = ?"
        params.append(action)

    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    async with get_db_connection() as db:
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

@router.get("/audit-logs/export")
async def export_audit_logs_csv(current_user: dict = Depends(require_roles("admin"))):
    """Exporta todo o histórico unificado de auditoria para CSV."""
    async with get_db_connection() as db:
        cursor = await db.execute("SELECT id, created_at, username, action, target_type, target_id, details, ip_address FROM audit_logs ORDER BY id DESC")
        rows = await cursor.fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(["ID", "Data_Hora", "Usuario", "Acao", "Tipo_Alvo", "ID_Alvo", "Detalhes", "IP_Origem"])

    for r in rows:
        writer.writerow([
            r["id"], r["created_at"], r["username"], r["action"],
            r["target_type"] or "", r["target_id"] or "",
            r["details"] or "", r["ip_address"] or ""
        ])

    csv_data = "\ufeff" + output.getvalue()
    filename = f"auditoria_sentinel_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=csv_data.encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

# ==================== BACKUP UNIFICADO ====================

@router.get("/backup/download")
async def download_database_backup(
    request: Request,
    current_user: dict = Depends(require_roles("admin"))
):
    """Gera cópia online e consistente do banco SQLite unificado e faz o download."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_filename = f"sentinel_lucca_backup_{timestamp}.db"
    backup_path = BACKUP_DIR / backup_filename

    src = sqlite3.connect(str(DB_PATH))
    dest = sqlite3.connect(str(backup_path))
    src.backup(dest)
    dest.close()
    src.close()

    with open(backup_path, "rb") as f:
        data = f.read()

    await record_audit_log(
        user=current_user,
        action="DATABASE_BACKUP_DOWNLOAD",
        details=f"Gerou e baixou cópia de segurança do banco unificado: {backup_filename} ({len(data)} bytes)",
        ip_address=client_ip
    )

    return Response(
        content=data,
        media_type="application/x-sqlite3",
        headers={"Content-Disposition": f'attachment; filename="{backup_filename}"'}
    )
