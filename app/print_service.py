import asyncio
import logging
import time
from datetime import datetime
from typing import Dict, Any, Tuple

from app.database import get_db_connection
from app.auth import record_audit_log

logger = logging.getLogger("print_sentinel.print_service")

def generate_standard_test_page(printer: Dict[str, Any], requested_by: str, custom_msg: str = "") -> bytes:
    """
    Gera um fluxo PCL / Texto formatado com caracteres de controle para ejeção de folha (Form Feed).
    Compatível com praticamente todas as impressoras de rede comerciais (HP, Brother, Epson, Kyocera, Lexmark, etc.).
    """
    now_str = datetime.now().strftime("%d/%m/%Y às %H:%M:%S")
    name = printer.get("name", "Impressora")
    branch = printer.get("branch", "N/A")
    dept = printer.get("department", "N/A")
    brand = printer.get("brand", "N/A")
    model = printer.get("model", "N/A")
    ip = printer.get("ip", "N/A")
    dns = printer.get("dns", "N/A") or "Não configurado"
    gateway = printer.get("gateway", "N/A") or "Não configurado"
    mask = printer.get("subnet_mask", "255.255.255.0")
    sn = printer.get("serial_number", "N/A") or "Não informado"
    toner = printer.get("toner_model", "N/A") or "Não informado"

    # Reset PCL (\x1bE) e configuração básica
    lines = [
        "\x1bE", # Reset PCL
        "\r\n" * 2,
        "================================================================================",
        "                  PRINT SENTINEL - PAGINA DE TESTE DE REDE                      ",
        "                Sistema de Gestao e Monitoramento de Impressoras                ",
        "================================================================================",
        "\r\n",
        f"  Data e Hora do Disparo : {now_str}",
        f"  Operador / Solicitante : {requested_by}",
        "\r\n",
        "----------------------------- DADOS DO DISPOSITIVO -----------------------------",
        f"  Nome da Impressora     : {name}",
        f"  Filial / Unidade       : {branch}",
        f"  Setor / Departamento   : {dept}",
        f"  Fabricante / Modelo    : {brand} - {model}",
        f"  Numero de Serie (NS)   : {sn}",
        f"  Suprimento / Toner     : {toner}",
        "\r\n",
        "----------------------------- CONFIGURACOES DE REDE ----------------------------",
        f"  Endereco IP            : {ip}",
        f"  Mascara de Sub-rede    : {mask}",
        f"  Gateway Padrao         : {gateway}",
        f"  Servidor DNS           : {dns}",
        f"  Porta de Conexao RAW   : {printer.get('port', 9100)} TCP (JetDirect)",
        "\r\n",
    ]

    if custom_msg:
        lines.extend([
            "----------------------------- MENSAGEM DO TECNICO ------------------------------",
            f"  {custom_msg}",
            "\r\n"
        ])

    lines.extend([
        "----------------------------- TESTE DE ALINHAMENTO -----------------------------",
        "  Caracteres: ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
        "  Minusculas: abcdefghijklmnopqrstuvwxyz !@#$%&*()_+{}[]",
        "  Gradiente : [####################] [====================] [....................]",
        "\r\n",
        "================================================================================",
        "  RESULTADO: COMUNICACAO TCP/IP DIRETA ESTABELECIDA COM SUCESSO!",
        "  Se voce esta lendo esta pagina, a impressora esta recebendo jobs via rede.",
        "================================================================================",
        "\r\n" * 3,
        "\x0c", # Form Feed (Ejetar página de papel)
        "\x1bE"  # Reset PCL final
    ])

    return "\r\n".join(lines).encode("latin-1", errors="replace")

def generate_zebra_zpl(printer: Dict[str, Any], requested_by: str, custom_msg: str = "") -> bytes:
    """
    Gera código ZPL nativo para impressoras térmicas de etiqueta (Zebra, Argox com ZPL, Elgin L42 Pro, etc.).
    """
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M")
    ip = printer.get("ip", "N/A")
    name = printer.get("name", "Impressora")
    branch = printer.get("branch", "N/A")

    zpl = f"""^XA
^PW800
^LL450
^FO40,30^A0N,32,32^FDPRINT SENTINEL - TESTE ZPL^FS
^FO40,75^GB720,2,2^FS
^FO40,95^A0N,26,26^FDNome: {name[:30]}^FS
^FO40,130^A0N,24,24^FDFilial: {branch[:30]}^FS
^FO40,165^A0N,24,24^FDIP: {ip} | Porta: {printer.get('port', 9100)}^FS
^FO40,200^A0N,22,22^FDData: {now_str} | Por: {requested_by}^FS
"""
    if custom_msg:
        zpl += f"^FO40,235^A0N,22,22^FDNota: {custom_msg[:35]}^FS\n"

    # Código de barras Code 128 com o IP
    zpl += f"""^FO40,270^BY2,3,60^BCN,60,Y,N,N^FD{ip}^FS
^XZ
"""
    return zpl.encode("utf-8")

