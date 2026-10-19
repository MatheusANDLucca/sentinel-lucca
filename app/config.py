import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env", override=True)

DATA_DIR = BASE_DIR / "data"
BACKUP_DIR = DATA_DIR / "backups"
STATIC_DIR = BASE_DIR / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Banco de dados SQLite unificado
DB_PATH = DATA_DIR / "sentinel.db"

# Caminhos dos bancos de dados legados para auto-migração inteligente
LEGACY_CFTV_DB = Path(r"c:\Users\TI-4817\Documents\Project IA\data\monitoring.db")
LEGACY_PRINT_DB = Path(r"c:\Users\TI-4817\Documents\Project IA 2\data\printers.db")

# Servidor Web
SERVER_HOST = os.getenv("SERVER_HOST", "0.0.0.0")
SERVER_PORT = int(os.getenv("SERVER_PORT", "8000"))

# Sessão e Cookies
SESSION_COOKIE_NAME = "sentinel_session_token"
SECRET_KEY = os.getenv("SECRET_KEY", "sentinel_lucca_enterprise_master_key_2026")

# Parâmetros de Monitoramento CFTV
DEFAULT_CFTV_INTERVAL = int(os.getenv("DEFAULT_CFTV_INTERVAL", "10"))
DEFAULT_TIMEOUT = float(os.getenv("DEFAULT_TIMEOUT", "2.0"))

# Parâmetros de Monitoramento Impressoras
DEFAULT_PRINTER_INTERVAL = int(os.getenv("DEFAULT_PRINTER_INTERVAL", "15"))
PING_TIMEOUT_SECONDS = float(os.getenv("PING_TIMEOUT_SECONDS", "1.5"))
TCP_TIMEOUT_SECONDS = float(os.getenv("TCP_TIMEOUT_SECONDS", "2.0"))
DEFAULT_PRINTER_PORT = 9100

# ========================================================
# Configurações de E-mail (SMTP) e Solicitações RMA
# ========================================================
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.office365.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes")
SMTP_SENDER_NAME = os.getenv("SMTP_SENDER_NAME", "Sentinel TI - CAPUL")
SMTP_SENDER_EMAIL = os.getenv("SMTP_SENDER_EMAIL", "")

# Destinatários padrão para solicitações de conserto (podem ser alterados via UI ou .env)
RMA_DEFAULT_EMAIL_TO = os.getenv("RMA_DEFAULT_EMAIL_TO", "matheuslucca@capul.com.br")
RMA_DEFAULT_EMAIL_CC = os.getenv("RMA_DEFAULT_EMAIL_CC", "lucas.ti@capul.com.br")

