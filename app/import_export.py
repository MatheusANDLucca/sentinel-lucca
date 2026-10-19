import csv
import io
import logging
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import List, Dict, Any, Tuple

from app.database import get_db_connection

logger = logging.getLogger("print_sentinel.import_export")

def normalize_key(text: str) -> str:
    """Normaliza texto para identificação de cabeçalhos de coluna."""
    if not text:
        return ""
    text = text.lower().strip()
    # Remover acentuações e caracteres especiais
    text = re.sub(r"[áàãâä]", "a", text)
    text = re.sub(r"[éèêë]", "e", text)
    text = re.sub(r"[íìîï]", "i", text)
    text = re.sub(r"[óòõôö]", "o", text)
    text = re.sub(r"[úùûü]", "u", text)
    text = re.sub(r"[ç]", "c", text)
    text = re.sub(r"[^a-z0-9]", "_", text)
    return text.strip("_")

def detect_column_mappings(headers: List[str]) -> Dict[str, int]:
    """Mapeia índices de colunas a partir de nomes comuns."""
    mapping = {}
    for idx, raw_h in enumerate(headers):
        norm = normalize_key(raw_h)
        if any(k in norm for k in ["filial", "unidade", "loja"]):
            mapping.setdefault("branch", idx)
        elif any(k in norm for k in ["ip", "ipv4", "endereco_ip", "end_ip"]):
            mapping.setdefault("ip", idx)
        elif any(k in norm for k in ["dns", "servidor_dns", "hostname"]):
            mapping.setdefault("dns", idx)
        elif any(k in norm for k in ["gateway", "gtw", "gw"]):
            mapping.setdefault("gateway", idx)
        elif any(k in norm for k in ["mascara", "subnet", "mask"]):
            mapping.setdefault("subnet_mask", idx)
        elif any(k in norm for k in ["modelo", "model"]):
            mapping.setdefault("model", idx)
        elif any(k in norm for k in ["marca", "fabricante", "brand"]):
            mapping.setdefault("brand", idx)
        elif any(k in norm for k in ["serie", "serial", "sn", "ns", "numero_de_serie"]):
            mapping.setdefault("serial_number", idx)
        elif any(k in norm for k in ["pin", "senha", "password"]):
            mapping.setdefault("pin", idx)
        elif any(k in norm for k in ["setor", "departamento", "dept", "localizacao"]):
            mapping.setdefault("department", idx)
        elif any(k in norm for k in ["nome", "impressora", "descricao", "equipamento", "identificacao"]):
            mapping.setdefault("name", idx)
        elif any(k in norm for k in ["toner", "cartucho", "suprimento"]):
            mapping.setdefault("toner_model", idx)
        elif any(k in norm for k in ["tipo", "printer_type"]):
            mapping.setdefault("printer_type", idx)
    return mapping

def parse_xlsx_sheets(file_bytes: bytes) -> List[List[str]]:
    """
    Lê uma planilha Excel (.xlsx) usando apenas zipfile e xml.etree nativos do Python.
    Elimina dependências externas quebradiças e garante máxima compatibilidade.
    """
    rows_data: List[List[str]] = []
    with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
        # 1. Carregar sharedStrings se existirem
        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            tree = ET.fromstring(z.read("xl/sharedStrings.xml"))
            # Namespace do OpenXML SpreadsheetML
            ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            for si in tree.findall(".//s:si", ns):
                # O texto pode estar em <t> ou em múltiplos <r><t>
                text_parts = [t.text or "" for t in si.findall(".//s:t", ns)]
                shared_strings.append("".join(text_parts))

        # 2. Ler a primeira planilha (geralmente sheet1.xml)
        sheet_files = [f for f in z.namelist() if f.startswith("xl/worksheets/sheet") and f.endswith(".xml")]
        if not sheet_files:
            return []
        
        sheet_xml = z.read(sorted(sheet_files)[0])
        tree = ET.fromstring(sheet_xml)
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

        for row in tree.findall(".//s:row", ns):
            current_row: List[str] = []
            for cell in row.findall("s:c", ns):
                cell_type = cell.get("t")
                val_node = cell.find("s:v", ns)
                val_str = ""
                if val_node is not None and val_node.text:
                    if cell_type == "s": # Shared string
                        idx = int(val_node.text)
                        if 0 <= idx < len(shared_strings):
                            val_str = shared_strings[idx]
                    else:
                        val_str = val_node.text
                elif cell_type == "inlineStr":
                    t_node = cell.find(".//s:t", ns)
                    if t_node is not None and t_node.text:
                        val_str = t_node.text
                current_row.append(val_str.strip())
            
            if any(current_row):
                rows_data.append(current_row)

    return rows_data

