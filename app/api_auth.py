from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, Response, Depends

from app.database import get_db_connection
from app.config import SESSION_COOKIE_NAME
from app.auth import (
    hash_password, verify_password, create_session, delete_session,
    get_current_user, record_audit_log
)
from app.models import (
    LoginRequest, LoginResponse, UserOut, ChangePasswordRequest
)

router = APIRouter(prefix="/api/auth", tags=["Autenticação"])

@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, response: Response):
    """Autentica o usuário no sistema centralizado e gera sessão segura."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with get_db_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM users WHERE username = ?",
            (payload.username.strip(),)
        )
        row = await cursor.fetchone()

        if not row:
            await record_audit_log(
                user=None,
                action="LOGIN_FAILED",
                details=f"Tentativa de login com usuário inexistente: '{payload.username}'",
                ip_address=client_ip
            )
            raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")

        user = dict(row)

        if not user["is_active"]:
            await record_audit_log(
                user=user,
                action="LOGIN_BLOCKED",
                details=f"Usuário desativado tentou efetuar login: '{user['username']}'",
                ip_address=client_ip
            )
            raise HTTPException(status_code=403, detail="Este usuário está desativado no sistema.")

        if not verify_password(payload.password, user["password_hash"], user["salt"]):
            await record_audit_log(
                user=user,
                action="LOGIN_FAILED",
                details="Senha incorreta fornecida",
                ip_address=client_ip
            )
            raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")

        # Criar sessão de 7 dias
        token = await create_session(user["id"])

        # Atualizar último login
        await db.execute(
            "UPDATE users SET last_login = ? WHERE id = ?",
            (now_str, user["id"])
        )
        await db.commit()

    # Registrar auditoria
    await record_audit_log(
        user=user,
        action="LOGIN_SUCCESS",
        details="Login efetuado com sucesso no Sentinel Lucca",
        ip_address=client_ip
    )

    # Definir cookies de sessão para compatibilidade total entre os módulos
    cookie_kwargs = {"httponly": True, "samesite": "lax", "max_age": 7 * 24 * 3600}
    response.set_cookie(key=SESSION_COOKIE_NAME, value=token, **cookie_kwargs)
    response.set_cookie(key="cftv_token", value=token, **cookie_kwargs)
    response.set_cookie(key="print_sentinel_session", value=token, **cookie_kwargs)

    user_out = UserOut(
        id=user["id"],
        username=user["username"],
        full_name=user["full_name"],
        role=user["role"],
        allowed_modules=user.get("allowed_modules", "all"),
        is_active=bool(user["is_active"]),
        last_login=now_str,
        created_at=user.get("created_at")
    )

    return LoginResponse(token=token, access_token=token, user=user_out)

@router.post("/logout")
async def logout(request: Request, response: Response, current_user: dict = Depends(get_current_user)):
    """Encerra a sessão ativa do usuário e remove cookies."""
    token = None
    auth_hdr = request.headers.get("Authorization")
    if auth_hdr and auth_hdr.startswith("Bearer "):
        token = auth_hdr.split(" ")[1].strip()
    elif SESSION_COOKIE_NAME in request.cookies:
        token = request.cookies.get(SESSION_COOKIE_NAME)
    elif "cftv_token" in request.cookies:
        token = request.cookies.get("cftv_token")

    if token:
        await delete_session(token)

    response.delete_cookie(SESSION_COOKIE_NAME)
    response.delete_cookie("cftv_token")
    response.delete_cookie("print_sentinel_session")

    client_ip = request.client.host if request.client else "127.0.0.1"
    await record_audit_log(
        user=current_user,
        action="LOGOUT",
        details="Usuário encerrou a sessão no sistema",
        ip_address=client_ip
    )

    return {"message": "Logout realizado com sucesso."}

@router.get("/me", response_model=UserOut)
async def get_me(current_user: dict = Depends(get_current_user)):
    """Retorna os dados cadastrais e permissões de módulo do usuário autenticado."""
    return UserOut(
        id=current_user["id"],
        username=current_user["username"],
        full_name=current_user["full_name"],
        role=current_user["role"],
        allowed_modules=current_user.get("allowed_modules", "all"),
        is_active=bool(current_user["is_active"]),
        last_login=current_user.get("last_login"),
        created_at=current_user.get("created_at")
    )

@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    """Permite que o próprio usuário autenticado altere a sua senha."""
    client_ip = request.client.host if request.client else "127.0.0.1"

    async with get_db_connection() as db:
        cursor = await db.execute("SELECT password_hash, salt FROM users WHERE id = ?", (current_user["id"],))
        user_row = await cursor.fetchone()

        if not verify_password(payload.current_password, user_row["password_hash"], user_row["salt"]):
            raise HTTPException(status_code=400, detail="Senha atual incorreta.")

        new_hash, new_salt = hash_password(payload.new_password)
        await db.execute(
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
            (new_hash, new_salt, current_user["id"])
        )
        await db.commit()

    await record_audit_log(
        user=current_user,
        action="PASSWORD_CHANGE",
        details="Usuário alterou sua própria senha de acesso",
        ip_address=client_ip
    )

    return {"message": "Senha alterada com sucesso!"}
