import aiosqlite
import sqlite3
import logging
import secrets
import hashlib
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path

from app.config import DB_PATH, LEGACY_CFTV_DB, LEGACY_PRINT_DB

logger = logging.getLogger("sentinel.database")

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operador',
    allowed_modules TEXT NOT NULL DEFAULT 'all',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recorders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER DEFAULT 37777,
    brand TEXT DEFAULT 'Intelbras',
    location TEXT DEFAULT '',
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    status TEXT DEFAULT 'unknown',
    latency_ms REAL DEFAULT 0.0,
    last_checked TEXT,
    last_status_change TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    snapshot_channel INTEGER DEFAULT 1,
    snapshot_user TEXT DEFAULT '',
    snapshot_password TEXT DEFAULT '',
    storage_status TEXT DEFAULT 'ok',
    storage_info TEXT DEFAULT 'HD 1: Normal',
    last_storage_check TEXT
);

CREATE TABLE IF NOT EXISTS incident_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorder_id INTEGER,
    recorder_name TEXT NOT NULL,
    recorder_ip TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    latency_ms REAL DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(recorder_id) REFERENCES recorders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'Matriz',
    department TEXT,
    brand TEXT NOT NULL DEFAULT 'HP',
    model TEXT,
    printer_type TEXT DEFAULT 'laser_mono',
    ip TEXT NOT NULL,
    dns TEXT,
    gateway TEXT,
    subnet_mask TEXT DEFAULT '255.255.255.0',
    mac_address TEXT,
    port INTEGER DEFAULT 9100,
    web_port INTEGER DEFAULT 80,
    serial_number TEXT,
    pin TEXT,
    toner_model TEXT,
    ownership TEXT DEFAULT 'propria',
    vendor_contact TEXT,
    status TEXT DEFAULT 'offline',
    latency_ms REAL DEFAULT 0.0,
    tcp_status INTEGER DEFAULT 0,
    last_seen TEXT,
    last_test_print TEXT,
    last_test_result TEXT,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_print_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL,
    printer_name TEXT NOT NULL,
    printer_ip TEXT NOT NULL,
    branch TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    test_type TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    bytes_sent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
"""

@asynccontextmanager
async def get_db_connection():
    """Gerenciador de contexto assíncrono para conexões SQLite com suporte a dicionários."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON;")
        yield db

def hash_password_init(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        bytes.fromhex(salt),
        100000
    )
    return hashed.hex(), salt