def infer_branch_and_dept(raw_text: str) -> Tuple[str, str]:
    """Extrai filial e setor a partir de textos como 'Arinos AGV normal 01' ou 'Bonfinópolis Mesa Aline'."""
    if not raw_text:
        return "Matriz", ""
    t = raw_text.strip()
    tl = t.lower()
    known_branches = [
        ("arinos", "Arinos"),
        ("bonfin", "Bonfin\u00f3polis"),
        ("bonfinopolis", "Bonfin\u00f3polis"),
        ("brasilandia", "Brasil\u00e2ndia de Minas"),
        ("buritis", "Buritis"),
        ("cabeceira", "Cabeceiras"),
        ("cab", "Cabeceiras"),
        ("chapada", "Chapada Ga\u00facha"),
        ("dom bosco", "Dom Bosco"),
        ("dom", "Dom Bosco"),
        ("natalandia", "Natal\u00e2ndia"),
        ("riachinho", "Riachinho"),
        ("unai", "Una\u00ed"),
        ("uruana", "Uruana de Minas"),
        ("urucuia", "Urucuia"),
        ("abatedouro", "Abatedouro"),
        ("fabrica", "F\u00e1brica de Ra\u00e7\u00e3o"),
        ("hospital", "Hospital"),
        ("rural", "Rural"),
        ("marcelino", "Marcelino"),
        ("fiscalizacao", "Fiscaliza\u00e7\u00e3o"),
        ("fiscaliza", "Fiscaliza\u00e7\u00e3o"),
        ("almoxarifado", "Matriz"),
        ("escritorio", "Matriz"),
        ("cag", "Matriz")
    ]
    for prefix, b_name in known_branches:
        if tl.startswith(prefix):
            dept = t[len(prefix):].strip(" -_")
            return b_name, dept or t

    parts = t.split(None, 1)
    return parts[0].capitalize(), parts[1] if len(parts) > 1 else ""

def infer_brand_from_model(model_str: str) -> str:
    ml = (model_str or "").lower()
    if "hp" in ml: return "HP"
    if "brother" in ml: return "Brother"
    if "epson" in ml: return "Epson"
    if "zebra" in ml: return "Zebra"
    if "kyocera" in ml: return "Kyocera"
    if "elgin" in ml: return "Elgin"
    if "canon" in ml: return "Canon"
    if "lexmark" in ml: return "Lexmark"
    if "samsung" in ml: return "Samsung"
    return "HP"

def infer_gateway_and_dns(ip_str: str) -> Tuple[str, str]:
    """Calcula o gateway padrão (normalmente .1 da sub-rede) caso não informado."""
    parts = ip_str.split('.')
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        gtw = f"{parts[0]}.{parts[1]}.{parts[2]}.1"
        dns = gtw
        return gtw, dns
    return "", ""

def parse_csv_data(text_content: str) -> List[List[str]]:
    """Lê linhas de um CSV detectando delimitador (, ou ; ou tab)."""
    delimiter = ";" if text_content.count(";") > text_content.count(",") else ","
    reader = csv.reader(io.StringIO(text_content), delimiter=delimiter)
    return [row for row in reader if any(cell.strip() for cell in row)]

