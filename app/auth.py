import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict, Any

from fastapi import Request, HTTPException, Security, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.database import get_db_connection
from app.config import SESSION_COOKIE_NAME

security_bearer = HTTPBearer(auto_error=False)

def hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
    """Gera um hash PBKDF2-HMAC-SHA256 seguro com salt hexadecimal."""
    if not salt:
        salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        bytes.fromhex(salt),
        100000
    )
    return hashed.hex(), salt

def verify_password(password: str, stored_hash: str, stored_salt: str) -> bool:
    """Valida a senha informada contra o hash e salt persistidos."""
    try:
        new_hash, _ = hash_password(password, stored_salt)
        return secrets.compare_digest(new_hash, stored_hash)
    except Exception:
        return False

async def create_session(user_id: int, days_valid: int = 7) -> str:
    """Cria e persiste um token de sessão seguro no SQLite."""
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now() + timedelta(days=days_valid)).strftime("%Y-%m-%d %H:%M:%S")
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        await db.execute(
            "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (token, user_id, expires_at, now_str)
        )
        await db.commit()
    return token

async def delete_session(token: str):
    """Remove a sessão do banco ao deslogar."""
    async with get_db_connection() as db:
        await db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        await db.commit()

async def get_current_user(
    request: Request,
    auth_header: Optional[HTTPAuthorizationCredentials] = Security(security_bearer)
) -> Dict[str, Any]:
    """Obtém o usuário autenticado via Bearer Token no cabeçalho ou Cookies de sessão."""
    token = None
    if auth_header:
        token = auth_header.credentials
    elif SESSION_COOKIE_NAME in request.cookies:
        token = request.cookies.get(SESSION_COOKIE_NAME)
    elif "cftv_token" in request.cookies:
        token = request.cookies.get("cftv_token")
    elif "print_sentinel_session" in request.cookies:
        token = request.cookies.get("print_sentinel_session")

    if not token:
        raise HTTPException(
            status_code=401,
            detail="Acesso não autorizado. Faça login para continuar."
        )

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT u.id, u.username, u.full_name, u.role, u.allowed_modules, u.is_active, s.expires_at, u.created_at, u.last_login
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
            """,
            (token, now_str)
        )
        row = await cursor.fetchone()

        if not row:
            await db.execute("DELETE FROM sessions WHERE token = ? OR expires_at <= ?", (token, now_str))
            await db.commit()
            raise HTTPException(
                status_code=401,
                detail="Sessão inválida ou expirada. Faça login novamente."
            )

        user = dict(row)
        if not user["is_active"]:
            raise HTTPException(
                status_code=403,
                detail="Este usuário está desativado no sistema. Contate o administrador."
            )

        if not user.get("allowed_modules"):
            user["allowed_modules"] = "all"

        return user

def require_roles(*allowed_roles: str):
    """Fábrica de dependência para controle de acesso baseado em papéis (RBAC)."""
    async def role_checker(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if current_user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail="Você não tem permissão de perfil para realizar esta operação."
            )
        return current_user
    return role_checker

def require_module_access(module_name: str):
    """
    Fábrica de dependência para controle de acesso granular por módulo.
    - Se o usuário for admin, tem acesso irrestrito.
    - Se allowed_modules for 'all', tem acesso.
    - Se o module_name estiver em allowed_modules, tem acesso.
    """
    async def module_checker(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if current_user["role"] == "admin":
            return current_user

        allowed = current_user.get("allowed_modules", "all")
        if allowed == "all":
            return current_user

        user_modules = [m.strip().lower() for m in allowed.split(",")]
        if module_name.lower() not in user_modules:
            raise HTTPException(
                status_code=403,
                detail=f"Acesso negado ao módulo '{module_name}'. Seu usuário não tem permissão para este recurso."
            )
        return current_user
    return module_checker

async def record_audit_log(
    user: Dict[str, Any] | None,
    action: str,
    details: str = "",
    target_type: str = "",
    target_id: Optional[int] = None,
    ip_address: str = ""
):
    """Registra uma ação no histórico unificado de auditoria do sistema."""
    user_id = user["id"] if user else None
    username = user["username"] if user else "sistema"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        await db.execute(
            """
            INSERT INTO audit_logs (user_id, username, action, target_type, target_id, details, ip_address, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, username, action, target_type, target_id, details, ip_address, now_str)
        )
        await db.commit()