def generate_escpos_receipt(printer: Dict[str, Any], requested_by: str, custom_msg: str = "") -> bytes:
    """
    Gera código ESC/POS para impressoras de recibo/cupom térmico não fiscal (Elgin i9, Bematech MP-4200, Epson TM-T20).
    """
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    ip = printer.get("ip", "N/A")
    name = printer.get("name", "Impressora")
    branch = printer.get("branch", "N/A")

    buf = bytearray()
    # Init ESC/POS
    buf.extend(b"\x1b@")
    # Alinhamento centralizado
    buf.extend(b"\x1ba\x01")
    # Negrito ligado
    buf.extend(b"\x1bE\x01")
    buf.extend(b"PRINT SENTINEL\nTESTE DE IMPRESSAO\n")
    buf.extend(b"--------------------------------\n")
    # Negrito desligado, alinhamento esquerda
    buf.extend(b"\x1bE\x00\x1ba\x00")
    buf.extend(f"Nome  : {name}\n".encode("latin-1", errors="replace"))
    buf.extend(f"Filial: {branch}\n".encode("latin-1", errors="replace"))
    buf.extend(f"IP    : {ip}\n".encode("latin-1", errors="replace"))
    buf.extend(f"Data  : {now_str}\n".encode("latin-1", errors="replace"))
    buf.extend(f"Oper. : {requested_by}\n".encode("latin-1", errors="replace"))

    if custom_msg:
        buf.extend(f"Msg   : {custom_msg}\n".encode("latin-1", errors="replace"))

    buf.extend(b"--------------------------------\n")
    buf.extend(b"STATUS: CONEXAO RAW 9100 OK!\n\n\n\n")
    # Corte total / parcial de papel
    buf.extend(b"\x1dVA\x00")

    return bytes(buf)

async def send_network_test_print(
    printer: Dict[str, Any],
    test_type: str = "standard_network",
    custom_msg: str = "",
    requested_by: str = "Operador TI",
    timeout_seconds: float = 6.0
) -> Tuple[bool, str, int]:
    """
    Dispara uma impressão de teste diretamente pela rede via Socket TCP (Porta RAW 9100 JetDirect).
    Retorna (success, message, bytes_sent).
    """
    ip = printer.get("ip")
    port = printer.get("port") or 9100
    printer_id = printer.get("id")

    if not ip:
        return False, "Endereço IP da impressora não informado.", 0

    # Selecionar template do job de acordo com o tipo
    if test_type == "zebra_zpl":
        payload = generate_zebra_zpl(printer, requested_by, custom_msg)
    elif test_type == "escpos":
        payload = generate_escpos_receipt(printer, requested_by, custom_msg)
    else:
        payload = generate_standard_test_page(printer, requested_by, custom_msg)

    start_time = time.perf_counter()
    writer = None

    try:
        # Abrir conexão TCP direta com a porta RAW da impressora
        conn = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout_seconds)

        # Transmitir bytes do documento para a impressora
        writer.write(payload)
        await asyncio.wait_for(writer.drain(), timeout=timeout_seconds)

        elapsed_ms = (time.perf_counter() - start_time) * 1000
        bytes_sent = len(payload)

        result_msg = f"Job de teste enviado com sucesso ({bytes_sent} bytes) via porta {port} em {elapsed_ms:.1f}ms."
        success = True

    except asyncio.TimeoutError:
        result_msg = f"Tempo limite esgotado ({timeout_seconds}s) ao conectar em {ip}:{port}. A impressora pode estar desligada ou ocupada."
        success = False
        bytes_sent = 0
    except ConnectionRefusedError:
        result_msg = f"Conexão recusada em {ip}:{port}. O IP respondeu, mas a porta de impressão está desativada na impressora."
        success = False
        bytes_sent = 0
    except OSError as e:
        result_msg = f"Falha de rede ao conectar em {ip}:{port}: {str(e)}"
        success = False
        bytes_sent = 0
    except Exception as e:
        result_msg = f"Erro inesperado no envio de teste: {str(e)}"
        success = False
        bytes_sent = 0
    finally:
        if writer:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    # Atualizar registro da impressora e histórico no banco de dados
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    async with get_db_connection() as db:
        status_label = "sucesso" if success else "falha"
        await db.execute(
            """
            UPDATE printers
            SET last_test_print = ?, last_test_result = ?
            WHERE id = ?
            """,
            (now_str, f"{status_label.upper()}: {result_msg[:120]}", printer_id)
        )

        await db.execute(
            """
            INSERT INTO test_print_logs (
                printer_id, printer_name, printer_ip, branch,
                requested_by, test_type, status, message, bytes_sent, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                printer_id, printer.get("name", ""), ip, printer.get("branch", ""),
                requested_by, test_type, "success" if success else "failed",
                result_msg, bytes_sent, now_str
            )
        )
        await db.commit()

    return success, result_msg, bytes_sent