async def process_imported_data(rows: List[List[str]]) -> Dict[str, Any]:
    """Processa a matriz de dados importada da planilha e cadastra/atualiza no SQLite."""
    if not rows or len(rows) < 2:
        return {"total": 0, "inserted": 0, "updated": 0, "errors": ["Planilha vazia ou sem linhas de dados."]}

    headers = rows[0]
    col_map = detect_column_mappings(headers)

    if "ip" not in col_map:
        return {
            "total": 0, "inserted": 0, "updated": 0,
            "errors": ["Não foi possível identificar a coluna de Endereço IP na planilha. Verifique o cabeçalho."]
        }

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    inserted = 0
    updated = 0
    errors = []

    async with get_db_connection() as db:
        for line_num, row in enumerate(rows[1:], start=2):
            try:
                def get_val(key: str, default: str = "") -> str:
                    idx = col_map.get(key)
                    if idx is not None and idx < len(row):
                        return row[idx].strip()
                    return default

                ip = get_val("ip")
                if not ip or len(ip) < 7:
                    continue # Linha sem IP válido

                raw_name = get_val("name") or get_val("department") or f"Impressora {ip}"
                model = get_val("model") or ""
                brand = get_val("brand") or infer_brand_from_model(model)
                
                # Se filial não veio em coluna separada, deduzir do nome/setor
                branch = get_val("branch")
                dept = get_val("department")
                if not branch or branch == "Matriz":
                    inferred_branch, inferred_dept = infer_branch_and_dept(raw_name)
                    branch = inferred_branch
                    if not dept:
                        dept = inferred_dept

                name = raw_name
                subnet = get_val("subnet_mask") or "255.255.255.0"
                sn = get_val("serial_number") or ""
                pin = get_val("pin") or ""
                toner = get_val("toner_model") or ""
                ptype = get_val("printer_type") or "laser_mono"

                # Inferir Gateway e DNS se vazios
                gateway = get_val("gateway")
                dns = get_val("dns")
                if not gateway or not dns:
                    inferred_gw, inferred_dns = infer_gateway_and_dns(ip)
                    if not gateway:
                        gateway = inferred_gw
                    if not dns:
                        dns = inferred_dns

                # Verificar se o IP já existe no banco
                cursor = await db.execute("SELECT id FROM printers WHERE ip = ?", (ip,))
                existing = await cursor.fetchone()

                if existing:
                    await db.execute(
                        """
                        UPDATE printers
                        SET name = ?, branch = ?, department = ?, brand = ?, model = ?,
                            dns = ?, gateway = ?, subnet_mask = ?, serial_number = ?, pin = ?,
                            toner_model = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (name, branch, dept, brand, model, dns, gateway, subnet, sn, pin, toner, now_str, existing["id"])
                    )
                    updated += 1
                else:
                    await db.execute(
                        """
                        INSERT INTO printers (
                            name, branch, department, brand, model, printer_type,
                            ip, dns, gateway, subnet_mask, port, web_port,
                            serial_number, pin, toner_model, ownership,
                            status, latency_ms, tcp_status, notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9100, 80, ?, ?, ?, 'propria', 'offline', 0.0, 0, '', ?, ?)
                        """,
                        (name, branch, dept, brand, model, ptype, ip, dns, gateway, subnet, sn, pin, toner, now_str, now_str)
                    )
                    inserted += 1

            except Exception as row_err:
                errors.append(f"Linha {line_num}: {str(row_err)}")

        await db.commit()

    return {
        "total": len(rows) - 1,
        "inserted": inserted,
        "updated": updated,
        "errors": errors
    }

async def generate_printers_csv(branch_filter: str = "") -> str:
    """Gera o arquivo CSV formatado com BOM UTF-8 para abertura perfeita no Microsoft Excel."""
    async with get_db_connection() as db:
        if branch_filter and branch_filter != "Todas":
            cursor = await db.execute("SELECT * FROM printers WHERE branch = ? ORDER BY name ASC", (branch_filter,))
        else:
            cursor = await db.execute("SELECT * FROM printers ORDER BY branch ASC, name ASC")
        rows = [dict(r) for r in await cursor.fetchall()]

    output = io.StringIO()
    # Adicionar Byte Order Mark (BOM) UTF-8 para o Excel reconhecer acentos em português automaticamente
    output.write("\ufeff")
    writer = csv.writer(output, delimiter=";")

    writer.writerow([
        "ID", "Nome da Impressora", "Filial", "Departamento / Setor", "Fabricante",
        "Modelo", "Tipo", "Endereço IP", "Servidor DNS", "Gateway Padrão", "Máscara de Rede",
        "Porta RAW", "Número de Série (NS)", "PIN / Senha", "Modelo do Toner",
        "Propriedade", "Status Atual", "Latência (ms)", "Última Resposta", "Último Teste"
    ])

    for p in rows:
        writer.writerow([
            p["id"], p["name"], p["branch"], p.get("department", ""), p["brand"],
            p.get("model", ""), p.get("printer_type", ""), p["ip"], p.get("dns", ""),
            p.get("gateway", ""), p.get("subnet_mask", ""), p.get("port", 9100),
            p.get("serial_number", ""), p.get("pin", ""), p.get("toner_model", ""),
            p.get("ownership", "propria"), p["status"].upper(), p.get("latency_ms", 0.0),
            p.get("last_seen", ""), p.get("last_test_print", "")
        ])

    return output.getvalue()
