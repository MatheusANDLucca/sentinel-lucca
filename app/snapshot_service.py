import logging
import httpx
from typing import Tuple, Optional

logger = logging.getLogger("cftv_monitor.snapshot")

def generate_fallback_svg(title: str, subtitle: str, is_offline: bool = False) -> bytes:
    """Gera uma imagem SVG de contingência de alta qualidade quando o DVR não responde."""
    bg_color = "#1f1315" if is_offline else "#111827"
    border_color = "#f43f5e" if is_offline else "#374151"
    icon_color = "#f43f5e" if is_offline else "#94a3b8"
    status_text = "OFFLINE" if is_offline else "INDISPONÍVEL"

    svg = f"""<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="{bg_color}" rx="12" stroke="{border_color}" stroke-width="2"/>
        <g fill="none" stroke="{icon_color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(295, 120)">
            <path d="m22 8-6 4 6 4V8Z"/>
            <rect width="14" height="12" x="2" y="6" rx="2"/>
        </g>
        <text x="50%" y="200" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="bold" fill="#f8fafc" text-anchor="middle">
            {title}
        </text>
        <text x="50%" y="225" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">
            {subtitle}
        </text>
        <rect x="270" y="245" width="100" height="24" rx="6" fill="{border_color}" fill-opacity="0.2"/>
        <text x="50%" y="261" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="bold" fill="{icon_color}" text-anchor="middle">
            {status_text}
        </text>
    </svg>"""
    return svg.encode("utf-8")

async def fetch_recorder_snapshot(
    ip: str,
    brand: str = "Intelbras",
    channel: int = 1,
    user: str = "",
    password: str = "",
    name: str = "Câmera CFTV"
) -> Tuple[bytes, str]:
    """
    Obtém uma miniatura JPEG do gravador.
    Retorna uma tupla (image_bytes, media_type).
    """
    brand_lower = (brand or "").lower()
    ch = channel or 1

    urls_to_try = []

    # URLs padrão conforme fabricante
    if "hikvision" in brand_lower:
        urls_to_try.extend([
            f"http://{ip}/ISAPI/Streaming/channels/{ch}01/picture",
            f"http://{ip}/Streaming/channels/{ch}/picture",
            f"http://{ip}/onvif-http/snapshot?channel={ch}"
        ])
    else: # Intelbras, Dahua ou Genérico
        urls_to_try.extend([
            f"http://{ip}/cgi-bin/snapshot.cgi?channel={ch}",
            f"http://{ip}/cgi-bin/snapshot.cgi",
            f"http://{ip}/onvif-http/snapshot?channel={ch}"
        ])

    auth = None
    if user and password:
        auth = httpx.BasicAuth(user, password)

    async with httpx.AsyncClient(timeout=3.5, follow_redirects=True, verify=False) as client:
        for url in urls_to_try:
            try:
                # Tenta primeiro com Basic Auth
                resp = await client.get(url, auth=auth)
                
                # Se retornar 401 Unauthorized e houver credenciais, tenta Digest Auth (comum em Hikvision/Dahua)
                if resp.status_code == 401 and user and password:
                    digest_auth = httpx.DigestAuth(user, password)
                    resp = await client.get(url, auth=digest_auth)

                if resp.status_code == 200 and "image" in resp.headers.get("content-type", "").lower():
                    return resp.content, resp.headers.get("content-type", "image/jpeg")

            except Exception as e:
                logger.debug("Falha na tentativa de snapshot em %s: %s", url, e)

    # Se todas as tentativas falharem, retorna o SVG de contingência
    svg_fallback = generate_fallback_svg(
        title=name,
        subtitle=f"Canal {ch} • {ip}",
        is_offline=False
    )
    return svg_fallback, "image/svg+xml"
