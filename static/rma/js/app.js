/**
 * Sentinel Lucca - RMA & Controle Patrimonial
 * Lógica Frontend Completa com Autenticação, WebSockets e Geração de Documentos
 */

let currentUser = null;
let currentTab = 'requests';
let providers = [];
let carriers = [];
let items = [];
let requests = [];
let searchTimeout = null;
let ws = null;

document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    const ok = await checkAuth();
    if (!ok) return;

    await loadStats();
    await loadRequests();
    await loadProviders();
    await loadCarriers();
    initWebSocket();
    lucide.createIcons();
});

function initClock() {
    const clockEl = document.getElementById('liveClock');
    function update() {
        clockEl.textContent = new Date().toLocaleTimeString('pt-BR');
    }
    update();
    setInterval(update, 1000);
}

// ==================== AUTENTICAÇÃO ====================

function getToken() {
    return localStorage.getItem('sentinel_token') || localStorage.getItem('cftv_token') || localStorage.getItem('print_token');
}

function getAuthHeaders(includeJson = true) {
    const headers = {};
    const token = getToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me', { headers: getAuthHeaders(false) });
        if (!res.ok) throw new Error('Não autenticado');

        currentUser = await res.json();

        // Validar permissão ao módulo RMA
        const role = currentUser.role || 'operador';
        const allowed = (currentUser.allowed_modules || 'all').toLowerCase();
        if (role !== 'admin' && allowed !== 'all' && !allowed.includes('rma')) {
            alert('Acesso negado: Seu usuário não tem permissão para acessar o módulo de Controle Patrimonial / RMA.');
            window.location.href = '/portal';
            return false;
        }

        updateUserUI();
        return true;
    } catch (e) {
        localStorage.removeItem('sentinel_token');
        window.location.href = '/login.html';
        return false;
    }
}

function updateUserUI() {
    if (!currentUser) return;
    const name = currentUser.full_name || currentUser.username;
    document.getElementById('headerUserName').textContent = name;
    document.getElementById('dropFullName').textContent = name;
    document.getElementById('dropUsername').textContent = `@${currentUser.username}`;
    document.getElementById('headerUserRole').textContent = currentUser.role.toUpperCase();

    const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
    document.getElementById('userAvatar').textContent = initials;
}

function toggleUserDropdown() {
    document.getElementById('userDropdown').classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('userDropdown');
    const btn = dropdown?.previousElementSibling;
    if (dropdown && !dropdown.contains(e.target) && !btn?.contains(e.target)) {
        dropdown.classList.add('hidden');
    }
});

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST', headers: getAuthHeaders(false) });
    } catch (e) {}
    localStorage.removeItem('sentinel_token');
    window.location.href = '/login.html';
}

// ==================== WEBSOCKET ====================

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/rma`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => console.log('WebSocket RMA conectado.');
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type && data.type.startsWith('RMA_')) {
                loadStats();
                if (currentTab === 'requests') loadRequests();
                if (currentTab === 'items') loadItems();
            }
        } catch (e) {}
    };
    ws.onclose = () => {
        setTimeout(initWebSocket, 5000);
    };
}

// ==================== NAVEGAÇÃO DE TABS ====================

function switchTab(tabName) {
    currentTab = tabName;
    ['requests', 'items', 'providers', 'carriers'].forEach(t => {
        const btn = document.getElementById(`tabBtn-${t}`);
        const content = document.getElementById(`tabContent-${t}`);
        if (t === tabName) {
            btn.classList.add('active-tab');
            content.classList.remove('hidden');
        } else {
            btn.classList.remove('active-tab');
            content.classList.add('hidden');
        }
    });

    if (tabName === 'requests') loadRequests();
    if (tabName === 'items') loadItems();
    if (tabName === 'providers') loadProviders();
    if (tabName === 'carriers') loadCarriers();
    lucide.createIcons();
}

function formatCurrency(val) {
    return (val || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==================== KPIS E ESTATÍSTICAS ====================

async function loadStats() {
    try {
        const res = await fetch('/api/rma/stats', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const d = await res.json();
            document.getElementById('kpiItemsNaTi').textContent = d.items_na_ti;
            document.getElementById('kpiReqsAguardandoNf').textContent = d.requests_aguardando_nf;
            document.getElementById('kpiItemsEmConserto').textContent = d.items_em_conserto;
            document.getElementById('kpiTotalRequests').textContent = d.total_requests;
        }
    } catch (e) {
        console.error('Erro ao buscar stats RMA:', e);
    }
}

// ==================== TAB 1: SOLICITAÇÕES ====================

function getStatusBadge(st) {
    st = (st || 'aguardando_nf').toLowerCase();
    if (st === 'aguardando_nf') {
        return '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>Aguardando NF</span>';
    } else if (st === 'em_conserto' || st === 'em_transito') {
        return '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-orange-500/15 text-orange-400 border border-orange-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>Em Conserto</span>';
    } else if (st === 'retornado') {
        return '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Retornado</span>';
    } else if (st === 'cancelado') {
        return '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>Cancelado</span>';
    }
    return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-300 whitespace-nowrap">${st}</span>`;
}

async function loadRequests() {
    const filter = document.getElementById('filterRequestStatus').value;
    const url = filter && filter !== 'all' ? `/api/rma/requests?status=${filter}` : '/api/rma/requests';

    try {
        const res = await fetch(url, { headers: getAuthHeaders(false) });
        if (res.ok) {
            requests = await res.json();
            renderRequestsTable();
        }
    } catch (e) {
        console.error('Erro ao buscar solicitações:', e);
    }
}