async def auto_migrate_legacy_data(db: aiosqlite.Connection):
    """
    Importa automaticamente os dados dos projetos legados (Project IA e Project IA 2)
    caso o banco unificado seja novo ou não tenha registros ainda.
    """
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 1. Migração a partir do CFTV Sentinel (monitoring.db)
    if LEGACY_CFTV_DB.exists():
        try:
            cursor = await db.execute("SELECT COUNT(*) FROM recorders")
            cftv_count = (await cursor.fetchone())[0]

            if cftv_count == 0:
                logger.info("Importando dados legados do CFTV Sentinel de %s...", LEGACY_CFTV_DB)
                with sqlite3.connect(str(LEGACY_CFTV_DB)) as leg_cftv:
                    leg_cftv.row_factory = sqlite3.Row
                    cur = leg_cftv.cursor()

                    # Copiar Usuários
                    try:
                        c_users = cur.execute("SELECT * FROM users").fetchall()
                        for u in c_users:
                            u_dict = dict(u)
                            await db.execute(
                                """
                                INSERT OR IGNORE INTO users (id, username, password_hash, salt, full_name, role, allowed_modules, is_active, created_at, last_login)
                                VALUES (?, ?, ?, ?, ?, ?, 'all', ?, ?, ?)
                                """,
                                (
                                    u_dict.get("id"),
                                    u_dict.get("username"),
                                    u_dict.get("password_hash"),
                                    u_dict.get("salt"),
                                    u_dict.get("full_name"),
                                    u_dict.get("role", "operador"),
                                    u_dict.get("is_active", 1),
                                    u_dict.get("created_at") or now_str,
                                    u_dict.get("last_login")
                                )
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar usuários do CFTV: %s", e)

                    # Copiar Gravadores
                    try:
                        recs = cur.execute("SELECT * FROM recorders").fetchall()
                        for r in recs:
                            r_dict = dict(r)
                            cols = list(r_dict.keys())
                            placeholders = ", ".join(["?"] * len(cols))
                            col_names = ", ".join(cols)
                            await db.execute(
                                f"INSERT OR IGNORE INTO recorders ({col_names}) VALUES ({placeholders})",
                                list(r_dict.values())
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar gravadores: %s", e)

                    # Copiar Incident Logs
                    try:
                        incidents = cur.execute("SELECT * FROM incident_logs").fetchall()
                        for inc in incidents:
                            inc_dict = dict(inc)
                            cols = list(inc_dict.keys())
                            placeholders = ", ".join(["?"] * len(cols))
                            col_names = ", ".join(cols)
                            await db.execute(
                                f"INSERT OR IGNORE INTO incident_logs ({col_names}) VALUES ({placeholders})",
                                list(inc_dict.values())
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar incidentes: %s", e)

                    # Copiar Settings
                    try:
                        sets = cur.execute("SELECT * FROM settings").fetchall()
                        for s in sets:
                            s_dict = dict(s)
                            await db.execute(
                                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                                (s_dict.get("key"), s_dict.get("value"))
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar configurações: %s", e)

                    # Copiar Logs de Auditoria
                    try:
                        audits = cur.execute("SELECT * FROM audit_logs").fetchall()
                        for a in audits:
                            a_dict = dict(a)
                            cols = list(a_dict.keys())
                            placeholders = ", ".join(["?"] * len(cols))
                            col_names = ", ".join(cols)
                            await db.execute(
                                f"INSERT OR IGNORE INTO audit_logs ({col_names}) VALUES ({placeholders})",
                                list(a_dict.values())
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar auditoria CFTV: %s", e)

                    await db.commit()
                    logger.info("Migração do CFTV Sentinel concluída com sucesso.")
        except Exception as e:
            logger.error("Erro ao migrar dados de CFTV: %s", e)

    # 2. Migração a partir do Print Sentinel (printers.db)
    if LEGACY_PRINT_DB.exists():
        try:
            cursor = await db.execute("SELECT COUNT(*) FROM printers")
            printers_count = (await cursor.fetchone())[0]

            if printers_count == 0:
                logger.info("Importando dados legados do Print Sentinel de %s...", LEGACY_PRINT_DB)
                with sqlite3.connect(str(LEGACY_PRINT_DB)) as leg_print:
                    leg_print.row_factory = sqlite3.Row
                    cur = leg_print.cursor()

                    # Copiar Usuários que eventualmente não existam no CFTV
                    try:
                        p_users = cur.execute("SELECT * FROM users").fetchall()
                        for u in p_users:
                            u_dict = dict(u)
                            # Se não existir pelo username, insere
                            await db.execute(
                                """
                                INSERT OR IGNORE INTO users (username, password_hash, salt, full_name, role, allowed_modules, is_active, created_at, last_login)
                                VALUES (?, ?, ?, ?, ?, 'all', ?, ?, ?)
                                """,
                                (
                                    u_dict.get("username"),
                                    u_dict.get("password_hash"),
                                    u_dict.get("salt"),
                                    u_dict.get("full_name"),
                                    u_dict.get("role", "operador"),
                                    u_dict.get("is_active", 1),
                                    u_dict.get("created_at") or now_str,
                                    u_dict.get("last_login")
                                )
                            )
                    except Exception as e:
                        logger.warning("Aviso ao mesclar usuários de impressoras: %s", e)

                    # Copiar Impressoras
                    try:
                        prns = cur.execute("SELECT * FROM printers").fetchall()
                        for p in prns:
                            p_dict = dict(p)
                            cols = list(p_dict.keys())
                            placeholders = ", ".join(["?"] * len(cols))
                            col_names = ", ".join(cols)
                            await db.execute(
                                f"INSERT OR IGNORE INTO printers ({col_names}) VALUES ({placeholders})",
                                list(p_dict.values())
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar impressoras: %s", e)

                    # Copiar Test Print Logs
                    try:
                        tlogs = cur.execute("SELECT * FROM test_print_logs").fetchall()
                        for t in tlogs:
                            t_dict = dict(t)
                            cols = list(t_dict.keys())
                            placeholders = ", ".join(["?"] * len(cols))
                            col_names = ", ".join(cols)
                            await db.execute(
                                f"INSERT OR IGNORE INTO test_print_logs ({col_names}) VALUES ({placeholders})",
                                list(t_dict.values())
                            )
                    except Exception as e:
                        logger.warning("Aviso ao copiar logs de teste de impressão: %s", e)

                    await db.commit()
                    logger.info("Migração do Print Sentinel concluída com sucesso.")
        except Exception as e:
            logger.error("Erro ao migrar dados de Impressoras: %s", e)

async def init_db():
    """Inicializa as tabelas do banco SQLite unificado e executa migração automática."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.executescript(CREATE_TABLES_SQL)

        # Garantir coluna allowed_modules na tabela users
        cursor = await db.execute("PRAGMA table_info(users)")
        user_cols = [row[1] for row in await cursor.fetchall()]
        if "allowed_modules" not in user_cols:
            try:
                await db.execute("ALTER TABLE users ADD COLUMN allowed_modules TEXT NOT NULL DEFAULT 'all'")
                logger.info("Coluna 'allowed_modules' adicionada à tabela users.")
            except Exception as e:
                logger.warning("Falha ao adicionar coluna allowed_modules: %s", e)

        # Executar auto-migração caso seja banco novo
        await auto_migrate_legacy_data(db)

        # Configurações padrão essenciais
        default_settings = {
            "check_interval": "10",
            "sound_alert_enabled": "true",
            "telegram_enabled": "false",
            "telegram_bot_token": "",
            "telegram_chat_id": "",
            "telegram_notify_offline": "true",
            "telegram_notify_online": "true",
            "telegram_notify_hd": "true"
        }
        for k, v in default_settings.items():
            await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))

        # Garantir usuário admin padrão se não houver nenhum
        cursor = await db.execute("SELECT COUNT(*) FROM users")
        row = await cursor.fetchone()
        if row and row[0] == 0:
            pw_hash, salt = hash_password_init("admin123")
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            await db.execute(
                """
                INSERT INTO users (username, password_hash, salt, full_name, role, allowed_modules, is_active, created_at)
                VALUES ('admin', ?, ?, 'Administrador do Sistema', 'admin', 'all', 1, ?)
                """,
                (pw_hash, salt, now_str)
            )
            logger.info("Usuário inicial 'admin' criado com sucesso com acesso a 'all' módulos.")

        # Garantir que o usuário 'admin' tenha allowed_modules = 'all'
        await db.execute("UPDATE users SET allowed_modules = 'all' WHERE role = 'admin' AND allowed_modules != 'all'")

        await db.commit()
    logger.info("Banco de dados SQLite unificado inicializado com sucesso em %s", DB_PATH)
