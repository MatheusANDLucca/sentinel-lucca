import asyncio
import logging
from datetime import datetime
from typing import Dict, Any, Tuple, Optional
import httpx

from app.database import get_db_connection

logger = logging.getLogger("cftv_monitor.telegram")

def format_telegram_message(
    event_type: str,
    recorder: Optional[Dict[str, Any]] = None,
    custom_info: Optional[Dict[str, Any]] = None
) -> str:
    """Gera mensagem formatada em HTML nativo para o Telegram com emojis e tags seguras."""
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    custom_info = custom_info or {}

    if event_type == "test":
        return (
            "🧪 <b>CFTV SENTINEL - TESTE DE INTEGRAÇÃO</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "✅ <b>Bot do Telegram configurado com sucesso!</b>\n"
            "🛡️ <b>Sistema:</b> Monitoramento de Gravadores CFTV\n"
            f"🕒 <b>Horário do Teste:</b> {now_str}\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "<i>Você receberá alertas em tempo real de queda de gravadores e falhas neste canal.</i>"
        )

    rec = recorder or {}
    name = rec.get("name", "Gravador")
    ip = rec.get("ip", "0.0.0.0")
    port = rec.get("port", "")
    port_str = f":{port}" if port else ""
    location = rec.get("location") or "Não informada"
    brand = rec.get("brand") or "CFTV"
    latency = rec.get("latency_ms", 0.0)

    if event_type == "offline":
        return (
            "🚨 <b>ALERTA CFTV SENTINEL</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "❌ <b>GRAVADOR OFFLINE DETECTADO!</b>\n"
            f"🏢 <b>Equipamento:</b> {name}\n"
            f"🌐 <b>Endereço:</b> <code>{ip}{port_str}</code>\n"
            f"📍 <b>Localização:</b> {location}\n"
            f"🏷️ <b>Marca:</b> {brand}\n"
            f"🕒 <b>Horário:</b> {now_str}\n"
            "⚠️ <b>Diagnóstico:</b> Falha na comunicação de rede (TCP/Ping).\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "<i>Ação recomendada: Verificar cabeamento de rede, switch ou alimentação elétrica.</i>"
        )
    elif event_type == "online":
        return (
            "✅ <b>CFTV SENTINEL - RESTABELECIDO</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "🟢 <b>GRAVADOR VOLTOU A FICAR ONLINE!</b>\n"
            f"🏢 <b>Equipamento:</b> {name}\n"
            f"🌐 <b>Endereço:</b> <code>{ip}{port_str}</code>\n"
            f"📍 <b>Localização:</b> {location}\n"
            f"⚡ <b>Latência:</b> {latency} ms\n"
            f"🕒 <b>Horário:</b> {now_str}\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "<i>Comunicação normalizada e operando perfeitamente.</i>"
        )
    elif event_type in ("storage", "hd"):
        status = (custom_info.get("storage_status") or rec.get("storage_status") or "aviso").upper()
        details = custom_info.get("storage_info") or rec.get("storage_info") or "Verifique o disco rígido"
        status_icon = "🔴" if status == "ERROR" else "🟡"
        return (
            "💾 <b>ALERTA DE ARMAZENAMENTO CFTV</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            f"{status_icon} <b>AVISO DE DISCO RÍGIDO (HD)!</b>\n"
            f"🏢 <b>Equipamento:</b> {name}\n"
            f"🌐 <b>Endereço:</b> <code>{ip}{port_str}</code>\n"
            f"📍 <b>Localização:</b> {location}\n"
            f"🛠️ <b>Status do HD:</b> {status}\n"
            f"📝 <b>Detalhes:</b> {details}\n"
            f"🕒 <b>Horário:</b> {now_str}\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "<i>Atenção: Possível risco de interrupção nas gravações das câmeras.</i>"
        )

    return f"📢 <b>Notificação CFTV Sentinel</b>: {event_type.upper()} em {name} (<code>{ip}</code>) às {now_str}"


async def get_telegram_config() -> Dict[str, Any]:
    """Recupera as configurações do Telegram salvas no SQLite."""
    async with get_db_connection() as db:
        cursor = await db.execute(
            """
            SELECT key, value FROM settings 
            WHERE key LIKE 'telegram_%'
            """
        )
        rows = await cursor.fetchall()
        cfg = {row["key"]: row["value"] for row in rows}
        return {
            "enabled": cfg.get("telegram_enabled", "false") == "true",
            "bot_token": cfg.get("telegram_bot_token", "").strip(),
            "chat_id": cfg.get("telegram_chat_id", "").strip(),
            "notify_offline": cfg.get("telegram_notify_offline", "true") == "true",
            "notify_online": cfg.get("telegram_notify_online", "true") == "true",
            "notify_hd": cfg.get("telegram_notify_hd", "true") == "true"
        }


async def send_telegram_message(
    bot_token: str,
    chat_id: str,
    text: str,
    timeout: float = 8.0
) -> Tuple[bool, int, str]:
    """
    Envia uma mensagem via API Oficial do Telegram Bot.
    Endpoint: https://api.telegram.org/bot<TOKEN>/sendMessage
    Retorna (sucesso, status_code, resposta_texto).
    """
    clean_token = (bot_token or "").strip()
    clean_chat_id = (chat_id or "").strip()

    if not clean_token:
        return False, 400, "Token do bot do Telegram não informado."
    if not clean_chat_id:
        return False, 400, "Chat ID do Telegram não informado."

    url = f"https://api.telegram.org/bot{clean_token}/sendMessage"
    payload = {
        "chat_id": clean_chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload)
            is_success = 200 <= response.status_code < 300
            resp_text = response.text[:400]
            logger.info("Telegram Bot disparado para chat %s [%d]: %s", clean_chat_id, response.status_code, resp_text)
            return is_success, response.status_code, resp_text
    except httpx.TimeoutException:
        logger.warning("Timeout ao disparar mensagem para Telegram API")
        return False, 504, "Tempo limite esgotado (Timeout de 8s ao conectar ao Telegram)."
    except Exception as e:
        logger.error("Erro ao enviar mensagem para Telegram: %s", e)
        return False, 500, str(e)


async def dispatch_telegram_alert(
    event_type: str,
    recorder: Dict[str, Any],
    custom_info: Optional[Dict[str, Any]] = None
):
    """
    Dispara alerta no Telegram se o bot estiver ativado e configurado para o evento.
    Executado em segundo plano pelo monitor ou pelas rotas.
    """
    try:
        config = await get_telegram_config()
        if not config["enabled"] or not config["bot_token"] or not config["chat_id"]:
            return

        if event_type == "offline" and not config["notify_offline"]:
            return
        if event_type == "online" and not config["notify_online"]:
            return
        if event_type in ("storage", "hd") and not config["notify_hd"]:
            return

        message = format_telegram_message(event_type, recorder, custom_info)
        await send_telegram_message(
            bot_token=config["bot_token"],
            chat_id=config["chat_id"],
            text=message
        )
    except Exception as e:
        logger.error("Falha ao despachar alerta para o Telegram: %s", e)
