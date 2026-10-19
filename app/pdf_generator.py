import io
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer

def generate_rma_pdf(data: dict) -> bytes:
    """
    Gera o PDF oficial A4 da folha de Solicitação de Remessa para Conserto / Controle Patrimonial.
    Estrutura idêntica à visualização de impressão aprovada pelo usuário.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36
    )

    styles = getSampleStyleSheet()
    
    title_company = ParagraphStyle(
        'CompanyHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=16,
        alignment=1, # Centralizado
        textColor=colors.black
    )
    
    title_doc = ParagraphStyle(
        'DocTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=14,
        alignment=1, # Centralizado
        textColor=colors.black
    )

    cell_style = ParagraphStyle(
        'CellRegular',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11.5,
        textColor=colors.black
    )

    cell_bold = ParagraphStyle(
        'CellBold',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=11.5,
        textColor=colors.black
    )

    cell_right = ParagraphStyle(
        'CellRight',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=11.5,
        alignment=2,
        textColor=colors.black
    )

    story = []

    # 1. Cabeçalho Oficial
    story.append(Paragraph("COOPERATIVA AGROPECUÁRIA UNAÍ LTDA", title_company))
    story.append(Paragraph("CONTROLE PATRIMONIAL", title_doc))
    story.append(Spacer(1, 8))

    # 2. Tabela de Cabeçalho (DE / PARA / SETOR / ASSUNTO)
    subj = (data.get("subject_type") or "conserto").lower()
    transf = "(X)" if subj == "transferencia" else "( )"
    cons = "(X)" if subj in ("conserto", "") else "( )"
    emp = "(X)" if subj == "emprestimo" else "( )"
    baixa = "(X)" if subj == "baixa" else "( )"
    
    provider_display = data.get('provider_name') or data.get('provider_trade_name') or ''
    
    header_data = [
        [
            Paragraph(f"<b>DE:</b> {data.get('sender_name', 'CPD')}", cell_style),
            Paragraph(f"<b>PARA:</b> {provider_display}", cell_style)
        ],
        [
            Paragraph(f"<b>SETOR:</b> {data.get('sender_department', 'CPD')}", cell_style),
            Paragraph(f"<b>SETOR:</b> {data.get('recipient_department', 'MANUTENÇÃO')}", cell_style)
        ],
        [
            Paragraph(f"<b>Assunto:</b>  Transferência {transf}&nbsp;&nbsp;&nbsp;&nbsp;Conserto {cons}&nbsp;&nbsp;&nbsp;&nbsp;Empréstimo {emp}&nbsp;&nbsp;&nbsp;&nbsp;Pedido de Baixa {baixa}", cell_style),
            ""
        ]
    ]

    t_header = Table(header_data, colWidths=[261, 261])
    t_header.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 1, colors.black),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.black),
        ('SPAN', (0,2), (1,2)),
        ('TOPPADDING', (0,0), (-1,-1), 3.5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3.5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_header)

    # 3. Tabela de Itens (Sem EC, sem defeito, fontes destacadas)
    items_header = [
        Paragraph("<b>N.º Patrimônio</b>", cell_bold),
        Paragraph("<b>Descrição</b>", cell_bold),
        Paragraph("<b>Valor</b>", cell_right)
    ]
    items_data = [items_header]

    items = data.get("items", [])
    total_val = 0.0
    for it in items:
        subdetails = []
        if it.get("item_code"):
            subdetails.append(f"Código: {it['item_code']}")
        if it.get("serial_number"):
            subdetails.append(f"No Serie: {it['serial_number']}")
        if it.get("origin_branch"):
            subdetails.append(f"Local: {str(it['origin_branch']).upper()}")

        sub_str = "<br/>".join(subdetails)
        desc_html = f"<b>{it.get('description', '')}</b>"
        if sub_str:
            desc_html += f"<br/><font size=7 color='#333333'>{sub_str}</font>"

        val = it.get("value") or 0.0
        total_val += val
        val_str = f"R$ {val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

        items_data.append([
            Paragraph(f"<b>{it.get('patrimony_number', '')}</b>", cell_bold),
            Paragraph(desc_html, cell_style),
            Paragraph(val_str, cell_right)
        ])

    t_items = Table(items_data, colWidths=[130, 282, 110])
    t_items.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 1, colors.black),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.black),
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#F2F2F2')),
        ('TOPPADDING', (0,0), (-1,-1), 4.5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4.5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_items)

    # 4. Bloco Inferior: Justificativa/Destinatário + Linha + Transportadora
    prov_trade = data.get("provider_trade_name") or data.get("provider_name") or ""
    prov_addr = data.get("provider_address") or ""
    prov_city = f"{data.get('provider_city') or ''} - {data.get('provider_state') or ''}".strip(" -")
    prov_cnpj = data.get("provider_cnpj") or ""
    prov_ie = data.get("provider_ie") or ""
    prov_phone = data.get("provider_phone") or ""
    prov_cep = data.get("provider_cep") or ""
    custom_notes = data.get("justification") or ""

    just_lines = [
        "<b>Justificativa/Observação:</b>",
        "P/",
        f"<b>{prov_trade.upper()}</b>",
    ]
    if prov_addr: just_lines.append(prov_addr)
    if prov_city: just_lines.append(prov_city)
    if prov_cnpj: just_lines.append(f"CNPJ: {prov_cnpj}")
    if prov_ie: just_lines.append(f"Inscrição Estadual: {prov_ie}")
    if prov_phone: just_lines.append(f"Telefone: {prov_phone}")
    if prov_cep: just_lines.append(f"CEP: {prov_cep}")
    if custom_notes: just_lines.append(f"<i>Obs: {custom_notes}</i>")

    carrier_name = data.get("carrier_name") or "TRANSPORTADOR PRÓPRIO / RETIRADA"
    carrier_cnpj = data.get("carrier_cnpj") or ""
    carrier_ie = data.get("carrier_ie") or ""

    c_lines = [f"<b>TRANSPORTADOS PELA {carrier_name.upper()}</b>"]
    if carrier_cnpj: c_lines.append(f"CNPJ: {carrier_cnpj}")
    if carrier_ie: c_lines.append(f"INSC. ESTADUAL: {carrier_ie}")

    bottom_data = [
        [Paragraph("<br/>".join(just_lines), cell_style)],
        [Paragraph("<br/>".join(c_lines), cell_style)]
    ]

    t_bottom = Table(bottom_data, colWidths=[522])
    t_bottom.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 1, colors.black),
        ('LINEBELOW', (0,0), (0,0), 1, colors.black),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t_bottom)

    doc.build(story)
    return buffer.getvalue()
