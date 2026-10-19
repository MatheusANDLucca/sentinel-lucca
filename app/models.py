from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

# ==================== USUÁRIOS E AUTENTICAÇÃO ====================

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1)

class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    allowed_modules: str = "all"  # 'all', 'cftv', 'printers'
    is_active: bool
    last_login: Optional[str] = None
    created_at: Optional[str] = None

class LoginResponse(BaseModel):
    token: str
    access_token: Optional[str] = None
    user: UserOut

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=4)
    full_name: str = Field(..., min_length=2, max_length=100)
    role: str = Field(default="operador", pattern="^(admin|operador|visualizador)$")
    allowed_modules: str = Field(default="all", pattern="^(all|cftv|printers|rma|[a-zA-Z0-9_, -]+)$", description="Módulos permitidos: all (Todos), cftv, printers, rma")
    is_active: bool = True

class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(None, min_length=2, max_length=100)
    role: Optional[str] = Field(None, pattern="^(admin|operador|visualizador)$")
    allowed_modules: Optional[str] = Field(None, pattern="^(all|cftv|printers|rma|[a-zA-Z0-9_, -]+)$")
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(None, min_length=4)

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=4)

class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=4)

# ==================== CFTV SENTINEL (GRAVADORES) ====================

class RecorderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    ip: str = Field(..., min_length=1, max_length=255)
    port: Optional[int] = Field(default=37777, ge=1, le=65535)
    brand: Optional[str] = Field(default="Intelbras", max_length=50)
    location: Optional[str] = Field(default="", max_length=100)
    description: Optional[str] = Field(default="", max_length=255)
    is_active: bool = Field(default=True)
    snapshot_channel: Optional[int] = Field(default=1, ge=1, le=128)
    snapshot_user: Optional[str] = Field(default="", max_length=50)
    snapshot_password: Optional[str] = Field(default="", max_length=100)
    storage_status: Optional[str] = Field(default="ok")
    storage_info: Optional[str] = Field(default="HD 1: Normal", max_length=100)

class RecorderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    ip: Optional[str] = Field(None, min_length=1, max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    brand: Optional[str] = Field(None, max_length=50)
    location: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    is_active: Optional[bool] = None
    snapshot_channel: Optional[int] = Field(None, ge=1, le=128)
    snapshot_user: Optional[str] = Field(None, max_length=50)
    snapshot_password: Optional[str] = Field(None, max_length=100)
    storage_status: Optional[str] = None
    storage_info: Optional[str] = None

class RecorderOut(BaseModel):
    id: int
    name: str
    ip: str
    port: Optional[int] = 37777
    brand: Optional[str] = "Intelbras"
    location: Optional[str] = ""
    description: Optional[str] = ""
    is_active: bool = True
    status: str = "unknown"
    latency_ms: float = 0.0
    last_checked: Optional[str] = None
    last_status_change: Optional[str] = None
    created_at: Optional[str] = None
    snapshot_channel: Optional[int] = 1
    snapshot_user: Optional[str] = ""
    snapshot_password: Optional[str] = ""
    storage_status: Optional[str] = "ok"
    storage_info: Optional[str] = "HD 1: Normal"
    last_storage_check: Optional[str] = None

class IncidentLogOut(BaseModel):
    id: int
    recorder_id: Optional[int] = None
    recorder_name: str
    recorder_ip: str
    event_type: str
    message: Optional[str] = None
    latency_ms: float = 0.0
    created_at: str

class SettingsOut(BaseModel):
    check_interval: int
    sound_alert_enabled: bool
    telegram_enabled: Optional[bool] = False
    telegram_bot_token: Optional[str] = ""
    telegram_chat_id: Optional[str] = ""
    telegram_notify_offline: Optional[bool] = True
    telegram_notify_online: Optional[bool] = True
    telegram_notify_hd: Optional[bool] = True

# ==================== PRINT SENTINEL (IMPRESSORAS) ====================

class PrinterBase(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    branch: str = Field(default="Matriz", max_length=80)
    department: Optional[str] = Field(default="", max_length=80)
    brand: str = Field(default="HP", max_length=50)
    model: Optional[str] = Field(default="", max_length=80)
    printer_type: str = Field(default="laser_mono")
    ip: str = Field(..., min_length=7, max_length=45)
    dns: Optional[str] = Field(default="", max_length=80)
    gateway: Optional[str] = Field(default="", max_length=45)
    subnet_mask: Optional[str] = Field(default="255.255.255.0", max_length=45)
    mac_address: Optional[str] = Field(default="", max_length=30)
    port: int = Field(default=9100, ge=1, le=65535)
    web_port: int = Field(default=80, ge=1, le=65535)
    serial_number: Optional[str] = Field(default="", max_length=60)
    pin: Optional[str] = Field(default="", max_length=50)
    toner_model: Optional[str] = Field(default="", max_length=80)
    ownership: str = Field(default="propria")
    vendor_contact: Optional[str] = Field(default="", max_length=150)
    notes: Optional[str] = Field(default="", max_length=500)
    is_active: int = Field(default=1)

class PrinterCreate(PrinterBase):
    pass

class PrinterUpdate(BaseModel):
    name: Optional[str] = None
    branch: Optional[str] = None
    department: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    printer_type: Optional[str] = None
    ip: Optional[str] = None
    dns: Optional[str] = None
    gateway: Optional[str] = None
    subnet_mask: Optional[str] = None
    mac_address: Optional[str] = None
    port: Optional[int] = None
    web_port: Optional[int] = None
    serial_number: Optional[str] = None
    pin: Optional[str] = None
    toner_model: Optional[str] = None
    ownership: Optional[str] = None
    vendor_contact: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[int] = None

class PrinterOut(PrinterBase):
    id: int
    status: str
    latency_ms: float
    tcp_status: int
    last_seen: Optional[str] = None
    last_test_print: Optional[str] = None
    last_test_result: Optional[str] = None
    created_at: str
    updated_at: str

class TestPrintRequest(BaseModel):
    test_type: str = Field(default="standard_network")
    custom_message: Optional[str] = Field(default="", max_length=200)

class TestPrintResult(BaseModel):
    success: bool
    printer_id: int
    printer_name: str
    ip: str
    port: int
    bytes_sent: int
    message: str
    timestamp: str

class DashboardMetrics(BaseModel):
    total_printers: int
    online_printers: int
    offline_printers: int
    warning_printers: int
    branches_count: int
    average_latency_ms: float
    sla_percentage: float
    branches: List[dict]

# ==================== AUDITORIA ====================

class AuditLogOut(BaseModel):
    id: int
    user_id: Optional[int] = None
    username: str
    action: str
    target_type: Optional[str] = None
    target_id: Optional[int] = None
    details: Optional[str] = None
    ip_address: Optional[str] = None
    created_at: str

# ==================== PORTAL CENTRAL ====================

class PortalSummaryOut(BaseModel):
    user: UserOut
    cftv: Dict[str, Any]
    printers: Dict[str, Any]
    rma: Optional[Dict[str, Any]] = None

# ==================== RMA & CONTROLE PATRIMONIAL ====================

class RmaProviderBase(BaseModel):
    name: str = Field(..., min_length=2, max_length=150)
    trade_name: Optional[str] = Field(default="", max_length=150)
    cnpj: Optional[str] = Field(default="", max_length=30)
    state_registration: Optional[str] = Field(default="", max_length=30)
    contact_name: Optional[str] = Field(default="", max_length=100)
    phone: Optional[str] = Field(default="", max_length=40)
    email: Optional[str] = Field(default="", max_length=100)
    address: Optional[str] = Field(default="", max_length=200)
    district: Optional[str] = Field(default="", max_length=100)
    city: Optional[str] = Field(default="", max_length=100)
    state: Optional[str] = Field(default="", max_length=10)
    cep: Optional[str] = Field(default="", max_length=20)
    notes: Optional[str] = Field(default="", max_length=500)
    is_active: bool = True

class RmaProviderCreate(RmaProviderBase):
    pass

class RmaProviderUpdate(BaseModel):
    name: Optional[str] = None
    trade_name: Optional[str] = None
    cnpj: Optional[str] = None
    state_registration: Optional[str] = None
    contact_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    district: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    cep: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class RmaProviderOut(RmaProviderBase):
    id: int
    created_at: str
    updated_at: str

class RmaCarrierBase(BaseModel):
    name: str = Field(..., min_length=2, max_length=150)
    trade_name: Optional[str] = Field(default="", max_length=150)
    cnpj: Optional[str] = Field(default="", max_length=30)
    state_registration: Optional[str] = Field(default="", max_length=30)
    phone: Optional[str] = Field(default="", max_length=40)
    contact_name: Optional[str] = Field(default="", max_length=100)
    notes: Optional[str] = Field(default="", max_length=500)
    is_active: bool = True

class RmaCarrierCreate(RmaCarrierBase):
    pass

class RmaCarrierUpdate(BaseModel):
    name: Optional[str] = None
    trade_name: Optional[str] = None
    cnpj: Optional[str] = None
    state_registration: Optional[str] = None
    phone: Optional[str] = None
    contact_name: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class RmaCarrierOut(RmaCarrierBase):
    id: int
    created_at: str
    updated_at: str

class RmaItemBase(BaseModel):
    patrimony_number: str = Field(..., min_length=1, max_length=50)
    serial_number: Optional[str] = Field(default="", max_length=80)
    item_code: Optional[str] = Field(default="", max_length=50)
    description: str = Field(..., min_length=2, max_length=200)
    brand: Optional[str] = Field(default="", max_length=80)
    model: Optional[str] = Field(default="", max_length=80)
    item_type: Optional[str] = Field(default="Outro", max_length=80)
    origin_branch: str = Field(default="Matriz", max_length=100)
    origin_department: Optional[str] = Field(default="", max_length=100)
    ec: Optional[str] = Field(default="Bom", max_length=50)
    estimated_value: Optional[float] = Field(default=0.0, ge=0)
    defect_reported: Optional[str] = Field(default="", max_length=500)
    status: Optional[str] = Field(default="na_ti")
    notes: Optional[str] = Field(default="", max_length=500)
    is_active: bool = True

class RmaItemCreate(RmaItemBase):
    pass

class RmaItemUpdate(BaseModel):
    patrimony_number: Optional[str] = None
    serial_number: Optional[str] = None
    item_code: Optional[str] = None
    description: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    item_type: Optional[str] = None
    origin_branch: Optional[str] = None
    origin_department: Optional[str] = None
    ec: Optional[str] = None
    estimated_value: Optional[float] = None
    defect_reported: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class RmaItemOut(RmaItemBase):
    id: int
    current_request_id: Optional[int] = None
    repair_count: int = 0
    last_sent_date: Optional[str] = None
    last_return_date: Optional[str] = None
    created_at: str
    updated_at: str

class RmaItemHistoryEntry(BaseModel):
    request_id: int
    request_number: str
    request_status: str
    request_created_at: str
    subject_type: str
    invoice_out: Optional[str] = ""
    invoice_out_date: Optional[str] = None
    invoice_in: Optional[str] = ""
    invoice_in_date: Optional[str] = None
    repair_cost: Optional[float] = 0.0
    provider_name: Optional[str] = ""
    provider_trade_name: Optional[str] = ""
    provider_phone: Optional[str] = ""
    carrier_name: Optional[str] = ""
    defect_notes: Optional[str] = ""
    justification_notes: Optional[str] = ""
    item_linked_at: str

class RmaItemHistoryOut(BaseModel):
    item: RmaItemOut
    total_repairs: int
    history: List[RmaItemHistoryEntry]

class RmaRequestCreate(BaseModel):
    sender_name: str = Field(default="CLENIO MARCOS", max_length=100)
    sender_department: str = Field(default="CPD", max_length=80)
    provider_id: int
    recipient_department: str = Field(default="MANUTENÇÃO", max_length=80)
    subject_type: str = Field(default="conserto", pattern="^(conserto|transferencia|emprestimo|baixa)$")
    carrier_id: Optional[int] = None
    justification_notes: Optional[str] = Field(default="", max_length=1000)
    item_ids: List[int] = Field(..., min_length=1)

class RmaRequestUpdate(BaseModel):
    sender_name: Optional[str] = None
    sender_department: Optional[str] = None
    provider_id: Optional[int] = None
    recipient_department: Optional[str] = None
    subject_type: Optional[str] = None
    carrier_id: Optional[int] = None
    justification_notes: Optional[str] = None
    status: Optional[str] = None
    invoice_out: Optional[str] = None
    invoice_out_date: Optional[str] = None
    invoice_in: Optional[str] = None
    invoice_in_date: Optional[str] = None
    repair_cost: Optional[float] = None
    item_ids: Optional[List[int]] = None

class RmaRequestItemOut(BaseModel):
    id: int
    request_id: int
    item_id: int
    patrimony_number: str
    description: str
    serial_number: Optional[str] = ""
    item_code: Optional[str] = ""
    origin_branch: Optional[str] = ""
    ec: Optional[str] = ""
    value: float = 0.0
    defect_notes: Optional[str] = ""
    created_at: str

class RmaRequestOut(BaseModel):
    id: int
    request_number: str
    sender_name: str
    sender_department: str
    provider_id: int
    provider_name: Optional[str] = None
    provider_trade_name: Optional[str] = None
    provider_cnpj: Optional[str] = None
    provider_ie: Optional[str] = None
    provider_address: Optional[str] = None
    provider_phone: Optional[str] = None
    recipient_department: str
    subject_type: str
    carrier_id: Optional[int] = None
    carrier_name: Optional[str] = None
    carrier_cnpj: Optional[str] = None
    carrier_ie: Optional[str] = None
    justification_notes: Optional[str] = ""
    status: str
    invoice_out: Optional[str] = ""
    invoice_out_date: Optional[str] = None
    invoice_in: Optional[str] = ""
    invoice_in_date: Optional[str] = None
    repair_cost: float = 0.0
    items: List[RmaRequestItemOut] = []
    total_value: float = 0.0
    created_by: Optional[int] = None
    created_at: str
    updated_at: str

class RmaDashboardMetrics(BaseModel):
    total_items: int
    items_na_ti: int
    items_em_conserto: int
    items_retornados: int
    total_requests: int
    requests_aguardando_nf: int
    requests_em_conserto: int
    requests_finalizados: int

class RmaSendEmailPayload(BaseModel):
    to_emails: Optional[str] = None
    cc_emails: Optional[str] = None
    custom_message: Optional[str] = None

class RmaEmailConfigOut(BaseModel):
    default_to: str
    default_cc: str
    smtp_server: str
    smtp_port: int
    smtp_user: str
    is_smtp_configured: bool