function renderRequestsTable() {
    const tbody = document.getElementById('requestsTableBody');
    const empty = document.getElementById('emptyRequests');

    if (requests.length === 0) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = requests.map(r => {
        const dateStr = r.created_at ? r.created_at.split(' ')[0] : '-';
        const hasNf = Boolean(r.invoice_out && String(r.invoice_out).trim() !== '' && String(r.invoice_out).trim() !== 'null');
        const rawCarrier = r.carrier_name || '-';
        const cleanCarrier = rawCarrier.replace(/^TRANSPORTADOS PELA /i, '').trim();

        return `
            <tr class="hover:bg-dark-700/40 transition">
                <td class="py-2.5 px-3 font-bold text-white select-all text-xs whitespace-nowrap">${r.request_number}</td>
                <td class="py-2.5 px-3 font-sans text-xs">
                    <div class="font-bold text-slate-100 truncate max-w-[150px]" title="${escapeHtml(r.provider_name || '')}">${escapeHtml(r.provider_name || 'Terceirizada')}</div>
                    ${r.provider_cnpj ? `<div class="text-[10px] text-slate-400 font-mono">${r.provider_cnpj}</div>` : ''}
                </td>
                <td class="py-2.5 px-3 font-sans text-slate-300 text-xs">
                    <div class="truncate max-w-[130px]" title="${escapeHtml(rawCarrier)}">${escapeHtml(cleanCarrier)}</div>
                </td>
                <td class="py-2.5 px-2 text-center font-bold text-cyan-400 text-xs">${(r.items || []).length}</td>
                <td class="py-2.5 px-3 text-slate-200 font-semibold whitespace-nowrap text-xs">${formatCurrency(r.total_value)}</td>
                <td class="py-2.5 px-2.5 font-sans whitespace-nowrap text-center">${getStatusBadge(r.status)}</td>
                <td class="py-2.5 px-3 font-mono whitespace-nowrap text-xs">
                    <div>${hasNf ? `<span class="text-amber-300 font-bold">${r.invoice_out}</span>` : '<span class="text-slate-500 font-normal">Pendente</span>'}</div>
                    ${r.invoice_in ? `<div class="text-[10px] text-emerald-400 font-bold mt-0.5">Ret: ${escapeHtml(r.invoice_in)}</div>` : ''}
                </td>
                <td class="py-2.5 px-2.5 text-slate-400 whitespace-nowrap text-xs font-mono">${dateStr}</td>
                <td class="py-2.5 px-3 text-right font-sans whitespace-nowrap">
                    <div class="flex items-center justify-end gap-1">
                        <!-- Imprimir Folha A4 Oficial -->
                        <button onclick="printRequest(${r.id})" title="Imprimir / Gerar PDF Oficial" class="p-1.5 rounded-lg bg-dark-700 hover:bg-cyan-600 text-cyan-400 hover:text-white transition flex items-center gap-1 text-xs font-semibold">
                            <i data-lucide="printer" class="w-3.5 h-3.5"></i>
                            <span class="hidden 2xl:inline">Imprimir</span>
                        </button>

                        <!-- Enviar por E-mail para Faturamento com PDF Anexo -->
                        <button onclick="openSendEmailModal(${r.id})" title="Enviar Solicitação por E-mail (com PDF anexo)" class="p-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 border border-emerald-500/30 text-emerald-400 hover:text-white transition flex items-center gap-1 text-xs font-semibold">
                            <i data-lucide="mail" class="w-3.5 h-3.5"></i>
                            <span class="hidden 2xl:inline">E-mail</span>
                        </button>

                        <!-- Editar Solicitação (Apenas se NÃO tiver NF de saída) -->
                        ${!hasNf ? `
                        <button onclick="openEditRequestModal(${r.id})" title="Editar Solicitação" class="p-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600 border border-blue-500/30 text-blue-300 hover:text-white transition flex items-center gap-1 text-xs font-semibold">
                            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                            <span class="hidden 2xl:inline">Editar</span>
                        </button>
                        ` : ''}

                        <!-- Informar Nota Fiscal -->
                        <button onclick="openInvoiceModal(${r.id})" title="Informar Nota Fiscal e Status" class="p-1.5 rounded-lg bg-dark-700 hover:bg-amber-600 text-amber-400 hover:text-white transition flex items-center gap-1 text-xs font-bold px-2">
                            <i data-lucide="file-check" class="w-3.5 h-3.5"></i>
                            <span>NF</span>
                        </button>

                        <!-- Excluir Solicitação (Apenas se não tiver NF de Saída) -->
                        ${!hasNf ? `
                        <button onclick="deleteRequest(${r.id}, '${r.request_number}')" title="Excluir Solicitação" class="p-1.5 rounded-lg bg-dark-700 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                        ` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    lucide.createIcons();
}

function printRequest(id) {
    window.open(`/rma/print/${id}`, '_blank');
}

async function deleteRequest(id, reqNumber) {
    if (!confirm(`Deseja realmente cancelar e excluir a solicitação ${reqNumber}? Os equipamentos vinculados voltarão para o status 'Na TI'.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/rma/requests/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders(false)
        });
        if (res.ok) {
            await loadRequests();
            await loadStats();
            await loadItems();
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao excluir solicitação.');
        }
    } catch (e) {
        alert('Erro ao conectar com o servidor.');
    }
}

// ==================== MODAL: NOVA SOLICITAÇÃO ====================

async function openNewRequestModal() {
    await loadProviders();
    await loadCarriers();

    document.getElementById('editRequestId').value = '';
    document.getElementById('modalRequestTitle').textContent = 'Criar Solicitação de Controle Patrimonial';
    document.getElementById('btnSubmitRequestText').textContent = 'Gerar Solicitação';

    // Carregar dropdowns de Terceirizada e Transportadora
    const provSelect = document.getElementById('reqProviderId');
    provSelect.innerHTML = providers.map(p => `
        <option value="${p.id}">${escapeHtml(p.name)} ${p.trade_name ? `(${escapeHtml(p.trade_name)})` : ''}</option>
    `).join('');

    const carrSelect = document.getElementById('reqCarrierId');
    carrSelect.innerHTML = '<option value="">Sem Transportadora (Entrega Direta)</option>' + carriers.map(c => `
        <option value="${c.id}">${escapeHtml(c.name)}</option>
    `).join('');

    // Limpar campos
    document.getElementById('reqSenderName').value = 'CLENIO MARCOS';
    document.getElementById('reqSenderDept').value = 'CPD';
    document.getElementById('reqRecipientDept').value = 'MANUTENÇÃO';
    document.getElementById('reqSubjectType').value = 'conserto';
    document.getElementById('reqJustification').value = '';

    // Carregar itens disponíveis na TI
    try {
        const res = await fetch('/api/rma/items?available_only=true', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const availItems = await res.json();
            const container = document.getElementById('availableItemsContainer');
            if (availItems.length === 0) {
                container.innerHTML = `
                    <p class="text-slate-400 text-center py-4">Nenhum equipamento disponível na TI.<br>
                    <a href="javascript:void(0)" onclick="closeModal('modalNewRequest'); openItemModal();" class="text-cyan-400 hover:underline font-bold mt-1 inline-block">+ Cadastrar Equipamento</a></p>
                `;
            } else {
                container.innerHTML = availItems.map(it => `
                    <label class="flex items-start gap-3 p-2 rounded-lg hover:bg-dark-800 transition cursor-pointer border border-transparent hover:border-dark-700">
                        <input type="checkbox" name="reqItemCheck" value="${it.id}" onchange="updateSelectedItemsCount()" class="mt-1 rounded bg-dark-900 border-dark-600 text-amber-500 focus:ring-0">
                        <div class="flex-1">
                            <div class="flex items-center justify-between font-mono">
                                <span class="font-bold text-white text-xs">Patr: ${it.patrimony_number}</span>
                                <span class="text-cyan-400 text-xs font-semibold">${formatCurrency(it.estimated_value)}</span>
                            </div>
                            <div class="text-[11px] font-semibold text-slate-300 font-sans">${escapeHtml(it.description)}</div>
                            <div class="text-[10px] text-slate-400 font-sans flex items-center gap-2">
                                <span>NS: ${it.serial_number || '-'}</span> &bull; 
                                <span>${it.origin_branch}</span>
                            </div>
                            ${it.defect_reported ? `<div class="text-[10px] text-rose-400/90 font-sans">Defeito: ${escapeHtml(it.defect_reported)}</div>` : ''}
                        </div>
                    </label>
                `).join('');
            }
        }
    } catch (e) {}

    updateSelectedItemsCount();
    openModal('modalNewRequest');
}

// ==================== MODAL: EDITAR SOLICITAÇÃO ====================

async function openEditRequestModal(id) {
    const req = requests.find(r => r.id === id);
    if (!req) return;

    // Regra fundamental de negócio: Não permitir editar se já houver NF de saída
    if (req.invoice_out) {
        alert('Esta solicitação já possui Nota Fiscal de Saída emitida e não pode mais ser editada.');
        return;
    }

    await loadProviders();
    await loadCarriers();

    document.getElementById('editRequestId').value = req.id;
    document.getElementById('modalRequestTitle').textContent = `Editar Solicitação #${req.request_number}`;
    document.getElementById('btnSubmitRequestText').textContent = 'Salvar Alterações';

    // Carregar dropdowns de Terceirizada e Transportadora
    const provSelect = document.getElementById('reqProviderId');
    provSelect.innerHTML = providers.map(p => `
        <option value="${p.id}" ${p.id === req.provider_id ? 'selected' : ''}>${escapeHtml(p.name)} ${p.trade_name ? `(${escapeHtml(p.trade_name)})` : ''}</option>
    `).join('');

    const carrSelect = document.getElementById('reqCarrierId');
    carrSelect.innerHTML = '<option value="">Sem Transportadora (Entrega Direta)</option>' + carriers.map(c => `
        <option value="${c.id}" ${c.id === req.carrier_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>
    `).join('');

    // Preencher campos com dados atuais
    document.getElementById('reqSenderName').value = req.sender_name || 'CLENIO MARCOS';
    document.getElementById('reqSenderDept').value = req.sender_department || 'CPD';
    document.getElementById('reqRecipientDept').value = req.recipient_department || 'MANUTENÇÃO';
    document.getElementById('reqSubjectType').value = req.subject_type || 'conserto';
    document.getElementById('reqJustification').value = req.justification_notes || '';

    // Buscar detalhes da solicitação para obter os IDs dos itens já vinculados
    let reqItems = req.items || [];
    try {
        const detRes = await fetch(`/api/rma/requests/${id}`, { headers: getAuthHeaders(false) });
        if (detRes.ok) {
            const det = await detRes.json();
            reqItems = det.items || [];
        }
    } catch(e) {}

    const reqItemIds = new Set(reqItems.map(it => it.item_id));

    // Carregar itens: itens disponíveis na TI + itens já vinculados a esta solicitação
    try {
        const res = await fetch('/api/rma/items', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const allItems = await res.json();
            // Filtrar apenas os que estão 'na_ti' OU que pertencem a esta requisição
            const eligibleItems = allItems.filter(it => it.status === 'na_ti' || reqItemIds.has(it.id));
            const container = document.getElementById('availableItemsContainer');

            if (eligibleItems.length === 0) {
                container.innerHTML = `<p class="text-slate-400 text-center py-4">Nenhum equipamento selecionável.</p>`;
            } else {
                container.innerHTML = eligibleItems.map(it => {
                    const isChecked = reqItemIds.has(it.id);
                    return `
                        <label class="flex items-start gap-3 p-2 rounded-lg hover:bg-dark-800 transition cursor-pointer border ${isChecked ? 'border-amber-500/40 bg-amber-500/10' : 'border-transparent hover:border-dark-700'}">
                            <input type="checkbox" name="reqItemCheck" value="${it.id}" ${isChecked ? 'checked' : ''} onchange="updateSelectedItemsCount()" class="mt-1 rounded bg-dark-900 border-dark-600 text-amber-500 focus:ring-0">
                            <div class="flex-1">
                                <div class="flex items-center justify-between font-mono">
                                    <span class="font-bold text-white text-xs">Patr: ${it.patrimony_number}</span>
                                    <span class="text-cyan-400 text-xs font-semibold">${formatCurrency(it.estimated_value)}</span>
                                </div>
                                <div class="text-[11px] font-semibold text-slate-300 font-sans">${escapeHtml(it.description)}</div>
                                <div class="text-[10px] text-slate-400 font-sans flex items-center gap-2">
                                    <span>NS: ${it.serial_number || '-'}</span> &bull; 
                                    <span>${it.origin_branch}</span>
                                </div>
                                ${isChecked ? '<span class="text-[9px] text-amber-400 font-semibold font-sans mt-0.5 inline-block">✓ Já nesta solicitação</span>' : ''}
                            </div>
                        </label>
                    `;
                }).join('');
            }
        }
    } catch(e) {}

    updateSelectedItemsCount();
    openModal('modalNewRequest');
}

function updateSelectedItemsCount() {
    const checks = document.querySelectorAll('input[name="reqItemCheck"]:checked');
    document.getElementById('selectedItemsCount').textContent = `${checks.length} selecionado(s)`;
}

async function submitNewRequest(e) {
    e.preventDefault();
    const checked = Array.from(document.querySelectorAll('input[name="reqItemCheck"]:checked')).map(c => parseInt(c.value));
    if (checked.length === 0) {
        alert('Por favor, selecione ao menos um equipamento para a solicitação.');
        return;
    }

    const editId = document.getElementById('editRequestId').value;
    const isEditing = !!editId;

    const payload = {
        sender_name: document.getElementById('reqSenderName').value.trim(),
        sender_department: document.getElementById('reqSenderDept').value.trim(),
        provider_id: parseInt(document.getElementById('reqProviderId').value),
        recipient_department: document.getElementById('reqRecipientDept').value.trim(),
        subject_type: document.getElementById('reqSubjectType').value,
        carrier_id: document.getElementById('reqCarrierId').value ? parseInt(document.getElementById('reqCarrierId').value) : null,
        justification_notes: document.getElementById('reqJustification').value.trim(),
        item_ids: checked
    };

    try {
        const url = isEditing ? `/api/rma/requests/${editId}` : '/api/rma/requests';
        const method = isEditing ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const data = await res.json();
            closeModal('modalNewRequest');
            await loadRequests();
            await loadStats();
            await loadItems();

            if (isEditing) {
                alert(`Solicitação #${data.request_number} atualizada com sucesso!`);
            } else {
                if (confirm(`Solicitação ${data.request_number} criada com sucesso!\nDeseja visualizar e imprimir o documento A4 agora?`)) {
                    printRequest(data.id);
                }
            }
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao processar solicitação.');
        }
    } catch (e) {
        alert('Erro ao conectar com o servidor.');
    }
}

// ==================== MODAL: INFORMAR NOTA FISCAL ====================

function openInvoiceModal(reqId) {
    const req = requests.find(r => r.id === reqId);
    if (!req) return;

    document.getElementById('invoiceReqId').value = req.id;
    document.getElementById('invoiceStatus').value = req.status || 'aguardando_nf';
    document.getElementById('invNumOut').value = req.invoice_out || '';
    document.getElementById('invDateOut').value = req.invoice_out_date || '';
    document.getElementById('invNumIn').value = req.invoice_in || '';
    document.getElementById('invDateIn').value = req.invoice_in_date || '';

    openModal('modalInvoice');
}

function handleInvoiceInputs() {
    const invIn = document.getElementById('invNumIn').value.trim();
    const invOut = document.getElementById('invNumOut').value.trim();
    const statusSelect = document.getElementById('invoiceStatus');

    if (invIn !== '') {
        statusSelect.value = 'retornado';
        if (!document.getElementById('invDateIn').value) {
            document.getElementById('invDateIn').value = new Date().toISOString().split('T')[0];
        }
    } else if (invOut !== '' && statusSelect.value === 'aguardando_nf') {
        statusSelect.value = 'em_conserto';
        if (!document.getElementById('invDateOut').value) {
            document.getElementById('invDateOut').value = new Date().toISOString().split('T')[0];
        }
    }
}

async function submitInvoiceForm(e) {
    e.preventDefault();
    const id = document.getElementById('invoiceReqId').value;
    let status = document.getElementById('invoiceStatus').value;
    const invNumOut = document.getElementById('invNumOut').value.trim();
    let invDateOut = document.getElementById('invDateOut').value || null;
    const invNumIn = document.getElementById('invNumIn').value.trim();
    let invDateIn = document.getElementById('invDateIn').value || null;

    // Regra: preencheu NF de retorno -> muda automaticamente para 'retornado'
    if (invNumIn !== '') {
        status = 'retornado';
        if (!invDateIn) {
            invDateIn = new Date().toISOString().split('T')[0];
        }
    } else if (invNumOut !== '' && status === 'aguardando_nf') {
        status = 'em_conserto';
        if (!invDateOut) {
            invDateOut = new Date().toISOString().split('T')[0];
        }
    }

    const payload = {
        status: status,
        invoice_out: invNumOut,
        invoice_out_date: invDateOut,
        invoice_in: invNumIn,
        invoice_in_date: invDateIn
    };

    try {
        const res = await fetch(`/api/rma/requests/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeModal('modalInvoice');
            await loadRequests();
            await loadStats();
            await loadItems();
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao atualizar dados da solicitação.');
        }
    } catch (e) {
        alert('Erro de conexão ao salvar.');
    }
}

// ==================== TAB 2: EQUIPAMENTOS / ITENS ====================

function debounceSearchItems() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadItems, 300);
}

async function loadItems() {
    const search = document.getElementById('searchItemInput')?.value || '';
    const status = document.getElementById('filterItemStatus')?.value || 'all';
    const branch = document.getElementById('filterItemBranch')?.value || 'all';

    let url = '/api/rma/items?1=1';
    if (search.trim()) url += `&search=${encodeURIComponent(search.trim())}`;
    if (status && status !== 'all') url += `&status=${status}`;
    if (branch && branch !== 'all') url += `&branch=${encodeURIComponent(branch)}`;

    try {
        const res = await fetch(url, { headers: getAuthHeaders(false) });
        if (res.ok) {
            items = await res.json();
            renderItemsTable();
        }
    } catch (e) {
        console.error('Erro ao buscar itens:', e);
    }
}

function getItemStatusBadge(st) {
    st = (st || 'na_ti').toLowerCase();
    if (st === 'na_ti') {
        return '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span>Na TI (Disponível)</span>';
    } else if (st === 'aguardando_nf') {
        return '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>Aguardando NF</span>';
    } else if (st === 'em_conserto' || st === 'em_transito') {
        return '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-500/15 text-orange-400 border border-orange-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>Em Conserto</span>';
    } else if (st === 'retornado') {
        return '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 whitespace-nowrap"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Retornado</span>';
    }
    return `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs bg-slate-800 text-slate-300 whitespace-nowrap">${st}</span>`;
}

function renderItemsTable() {
    const tbody = document.getElementById('itemsTableBody');
    const empty = document.getElementById('emptyItems');

    if (items.length === 0) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = items.map(it => {
        const count = it.repair_count || 0;
        return `
        <tr class="hover:bg-dark-700/40 transition">
            <td class="py-3 px-4 font-bold text-white select-all">${it.patrimony_number}</td>
            <td class="py-3 px-4 font-sans font-semibold text-slate-200">
                <div>${escapeHtml(it.description)}</div>
                ${it.defect_reported ? `<div class="text-[10px] text-rose-400 font-normal">Defeito: ${escapeHtml(it.defect_reported)}</div>` : ''}
            </td>
            <td class="py-3 px-4 text-slate-300">${it.serial_number || '-'}</td>
            <td class="py-3 px-4 text-slate-400">${it.item_code || '-'}</td>
            <td class="py-3 px-4 font-sans text-slate-300">${escapeHtml(it.origin_branch || 'Matriz')}</td>
            <td class="py-3 px-4 text-cyan-400 font-semibold">${formatCurrency(it.estimated_value)}</td>
            <td class="py-3 px-4 font-sans">${getItemStatusBadge(it.status)}</td>
            <td class="py-3 px-4 text-right font-sans">
                <div class="flex items-center justify-end gap-1.5">
                    <button onclick="openItemHistoryModal(${it.id})" title="Ver Histórico de Envios e Retornos" class="p-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white transition flex items-center gap-1 text-xs font-semibold">
                        <i data-lucide="history" class="w-3.5 h-3.5"></i>
                        <span class="inline">Histórico</span>
                    </button>
                    <button onclick="editItem(${it.id})" title="Editar Equipamento" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white transition">
                        <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="deleteItemPrompt(${it.id}, '${it.patrimony_number}')" title="Excluir Equipamento" class="p-1.5 rounded-lg bg-dark-700 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                </div>
            </td>
        </tr>
    `}).join('');

    lucide.createIcons();
}

// ==================== MODAL: HISTÓRICO DE MANUTENÇÃO ====================

async function openItemHistoryModal(itemId) {
    const item = items.find(i => i.id === itemId);
    const titleEl = document.getElementById('histItemTitle');
    const subEl = document.getElementById('histItemSubtitle');
    const badgeEl = document.getElementById('histItemCountBadge');
    const totalEl = document.getElementById('histTotalRepairs');
    const lastSentEl = document.getElementById('histLastSent');
    const lastSentNfEl = document.getElementById('histLastSentNf');
    const lastRetEl = document.getElementById('histLastReturned');
    const lastRetNfEl = document.getElementById('histLastReturnedNf');
    const container = document.getElementById('histTimelineContainer');
    const emptyEl = document.getElementById('histEmptyContainer');

    titleEl.textContent = item ? `Histórico de Manutenções: ${item.description}` : 'Histórico de Manutenções';
    subEl.textContent = item ? `Patrimônio: ${item.patrimony_number} | NS: ${item.serial_number || '-'} | Filial: ${item.origin_branch}` : '';
    badgeEl.textContent = 'Carregando...';
    container.innerHTML = '<div class="py-8 text-center text-slate-400 text-xs">Carregando histórico do equipamento...</div>';
    emptyEl.classList.add('hidden');

    openModal('modalItemHistory');

    try {
        const res = await fetch(`/api/rma/items/${itemId}/history`, {
            headers: getAuthHeaders(false)
        });

        if (!res.ok) {
            container.innerHTML = '<div class="py-8 text-center text-rose-400 text-xs">Não foi possível carregar o histórico.</div>';
            return;
        }

        const data = await res.json();
        const histItem = data.item;
        const history = data.history || [];
        const total = history.length;

        badgeEl.textContent = `${total} ${total === 1 ? 'envio' : 'envios'}`;
        totalEl.textContent = total;

        if (total === 0) {
            lastSentEl.textContent = 'Nenhuma';
            lastSentNfEl.textContent = 'Nunca enviado';
            lastRetEl.textContent = 'Nenhum';
            lastRetNfEl.textContent = 'Nunca retornado';
            container.innerHTML = '';
            emptyEl.classList.remove('hidden');
        } else {
            emptyEl.classList.add('hidden');

            const mostRecent = history[0];
            const lastSentDate = mostRecent.invoice_out_date || mostRecent.request_created_at?.split(' ')[0] || '-';
            lastSentEl.textContent = lastSentDate;
            lastSentNfEl.textContent = mostRecent.invoice_out ? `NF Saída: ${mostRecent.invoice_out}` : 'NF Saída: Pendente';

            const returnedItem = history.find(h => h.invoice_in || h.invoice_in_date || h.request_status === 'retornado');
            if (returnedItem && (returnedItem.invoice_in_date || returnedItem.invoice_in)) {
                lastRetEl.textContent = returnedItem.invoice_in_date || '-';
                lastRetNfEl.textContent = returnedItem.invoice_in ? `NF Retorno: ${returnedItem.invoice_in}` : 'Retornado';
            } else if (mostRecent.request_status === 'em_conserto' || mostRecent.request_status === 'em_transito' || mostRecent.request_status === 'aguardando_nf') {
                lastRetEl.textContent = 'Em aberto';
                lastRetNfEl.textContent = 'Ainda na assistência / trânsito';
            } else {
                lastRetEl.textContent = 'Não informado';
                lastRetNfEl.textContent = '-';
            }

            container.innerHTML = history.map((h, idx) => {
                const envioNum = total - idx;
                const isReturned = h.request_status === 'retornado' || Boolean(h.invoice_in);
                const isOngoing = h.request_status === 'em_conserto' || h.request_status === 'em_transito';
                const hasOutNf = Boolean(h.invoice_out);

                let statusBadge = '';
                if (isReturned) {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1"><i data-lucide="check" class="w-3 h-3"></i> Retornado</span>';
                } else if (isOngoing) {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-orange-500/15 text-orange-300 border border-orange-500/30 flex items-center gap-1"><i data-lucide="wrench" class="w-3 h-3"></i> Em Manutenção</span>';
                } else if (h.request_status === 'cancelado') {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">Cancelado</span>';
                } else {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">Aguardando NF</span>';
                }

                const sentDate = h.invoice_out_date || h.request_created_at?.split(' ')[0] || '-';
                const returnDate = h.invoice_in_date || (isReturned ? 'Retornado (sem data)' : 'Aguardando retorno');

                return `
                    <div class="p-4 rounded-xl bg-dark-900 border ${isReturned ? 'border-emerald-500/30 bg-emerald-500/[0.02]' : (isOngoing ? 'border-orange-500/40 bg-orange-500/[0.03]' : 'border-dark-700')} transition hover:border-dark-600 space-y-3">
                        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-dark-700/60 pb-2.5">
                            <div class="flex items-center gap-2">
                                <span class="px-2 py-0.5 rounded text-[11px] font-extrabold bg-dark-700 text-amber-400 border border-dark-600">${envioNum}º Envio</span>
                                <span class="font-mono font-bold text-white text-xs">${h.request_number}</span>
                                ${statusBadge}
                            </div>
                            <div class="text-xs text-slate-300 font-sans flex items-center gap-2">
                                <span class="text-slate-400">Destino:</span>
                                <strong class="text-slate-100">${escapeHtml(h.provider_trade_name || h.provider_name || 'Terceirizada')}</strong>
                                <button onclick="printRequest(${h.request_id})" title="Imprimir folha desta solicitação" class="p-1 rounded bg-dark-800 hover:bg-cyan-600 text-cyan-400 hover:text-white transition ml-1 text-[11px] flex items-center gap-1 font-sans">
                                    <i data-lucide="printer" class="w-3 h-3"></i>
                                    <span>Ver Folha A4</span>
                                </button>
                            </div>
                        </div>

                        <!-- Grid de Saída e Retorno -->
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-sans">
                            <!-- QUANDO FOI (Saída) -->
                            <div class="p-2.5 rounded-lg bg-dark-800/80 border border-dark-700/60 space-y-1.5">
                                <div class="text-[11px] font-bold text-cyan-400 flex items-center gap-1">
                                    <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
                                    <span>QUANDO FOI (Saída para Conserto)</span>
                                </div>
                                <div class="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                                    <span class="text-slate-400 font-sans">Data de Saída:</span>
                                    <strong class="text-slate-100">${sentDate}</strong>
                                </div>
                                <div class="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                                    <span class="text-slate-400 font-sans">NF de Saída:</span>
                                    <span class="${hasOutNf ? 'text-amber-300 font-bold' : 'text-slate-500'}">${h.invoice_out || 'Pendente de emissão'}</span>
                                </div>
                                <div class="flex items-center justify-between text-slate-300 text-[11px]">
                                    <span class="text-slate-400">Transportadora:</span>
                                    <span class="truncate max-w-[180px] font-mono text-slate-300">${escapeHtml(h.carrier_name || 'Entrega Direta')}</span>
                                </div>
                            </div>

                            <!-- QUANDO RETORNOU (Retorno) -->
                            <div class="p-2.5 rounded-lg bg-dark-800/80 border border-dark-700/60 space-y-1.5">
                                <div class="text-[11px] font-bold ${isReturned ? 'text-emerald-400' : 'text-slate-400'} flex items-center gap-1">
                                    <i data-lucide="arrow-down-left" class="w-3.5 h-3.5"></i>
                                    <span>QUANDO RETORNOU (Retorno à Empresa)</span>
                                </div>
                                <div class="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                                    <span class="text-slate-400 font-sans">Data de Retorno:</span>
                                    <strong class="${isReturned ? 'text-emerald-300' : 'text-amber-400'}">${returnDate}</strong>
                                </div>
                                <div class="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                                    <span class="text-slate-400 font-sans">NF de Retorno:</span>
                                    <span class="${h.invoice_in ? 'text-emerald-300 font-bold' : 'text-slate-500'}">${h.invoice_in || (isReturned ? 'Sem NF informada' : 'Ainda na assistência')}</span>
                                </div>
                                ${h.repair_cost ? `
                                <div class="flex items-center justify-between text-slate-300 text-[11px]">
                                    <span class="text-slate-400">Custo do Conserto:</span>
                                    <span class="font-bold text-slate-200">${formatCurrency(h.repair_cost)}</span>
                                </div>
                                ` : ''}
                            </div>
                        </div>

                        ${h.defect_notes || h.justification_notes ? `
                        <div class="text-[11px] text-slate-400 font-sans bg-dark-800/40 p-2 rounded-lg border border-dark-700/40">
                            ${h.defect_notes ? `<span class="text-rose-400/90 font-medium">Defeito relatado:</span> ${escapeHtml(h.defect_notes)} &bull; ` : ''}
                            ${h.justification_notes ? `<span class="text-slate-300 font-medium">Obs:</span> ${escapeHtml(h.justification_notes)}` : ''}
                        </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }

        lucide.createIcons();
    } catch(err) {
        console.error('Erro ao buscar histórico:', err);
        container.innerHTML = '<div class="py-8 text-center text-rose-400 text-xs">Erro ao conectar com o servidor.</div>';
    }
}

function openItemModal(itemId = null) {
    document.getElementById('formItem').reset();
    document.getElementById('editItemId').value = itemId || '';
    document.getElementById('itemModalTitle').textContent = itemId ? 'Editar Equipamento' : 'Cadastrar Equipamento';
    document.getElementById('itemOriginBranch').value = '';
    openModal('modalItem');
}

function editItem(itemId) {
    const it = items.find(i => i.id === itemId);
    if (!it) return;

    document.getElementById('editItemId').value = it.id;
    document.getElementById('itemPatrimony').value = it.patrimony_number || '';
    document.getElementById('itemSerial').value = it.serial_number || '';
    document.getElementById('itemCode').value = it.item_code || '';
    document.getElementById('itemDescription').value = it.description || '';
    document.getElementById('itemType').value = it.item_type || 'Outro';

    const branchSelect = document.getElementById('itemOriginBranch');
    const branchVal = it.origin_branch || '';
    if (branchVal) {
        let found = false;
        for (let opt of branchSelect.options) {
            if (opt.value.toLowerCase() === branchVal.toLowerCase()) {
                branchSelect.value = opt.value;
                found = true;
                break;
            }
        }
        if (!found) {
            const opt = document.createElement('option');
            opt.value = branchVal;
            opt.textContent = branchVal;
            branchSelect.appendChild(opt);
            branchSelect.value = branchVal;
        }
    } else {
        branchSelect.value = '';
    }

    document.getElementById('itemOriginDept').value = it.origin_department || '';
    document.getElementById('itemValue').value = it.estimated_value || '';
    document.getElementById('itemEc').value = it.ec || 'Bom';
    document.getElementById('itemDefect').value = it.defect_reported || '';

    document.getElementById('itemModalTitle').textContent = 'Editar Equipamento';
    openModal('modalItem');
}

async function submitItemForm(e) {
    e.preventDefault();
    const editId = document.getElementById('editItemId').value;
    const payload = {
        patrimony_number: document.getElementById('itemPatrimony').value.trim(),
        serial_number: document.getElementById('itemSerial').value.trim(),
        item_code: document.getElementById('itemCode').value.trim(),
        description: document.getElementById('itemDescription').value.trim(),
        item_type: document.getElementById('itemType').value.trim(),
        origin_branch: document.getElementById('itemOriginBranch').value.trim(),
        origin_department: document.getElementById('itemOriginDept').value.trim(),
        estimated_value: parseFloat(document.getElementById('itemValue').value) || 0.0,
        ec: document.getElementById('itemEc').value,
        defect_reported: document.getElementById('itemDefect').value.trim()
    };

    const url = editId ? `/api/rma/items/${editId}` : '/api/rma/items';
    const method = editId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method: method,
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeModal('modalItem');
            await loadItems();
            await loadStats();
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao salvar equipamento.');
        }
    } catch (e) {
        alert('Erro ao conectar ao servidor.');
    }
}

async function deleteItemPrompt(id, pat) {
    if (!confirm(`Deseja excluir o equipamento de patrimônio ${pat}?`)) return;

    try {
        const res = await fetch(`/api/rma/items/${id}`, { method: 'DELETE', headers: getAuthHeaders(false) });
        if (res.ok) {
            await loadItems();
            await loadStats();
        }
    } catch (e) {}
}

// ==================== TAB 3: TERCEIRIZADAS ====================

async function loadProviders() {
    try {
        const res = await fetch('/api/rma/providers', { headers: getAuthHeaders(false) });
        if (res.ok) {
            providers = await res.json();
            renderProvidersGrid();
        }
    } catch (e) {}
}

function renderProvidersGrid() {
    const grid = document.getElementById('providersGrid');
    if (providers.length === 0) {
        grid.innerHTML = '<p class="col-span-full text-center py-8 text-slate-500 text-xs">Nenhuma terceirizada cadastrada.</p>';
        return;
    }

    grid.innerHTML = providers.map(p => `
        <div class="glass-panel rounded-2xl p-4 flex flex-col justify-between space-y-3">
            <div>
                <div class="flex items-start justify-between gap-2">
                    <h4 class="font-bold text-white text-sm">${escapeHtml(p.name)}</h4>
                    <span class="px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 font-bold border border-blue-500/20">TERCEIRIZADA</span>
                </div>
                ${p.trade_name ? `<p class="text-xs text-amber-400 font-medium mt-0.5">${escapeHtml(p.trade_name)}</p>` : ''}
                
                <div class="mt-3 space-y-1 text-xs text-slate-300 font-mono">
                    ${p.cnpj ? `<div><span class="text-slate-500">CNPJ:</span> ${p.cnpj}</div>` : ''}
                    ${p.state_registration ? `<div><span class="text-slate-500">IE:</span> ${p.state_registration}</div>` : ''}
                    ${p.phone ? `<div class="font-sans"><span class="text-slate-500">Tel:</span> ${p.phone}</div>` : ''}
                    ${p.address ? `<div class="font-sans text-slate-400 text-[11px] mt-1">${escapeHtml(p.address)}${p.city ? ` - ${p.city}` : ''}</div>` : ''}
                </div>
            </div>

            <div class="pt-3 border-t border-dark-700/80 flex items-center justify-between text-xs">
                <span class="text-slate-500 text-[11px]">${p.email || ''}</span>
                <button onclick="deleteProviderPrompt(${p.id}, '${escapeHtml(p.name)}')" class="text-slate-400 hover:text-rose-400 p-1 rounded hover:bg-dark-700 transition" title="Excluir">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </div>
        </div>
    `).join('');

    lucide.createIcons();
}

function openProviderModal() {
    document.getElementById('formProvider').reset();
    openModal('modalProvider');
}

async function submitProviderForm(e) {
    e.preventDefault();
    const payload = {
        name: document.getElementById('provName').value.trim(),
        trade_name: document.getElementById('provTrade').value.trim(),
        cnpj: document.getElementById('provCnpj').value.trim(),
        state_registration: document.getElementById('provIe').value.trim(),
        address: document.getElementById('provAddress').value.trim(),
        city: document.getElementById('provCity').value.trim(),
        cep: document.getElementById('provCep').value.trim(),
        phone: document.getElementById('provPhone').value.trim(),
        email: document.getElementById('provEmail').value.trim()
    };

    try {
        const res = await fetch('/api/rma/providers', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            closeModal('modalProvider');
            await loadProviders();
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao cadastrar terceirizada.');
        }
    } catch (e) {
        alert('Erro ao conectar ao servidor.');
    }
}

async function deleteProviderPrompt(id, name) {
    if (!confirm(`Deseja remover a terceirizada '${name}'?`)) return;
    try {
        await fetch(`/api/rma/providers/${id}`, { method: 'DELETE', headers: getAuthHeaders(false) });
        await loadProviders();
    } catch (e) {}
}

// ==================== TAB 4: TRANSPORTADORAS ====================

async function loadCarriers() {
    try {
        const res = await fetch('/api/rma/carriers', { headers: getAuthHeaders(false) });
        if (res.ok) {
            carriers = await res.json();
            renderCarriersGrid();
        }
    } catch (e) {}
}

function renderCarriersGrid() {
    const grid = document.getElementById('carriersGrid');
    if (carriers.length === 0) {
        grid.innerHTML = '<p class="col-span-full text-center py-8 text-slate-500 text-xs">Nenhuma transportadora cadastrada.</p>';
        return;
    }

    grid.innerHTML = carriers.map(c => `
        <div class="glass-panel rounded-2xl p-4 flex flex-col justify-between space-y-3">
            <div>
                <div class="flex items-start justify-between gap-2">
                    <h4 class="font-bold text-white text-sm">${escapeHtml(c.name)}</h4>
                    <span class="px-2 py-0.5 rounded text-[10px] bg-indigo-500/10 text-indigo-400 font-bold border border-indigo-500/20">FRETE</span>
                </div>
                
                <div class="mt-3 space-y-1 text-xs text-slate-300 font-mono">
                    ${c.cnpj ? `<div><span class="text-slate-500">CNPJ:</span> ${c.cnpj}</div>` : ''}
                    ${c.state_registration ? `<div><span class="text-slate-500">IE:</span> ${c.state_registration}</div>` : ''}
                    ${c.phone ? `<div class="font-sans"><span class="text-slate-500">Contato:</span> ${c.phone}</div>` : ''}
                </div>
            </div>

            <div class="pt-3 border-t border-dark-700/80 flex items-center justify-end">
                <button onclick="deleteCarrierPrompt(${c.id}, '${escapeHtml(c.name)}')" class="text-slate-400 hover:text-rose-400 p-1 rounded hover:bg-dark-700 transition" title="Excluir">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </div>
        </div>
    `).join('');

    lucide.createIcons();
}

function openCarrierModal() {
    document.getElementById('formCarrier').reset();
    openModal('modalCarrier');
}

async function submitCarrierForm(e) {
    e.preventDefault();
    const payload = {
        name: document.getElementById('carrName').value.trim(),
        cnpj: document.getElementById('carrCnpj').value.trim(),
        state_registration: document.getElementById('carrIe').value.trim(),
        phone: document.getElementById('carrPhone').value.trim()
    };

    try {
        const res = await fetch('/api/rma/carriers', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            closeModal('modalCarrier');
            await loadCarriers();
        } else {
            const err = await res.json();
            alert(err.detail || 'Erro ao cadastrar transportadora.');
        }
    } catch (e) {
        alert('Erro ao conectar ao servidor.');
    }
}

async function deleteCarrierPrompt(id, name) {
    if (!confirm(`Deseja remover a transportadora '${name}'?`)) return;
    try {
        await fetch(`/api/rma/carriers/${id}`, { method: 'DELETE', headers: getAuthHeaders(false) });
        await loadCarriers();
    } catch (e) {}
}

// ==================== MODAL UTILS ====================

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    lucide.createIcons();
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

// ==================== ENVIO DE E-MAIL COM PDF ====================

let rmaEmailConfig = null;

async function loadRmaEmailConfig() {
    if (rmaEmailConfig) return rmaEmailConfig;
    try {
        const res = await fetch('/api/rma/email-config', { headers: getAuthHeaders(false) });
        if (res.ok) {
            rmaEmailConfig = await res.json();
        }
    } catch (e) {
        console.error('Erro ao obter configurações de e-mail:', e);
    }
    return rmaEmailConfig;
}

async function openSendEmailModal(reqId) {
    const r = requests.find(x => x.id === reqId);
    if (!r) return;

    await loadRmaEmailConfig();

    document.getElementById('emailReqId').value = reqId;
    document.getElementById('emailModalReqCode').textContent = `Controle: ${r.request_number} | Destino: ${r.provider_name || '-'}`;
    
    // Preenche com os e-mails padrão definidos
    document.getElementById('emailToInput').value = rmaEmailConfig?.default_to || 'matheuslucca@capul.com.br';
    document.getElementById('emailCcInput').value = rmaEmailConfig?.default_cc || 'lucas.ti@capul.com.br';
    document.getElementById('emailCustomMessage').value = '';

    const cleanCode = String(r.request_number).replace(/[\/\s]/g, '_');
    document.getElementById('emailAttachmentName').textContent = `solicitacao_${cleanCode}.pdf`;
    document.getElementById('btnPreviewPdf').href = `/api/rma/requests/${reqId}/pdf`;

    const noticeEl = document.getElementById('emailSmtpNotice');
    if (rmaEmailConfig && !rmaEmailConfig.is_smtp_configured) {
        noticeEl.classList.remove('hidden');
    } else {
        noticeEl.classList.add('hidden');
    }

    openModal('modalSendEmail');
}

async function submitSendEmailForm(e) {
    e.preventDefault();
    const reqId = document.getElementById('emailReqId').value;
    const toEmails = document.getElementById('emailToInput').value.trim();
    const ccEmails = document.getElementById('emailCcInput').value.trim();
    const customMessage = document.getElementById('emailCustomMessage').value.trim();

    if (!toEmails) {
        alert('Por favor, informe ao menos um e-mail de destino.');
        return;
    }

    const btn = document.getElementById('btnSubmitSendEmail');
    const btnText = document.getElementById('btnSubmitSendEmailText');
    const originalText = btnText.textContent;

    btn.disabled = true;
    btnText.textContent = 'Enviando e-mail...';

    try {
        const res = await fetch(`/api/rma/requests/${reqId}/send-email`, {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify({
                to_emails: toEmails,
                cc_emails: ccEmails,
                custom_message: customMessage
            })
        });

        const data = await res.json();
        if (res.ok) {
            closeModal('modalSendEmail');
            alert(`Sucesso! E-mail com PDF da solicitação enviado para: ${toEmails}${ccEmails ? ` (CC: ${ccEmails})` : ''}`);
        } else {
            alert(data.detail || 'Erro ao enviar e-mail.');
        }
    } catch (err) {
        console.error('Erro ao enviar e-mail:', err);
        alert('Erro ao conectar com o servidor para envio do e-mail.');
    } finally {
        btn.disabled = false;
        btnText.textContent = originalText;
    }
}
