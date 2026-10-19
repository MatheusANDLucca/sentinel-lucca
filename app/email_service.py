import smtplib
import asyncio
import logging
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from typing import List, Optional

from app.config import (
    SMTP_SERVER,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASSWORD,
    SMTP_USE_TLS,
    SMTP_SENDER_NAME,
    SMTP_SENDER_EMAIL,
    RMA_DEFAULT_EMAIL_TO,
    RMA_DEFAULT_EMAIL_CC
)
from app.pdf_generator import generate_rma_pdf

logger = logging.getLogger("sentinel.email")

def parse_email_list(raw: str) -> List[str]:
    """Separa strings de e-mails separadas por vírgula, ponto-e-vírgula ou espaço."""
    if not raw:
        return []
    items = re.split(r'[,;\s]+', str(raw).strip())
    return [e.strip() for e in items if e.strip() and "@" in e]

def _send_sync_email(msg: MIMEMultipart, recipients: List[str]):
    """Dispara o e-mail via SMTP de forma síncrona."""
    if not SMTP_SERVER:
        raise ValueError("Servidor SMTP não configurado no arquivo .env (SMTP_SERVER).")
    if not SMTP_USER or not SMTP_PASSWORD:
        raise ValueError("Credenciais de e-mail incompletas. Preencha SMTP_USER e SMTP_PASSWORD no arquivo .env.")

    if SMTP_PORT == 465:
        # Conexão direta com SSL
        server = smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, timeout=20)
    else:
        # Conexão padrão com STARTTLS
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=20)
        server.ehlo()
        if SMTP_USE_TLS:
            server.starttls()
            server.ehlo()

    try:
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg, to_addrs=recipients)
    finally:
        try:
            server.quit()
        except Exception:
            pass

async def send_rma_request_email(
    request_data: dict,
    to_emails: Optional[str] = None,
    cc_emails: Optional[str] = None,
    custom_message: Optional[str] = None
) -> dict:
    """
    Gera o PDF e dispara o e-mail para o setor de notas fiscais com a solicitação em anexo.
    """
    to_list = parse_email_list(to_emails) if to_emails else parse_email_list(RMA_DEFAULT_EMAIL_TO)
    cc_list = parse_email_list(cc_emails) if cc_emails is not None else parse_email_list(RMA_DEFAULT_EMAIL_CC)

    if not to_list:
        raise ValueError("Nenhum e-mail de destino válido informado.")

    req_code = request_data.get("request_code") or f"Nº {request_data.get('id', '')}"
    provider = request_data.get("provider_trade_name") or request_data.get("provider_name") or "Assistência Técnica"
    carrier = request_data.get("carrier_name") or "Transportador Próprio / Retirada"
    items = request_data.get("items", [])
    qty_items = len(items)
    
    total_val = sum(it.get("value", 0.0) or 0.0 for it in items)
    val_str = f"R$ {total_val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    # 1. Gerar PDF oficial
    pdf_bytes = generate_rma_pdf(request_data)

    # 2. Montar Mensagem de E-mail
    msg = MIMEMultipart()
    sender_addr = SMTP_SENDER_EMAIL or SMTP_USER
    msg["From"] = f"{SMTP_SENDER_NAME} <{sender_addr}>"
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    
    subject = f"Solicitação de Emissão de Nota Fiscal - Controle Nº {req_code}"
    msg["Subject"] = subject

    # Texto simples e direto (sem 'equipe de faturamento', como pedido)
    body_text = f"""Olá,

Solicitamos a gentileza de emitir a Nota Fiscal de Saída (Remessa para Conserto) referente à solicitação em anexo.

Resumo da Solicitação:
- Controle: {req_code}
- Destinatário / Assistência: {provider}
- Transportadora: {carrier}
- Quantidade de Itens: {qty_items}
- Valor Total Declarado: {val_str}
"""
    if custom_message and custom_message.strip():
        body_text += f"\nObservação adicional:\n{custom_message.strip()}\n"

    body_text += """
O espelho oficial da solicitação com a relação dos equipamentos, patrimônios e valores segue em anexo em formato PDF.

Atenciosamente,
Setor de TI / CPD - CAPUL
"""

    msg.attach(MIMEText(body_text, "plain", "utf-8"))

    # 3. Anexar PDF
    clean_code = str(req_code).replace("/", "_").replace(" ", "_")
    attachment_name = f"solicitacao_{clean_code}.pdf"
    
    part = MIMEApplication(pdf_bytes, Name=attachment_name)
    part["Content-Disposition"] = f'attachment; filename="{attachment_name}"'
    msg.attach(part)

    # Todos os destinatários para o envelope SMTP
    all_recipients = list(set(to_list + cc_list))

    # 4. Executar envio em thread separada para não travar a aplicação
    await asyncio.to_thread(_send_sync_email, msg, all_recipients)

    return {
        "success": True,
        "request_code": req_code,
        "to": to_list,
        "cc": cc_list,
        "attachment": attachment_name
    }
