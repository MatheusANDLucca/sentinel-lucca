/**
 * Print Sentinel - Gestão e Monitoramento de Impressoras em Rede
 * Script Principal do Frontend
 */

// Estado Global da Aplicação
let currentUser = null;
let printersData = [];
let branchesData = [];
let activeFilters = {
    branch: 'Todas',
    status: 'all',
    brand: '',
    search: ''
};
let selectedPrinterForTest = null;
let currentEditingPrinterId = null;
let ws = null;
let wsReconnectTimer = null;
let isSoundEnabled = localStorage.getItem('print_sound_enabled') !== 'false';
let selectedUploadFile = null;

// ==================== INICIALIZAÇÃO ====================
document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initSoundSettings();
    await checkAuthSession();
    await loadInitialData();
    initWebSocket();
    lucide.createIcons();

    // Atualização periódica de métricas e relógio
    setInterval(updateMetrics, 15000);
});

// ==================== AUTENTICAÇÃO E SESSÃO ====================

function getToken() {
    return localStorage.getItem('sentinel_token') || localStorage.getItem('print_token') || localStorage.getItem('cftv_token');
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

// Interceptor transparente para incluir token Bearer em todas as chamadas de API
const _origFetch = window.fetch;
window.fetch = async function (input, init = {}) {
    init = init || {};
    init.headers = init.headers || {};
    const token = getToken();
    if (token && typeof input === 'string' && input.startsWith('/api/')) {
        if (init.headers instanceof Headers) {
            if (!init.headers.has('Authorization')) {
                init.headers.set('Authorization', `Bearer ${token}`);
            }
        } else if (!init.headers['Authorization']) {
            init.headers['Authorization'] = `Bearer ${token}`;
        }
    }
    const response = await _origFetch(input, init);
    if (response.status === 401 && typeof input === 'string' && !input.includes('/api/auth/login')) {
        localStorage.removeItem('sentinel_token');
        localStorage.removeItem('print_token');
        localStorage.removeItem('cftv_token');
        window.location.href = '/login.html';
    }
    return response;
};

async function checkAuthSession() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            throw new Error('Não autenticado');
        }
        currentUser = await res.json();
        const allowed = currentUser.allowed_modules || 'all';
        if (currentUser.role !== 'admin' && allowed !== 'all' && !allowed.includes('printers')) {
            alert('Acesso Restrito: Seu perfil de usuário não tem permissão para acessar o módulo Print Sentinel.');
            window.location.href = '/portal';
            return;
        }
        updateUserUI();
    } catch (e) {
        localStorage.removeItem('sentinel_token');
        localStorage.removeItem('print_token');
        localStorage.removeItem('cftv_token');
        window.location.href = '/login.html';
    }
}

function updateUserUI() {
    if (!currentUser) return;

    document.getElementById('navUserName').textContent = currentUser.full_name || currentUser.username;
    document.getElementById('dropdownFullName').textContent = currentUser.full_name || currentUser.username;
    document.getElementById('dropdownRole').textContent = `Perfil: ${currentUser.role}`;

    const initials = (currentUser.full_name || currentUser.username)
        .split(' ')
        .map(n => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
    document.getElementById('userAvatarText').textContent = initials;

    // Mostrar ou ocultar painel admin conforme perfil
    const adminBtn = document.getElementById('btnAdminPanel');
    if (currentUser.role === 'admin') {
        adminBtn.classList.remove('hidden');
    } else {
        adminBtn.classList.add('hidden');
    }

    // Se for apenas visualizador, esconder botões de cadastro e importação
    if (currentUser.role === 'visualizador') {
        document.getElementById('btnAddPrinterHeader')?.classList.add('hidden');
        document.getElementById('btnImportHeader')?.classList.add('hidden');
    }
}

function toggleUserDropdown() {
    const dropdown = document.getElementById('userDropdown');
    dropdown.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('userMenuWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        document.getElementById('userDropdown')?.classList.add('hidden');
    }
});

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    localStorage.removeItem('print_token');
    localStorage.removeItem('print_user');
    window.location.href = '/login.html';
}

// ==================== WEBSOCKETS EM TEMPO REAL ====================
function initWebSocket() {
    if (ws) {
        try { ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        updateWsBadge(true);
        if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('Erro ao processar mensagem WebSocket:', e);
        }
    };

    ws.onclose = () => {
        updateWsBadge(false);
        if (!wsReconnectTimer) {
            wsReconnectTimer = setTimeout(() => {
                wsReconnectTimer = null;
                initWebSocket();
            }, 4000);
        }
    };

    ws.onerror = () => {
        updateWsBadge(false);
    };

    // Ping periódico para manter a conexão aberta
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 25000);
}

function updateWsBadge(isConnected) {
    const badge = document.getElementById('wsStatusBadge');
    const text = document.getElementById('wsStatusText');
    if (isConnected) {
        badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400";
        text.textContent = "Tempo Real Conectado";
    } else {
        badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400";
        text.textContent = "Reconectando...";
    }
}

function handleWebSocketMessage(data) {
    if (data.type === 'BATCH_STATUS_UPDATE') {
        // Atualizar lista completa
        const updateMap = new Map(data.printers.map(p => [p.id, p]));
        printersData = printersData.map(p => updateMap.has(p.id) ? { ...p, ...updateMap.get(p.id) } : p);
        renderPrinters();
        updateMetrics();
        updateBranchTabsCounters();
    } else if (data.type === 'SINGLE_STATUS_UPDATE') {
        const updated = data.printer;
        const idx = printersData.findIndex(p => p.id === updated.id);
        if (idx !== -1) {
            printersData[idx] = { ...printersData[idx], ...updated };
        } else {
            printersData.push(updated);
        }
        renderPrinters();
        updateMetrics();
        updateBranchTabsCounters();
    } else if (data.type === 'PRINTER_STATUS_CHANGED') {
        if (data.new_status === 'offline') {
            playDropSound();
            showToast(`Impressora Offline: ${data.printer_name} (${data.ip}) na filial ${data.branch}`, 'error');
        } else if (data.new_status === 'warning') {
            showToast(`Alerta: ${data.printer_name} (${data.ip}) respondeu ping mas a porta 9100 está em espera.`, 'warning');
        } else if (data.new_status === 'online' && data.old_status === 'offline') {
            showToast(`Impressora Restaurada: ${data.printer_name} (${data.ip}) está Online!`, 'success');
        }
    }
}

// ==================== CARREGAMENTO DE DADOS ====================
async function loadInitialData() {
    await Promise.all([
        fetchPrinters(),
        fetchBranches(),
        updateMetrics()
    ]);
}

async function fetchPrinters() {
    try {
        const res = await fetch('/api/printers');
        if (!res.ok) throw new Error('Falha ao obter impressoras');
        printersData = await res.json();
        renderPrinters();
    } catch (e) {
        showToast('Erro ao carregar lista de impressoras.', 'error');
    }
}

async function fetchBranches() {
    try {
        const res = await fetch('/api/branches');
        if (!res.ok) throw new Error('Falha ao obter filiais');
        branchesData = await res.json();
        renderBranchTabs();
        populateBranchDatalist();
    } catch (e) {
        console.error('Erro ao buscar filiais:', e);
    }
}

async function updateMetrics() {
    try {
        const res = await fetch('/api/metrics');
        if (!res.ok) return;
        const m = await res.json();

        document.getElementById('metricTotal').textContent = m.total_printers;
        document.getElementById('metricOnline').textContent = m.online_printers;
        document.getElementById('metricWarning').textContent = m.warning_printers;
        document.getElementById('metricOffline').textContent = m.offline_printers;
        document.getElementById('metricSla').textContent = `${m.sla_percentage}%`;
        document.getElementById('metricLatency').textContent = m.average_latency_ms > 0 ? `${m.average_latency_ms}` : '--';
        document.getElementById('badgeAllCount').textContent = `${m.online_printers}/${m.total_printers}`;
        document.getElementById('branchCountText').textContent = `${m.branches_count} ${m.branches_count === 1 ? 'filial ativa' : 'filiais ativas'}`;
    } catch (e) {
        console.error('Erro ao atualizar métricas:', e);
    }
}

// ==================== ABAS DE FILIAIS ====================
function renderBranchTabs() {
    const container = document.getElementById('branchTabsContainer');
    // Mantém o botão "Todas as Filiais"
    const totalOnline = printersData.filter(p => p.status === 'online').length;
    container.innerHTML = `
        <button onclick="selectBranch('Todas')" class="branch-tab-btn ${activeFilters.branch === 'Todas' ? 'active' : ''} text-xs font-semibold px-3 py-1.5 rounded-lg border border-dark-600 bg-dark-700 hover:bg-dark-600 text-slate-200 transition flex-shrink-0 flex items-center gap-1.5">
            <span>Todas as Filiais</span>
            <span class="bg-dark-900/80 text-cyan-400 px-1.5 py-0.2 rounded text-[10px]" id="badgeAllCount">${totalOnline}/${printersData.length}</span>
        </button>
    `;

    branchesData.forEach(b => {
        const isActive = activeFilters.branch === b.branch;
        const btn = document.createElement('button');
        btn.onclick = () => selectBranch(b.branch);
        btn.className = `branch-tab-btn ${isActive ? 'active' : ''} text-xs font-semibold px-3 py-1.5 rounded-lg border border-dark-600 bg-dark-700 hover:bg-dark-600 text-slate-200 transition flex-shrink-0 flex items-center gap-1.5`;
        btn.innerHTML = `
            <span>${b.branch}</span>
            <span class="bg-dark-900/80 ${b.offline > 0 ? 'text-rose-400' : 'text-emerald-400'} px-1.5 py-0.2 rounded text-[10px]">${b.online}/${b.total}</span>
        `;
        container.appendChild(btn);
    });
}

function updateBranchTabsCounters() {
    renderBranchTabs();
}

function selectBranch(branchName) {
    activeFilters.branch = branchName;
    renderBranchTabs();
    renderPrinters();
}

function populateBranchDatalist() {
    const datalist = document.getElementById('branchSuggestions');
    if (!datalist) return;
    datalist.innerHTML = '';
    branchesData.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.branch;
        datalist.appendChild(opt);
    });
}

// ==================== FILTROS E BUSCA ====================
function setStatusFilter(status) {
    activeFilters.status = status;
    document.querySelectorAll('.status-filter-btn').forEach(b => b.classList.remove('active'));

    const btnIdMap = {
        'all': 'filterStatusAll',
        'online': 'filterStatusOnline',
        'warning': 'filterStatusWarning',
        'offline': 'filterStatusOffline'
    };
    document.getElementById(btnIdMap[status])?.classList.add('active');
    renderPrinters();
}

function handleSearch(val) {
    activeFilters.search = val.toLowerCase().trim();
    const clearBtn = document.getElementById('clearSearchBtn');
    if (activeFilters.search) {
        clearBtn.classList.remove('hidden');
    } else {
        clearBtn.classList.add('hidden');
    }
    renderPrinters();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    handleSearch('');
}

function handleBrandFilter(brand) {
    activeFilters.brand = brand;
    renderPrinters();
}

// ==================== RENDERIZAÇÃO DOS CARDS DE IMPRESSORAS ====================
function renderPrinters() {
    const grid = document.getElementById('printersGrid');
    const emptyState = document.getElementById('emptyState');

    let filtered = printersData.filter(p => {
        // Filtro por Filial
        if (activeFilters.branch !== 'Todas' && p.branch !== activeFilters.branch) {
            return false;
        }
        // Filtro por Status
        if (activeFilters.status !== 'all' && p.status !== activeFilters.status) {
            return false;
        }
        // Filtro por Marca
        if (activeFilters.brand && p.brand.toLowerCase() !== activeFilters.brand.toLowerCase()) {
            return false;
        }
        // Filtro por Busca de Texto (IP, DNS, Gateway, Nome, Modelo, NS, Setor)
        if (activeFilters.search) {
            const s = activeFilters.search;
            const textToSearch = `${p.name} ${p.ip} ${p.dns || ''} ${p.gateway || ''} ${p.model || ''} ${p.brand} ${p.serial_number || ''} ${p.department || ''} ${p.toner_model || ''}`.toLowerCase();
            if (!textToSearch.includes(s)) {
                return false;
            }
        }
        return true;
    });

    if (filtered.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        emptyState.classList.add('flex');
        return;
    }

    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    grid.innerHTML = filtered.map(p => generatePrinterCardHtml(p)).join('');
    lucide.createIcons();
}

function getBrandBadgeClass(brand) {
    const b = (brand || '').toLowerCase();
    if (b.includes('hp')) return 'brand-badge-hp';
    if (b.includes('brother')) return 'brand-badge-brother';
    if (b.includes('epson')) return 'brand-badge-epson';
    if (b.includes('zebra')) return 'brand-badge-zebra';
    if (b.includes('kyocera')) return 'brand-badge-kyocera';
    if (b.includes('elgin')) return 'brand-badge-elgin';
    if (b.includes('canon')) return 'brand-badge-canon';
    if (b.includes('lexmark')) return 'brand-badge-lexmark';
    return 'brand-badge-default';
}

function getStatusDetails(status) {
    if (status === 'online') {
        return {
            label: 'ONLINE',
            badgeClass: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
            dotClass: 'bg-emerald-500',
            pulseClass: '',
            cardBorder: 'border-dark-700/80 hover:border-emerald-500/40'
        };
    } else if (status === 'warning') {
        return {
            label: 'ALERTA / SLEEP',
            badgeClass: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
            dotClass: 'bg-amber-500',
            pulseClass: 'card-warning-pulse',
            cardBorder: 'border-amber-500/40'
        };
    } else {
        return {
            label: 'OFFLINE',
            badgeClass: 'bg-rose-500/10 border-rose-500/30 text-rose-400',
            dotClass: 'bg-rose-500',
            pulseClass: 'card-offline-pulse',
            cardBorder: 'border-rose-500/50'
        };
    }
}

function generatePrinterCardHtml(p) {
    const s = getStatusDetails(p.status);
    const brandClass = getBrandBadgeClass(p.brand);
    const canManage = currentUser && (currentUser.role === 'admin' || currentUser.role === 'operador');
    const isAdmin = currentUser && currentUser.role === 'admin';

    // Formatar DNS e Gateway de forma amigável
    const dnsDisplay = p.dns ? p.dns : '<span class="text-slate-500 italic">Não informado</span>';
    const gtwDisplay = p.gateway ? p.gateway : '<span class="text-slate-500 italic">Não informado</span>';

    return `
    <div class="printer-card bg-dark-800/90 border ${s.cardBorder} ${s.pulseClass} rounded-2xl p-4 flex flex-col justify-between shadow-xl relative overflow-hidden group">
        
        <!-- Top Bar: Status, Filial e Marca -->
        <div>
            <div class="flex items-start justify-between gap-2 mb-2">
                <div class="flex items-center gap-2 flex-wrap">
                    <!-- Status Indicator Badge -->
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${s.badgeClass}">
                        <span class="w-2 h-2 rounded-full ${s.dotClass} ${p.status === 'offline' ? 'animate-ping' : ''}"></span>
                        ${s.label}
                    </span>

                    <!-- Latência em ms (se online) -->
                    ${p.status === 'online' && p.latency_ms > 0 ? `
                        <span class="inline-flex items-center gap-1 text-[10px] font-mono text-slate-400 bg-dark-900/60 px-2 py-0.5 rounded border border-dark-700/60">
                            <i data-lucide="wifi" class="w-2.5 h-2.5 text-cyan-400"></i>
                            ${p.latency_ms}ms
                        </span>
                    ` : ''}

                    <!-- Filial Tag -->
                    <span class="text-[10px] font-semibold text-slate-300 bg-dark-700/80 px-2 py-0.5 rounded-md border border-dark-600/70 truncate max-w-[130px]" title="${p.branch}">
                        ${p.branch}
                    </span>
                </div>

                <!-- Brand Badge -->
                <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${brandClass}">
                    ${p.brand}
                </span>
            </div>

            <!-- Printer Title & Model -->
            <div class="mb-3">
                <h3 class="text-sm font-bold text-white group-hover:text-cyan-400 transition truncate" title="${p.name}">
                    ${p.name}
                </h3>
                <div class="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                    <span class="truncate font-medium text-slate-300" title="${p.model || ''}">${p.model || 'Modelo Padrão'}</span>
                    ${p.department ? `
                        <span class="text-slate-600">•</span>
                        <span class="text-slate-400 text-[11px] truncate" title="Setor: ${p.department}">
                            <i data-lucide="map-pin" class="w-3 h-3 inline mr-0.5 text-slate-500"></i>${p.department}
                        </span>
                    ` : ''}
                </div>
            </div>

            <!-- ==================== BLOCO LIMPO DE REDE (IP, DNS, GATEWAY) ==================== -->
            <!-- O usuário pediu especificamente: "quero conseguir ver o IP, DNS e gateway. de uma forma simples mas que nao atrapalhe as outras informações." -->
            <div class="network-info-box mb-3 space-y-1.5">
                
                <!-- Linha 1: IP com Botão de Copiar e Atalho Web EWS -->
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider w-12">IP:</span>
                        <span class="font-mono text-xs font-bold text-cyan-300">${p.ip}</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <!-- Copiar IP -->
                        <button onclick="copyToClipboard('${p.ip}', 'IP')" title="Copiar endereço IP" class="p-1 rounded text-slate-400 hover:text-white hover:bg-dark-700 transition">
                            <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                        </button>
                        <!-- Abrir Painel Web EWS -->
                        <a href="http://${p.ip}:${p.web_port || 80}" target="_blank" rel="noopener noreferrer" title="Abrir Painel Web da Impressora (EWS)" class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-dark-800 hover:bg-cyan-600 text-slate-300 hover:text-white border border-dark-600 transition flex items-center gap-1">
                            <i data-lucide="external-link" class="w-2.5 h-2.5"></i>
                            <span>Web</span>
                        </a>
                    </div>
                </div>

                <!-- Linha 2: DNS e Gateway -->
                <div class="grid grid-cols-2 gap-2 pt-1 border-t border-dark-700/50 text-[11px]">
                    <div class="flex items-center gap-1 truncate" title="DNS: ${p.dns || 'N/A'}">
                        <span class="text-[10px] font-semibold text-slate-400">DNS:</span>
                        <span class="font-mono text-slate-300 truncate text-[10.5px]">${dnsDisplay}</span>
                    </div>
                    <div class="flex items-center gap-1 truncate" title="Gateway: ${p.gateway || 'N/A'}">
                        <span class="text-[10px] font-semibold text-slate-400">GTW:</span>
                        <span class="font-mono text-slate-300 truncate text-[10.5px]">${gtwDisplay}</span>
                    </div>
                </div>

            </div>

            <!-- Dados Complementares de TI: NS, Toner e PIN -->
            <div class="grid grid-cols-2 gap-2 text-[11px] text-slate-400 mb-3 px-0.5">
                <div class="truncate" title="Série: ${p.serial_number || 'N/A'}">
                    <span class="text-slate-500 text-[10px] block font-medium">SÉRIE (NS)</span>
                    <span class="font-mono text-slate-300 font-medium">${p.serial_number || '<span class="text-slate-600 font-sans">N/A</span>'}</span>
                </div>
                <div class="truncate" title="Toner: ${p.toner_model || 'N/A'}">
                    <span class="text-slate-500 text-[10px] block font-medium">SUPRIMENTO</span>
                    <span class="text-slate-300 font-medium">${p.toner_model || '<span class="text-slate-600">Padrão</span>'}</span>
                </div>
            </div>

            <!-- PIN do Painel (se cadastrado) -->
            ${p.pin ? `
                <div class="mb-3 px-2 py-1 bg-dark-950/40 rounded-lg border border-dark-700/60 flex items-center justify-between text-[11px]">
                    <span class="text-[10px] text-slate-400 flex items-center gap-1">
                        <i data-lucide="lock" class="w-3 h-3 text-amber-400"></i>
                        PIN Painel:
                    </span>
                    <div class="flex items-center gap-1.5 font-mono">
                        <span id="pinText_${p.id}" class="text-slate-300">••••</span>
                        <button onclick="toggleCardPin(${p.id}, '${p.pin}')" class="text-slate-400 hover:text-white p-0.5">
                            <i data-lucide="eye" id="pinIcon_${p.id}" class="w-3 h-3"></i>
                        </button>
                    </div>
                </div>
            ` : ''}

        </div>

        <!-- Bottom Actions Row -->
        <div class="pt-3 border-t border-dark-700/70 flex items-center justify-between gap-1.5 card-actions-row">
            
            <!-- Botão Imprimir Teste -->
            <button onclick="openTestPrintModal(${p.id})" title="Enviar job de teste de rede via Socket RAW (Porta 9100)" class="flex-1 bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/30 px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-sm active:scale-95">
                <i data-lucide="printer-check" class="w-3.5 h-3.5"></i>
                <span>Imprimir Teste</span>
            </button>

            <!-- Testar Conexão Imediata -->
            <button onclick="recheckPrinterSingle(${p.id}, this)" title="Testar ping e porta agora" class="p-1.5 bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white rounded-lg transition border border-dark-600">
                <i data-lucide="refresh-cw" class="w-3.5 h-3.5 text-cyan-400"></i>
            </button>

            <!-- Editar Impressora -->
            ${canManage ? `
                <button onclick="openEditPrinterModal(${p.id})" title="Editar configurações" class="p-1.5 bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white rounded-lg transition border border-dark-600">
                    <i data-lucide="edit-3" class="w-3.5 h-3.5 text-slate-300"></i>
                </button>
            ` : ''}

        </div>

    </div>
    `;
}

function toggleCardPin(id, realPin) {
    const textSpan = document.getElementById(`pinText_${id}`);
    const icon = document.getElementById(`pinIcon_${id}`);
    if (textSpan.textContent === '••••') {
        textSpan.textContent = realPin;
        icon.setAttribute('data-lucide', 'eye-off');
    } else {
        textSpan.textContent = '••••';
        icon.setAttribute('data-lucide', 'eye');
    }
    lucide.createIcons();
}

// ==================== IMPRESSÃO DE TESTE DE REDE ====================
async function openTestPrintModal(printerId) {
    const p = printersData.find(x => x.id === printerId);
    if (!p) return;

    selectedPrinterForTest = p;
    document.getElementById('testPrintPrinterName').textContent = p.name;
    document.getElementById('testPrintBranch').textContent = p.branch;
    document.getElementById('testPrintIp').textContent = p.ip;
    document.getElementById('testPrintPort').textContent = `${p.port || 9100} (RAW)`;
    document.getElementById('testPrintModel').textContent = `${p.brand} - ${p.model || 'Padrão'}`;
    
    const statusSpan = document.getElementById('testPrintStatus');
    statusSpan.textContent = p.status.toUpperCase();
    statusSpan.className = p.status === 'online' ? 'text-emerald-400 font-semibold' : (p.status === 'warning' ? 'text-amber-400 font-semibold' : 'text-rose-400 font-semibold');

    // Selecionar radio de acordo com o tipo da impressora
    const typeRadios = document.getElementsByName('testPrintType');
    if (p.printer_type === 'thermal_label') {
        typeRadios.forEach(r => { if (r.value === 'zebra_zpl') r.checked = true; });
    } else if (p.printer_type === 'thermal_receipt') {
        typeRadios.forEach(r => { if (r.value === 'escpos') r.checked = true; });
    } else {
        typeRadios.forEach(r => { if (r.value === 'standard_network') r.checked = true; });
    }

    document.getElementById('testPrintCustomMsg').value = '';
    document.getElementById('testPrintFeedback').classList.add('hidden');

    // Carregar histórico de testes
    await loadTestPrintLogs(printerId);

    document.getElementById('testPrintModal').classList.remove('hidden');
    lucide.createIcons();
}

function closeTestPrintModal() {
    document.getElementById('testPrintModal').classList.add('hidden');
    selectedPrinterForTest = null;
}

async function loadTestPrintLogs(printerId) {
    const container = document.getElementById('testPrintHistoryList');
    try {
        const res = await fetch(`/api/printers/${printerId}/test-logs`);
        if (!res.ok) return;
        const logs = await res.json();

        if (logs.length === 0) {
            container.innerHTML = '<p class="text-slate-500 text-center py-2">Nenhum teste recente registrado para esta impressora.</p>';
            return;
        }

        container.innerHTML = logs.map(l => `
            <div class="flex items-center justify-between p-1.5 bg-dark-900/60 rounded border border-dark-800">
                <div class="flex items-center gap-1.5 truncate">
                    <span class="w-1.5 h-1.5 rounded-full ${l.status === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
                    <span class="text-slate-300 truncate">${l.message}</span>
                </div>
                <span class="text-[10px] text-slate-500 flex-shrink-0 ml-2">${l.created_at.split(' ')[1]}</span>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<p class="text-rose-400 text-center py-1">Erro ao carregar histórico.</p>';
    }
}

async function sendTestPrintNow() {
    if (!selectedPrinterForTest) return;

    const btn = document.getElementById('btnExecuteTestPrint');
    const btnText = document.getElementById('btnExecuteTestPrintText');
    const feedback = document.getElementById('testPrintFeedback');
    const feedbackTitle = document.getElementById('testPrintFeedbackTitle');
    const feedbackMsg = document.getElementById('testPrintFeedbackMsg');
    const feedbackIcon = document.getElementById('testPrintFeedbackIcon');

    const selectedType = document.querySelector('input[name="testPrintType"]:checked')?.value || 'standard_network';
    const customMsg = document.getElementById('testPrintCustomMsg').value.trim();

    btn.disabled = true;
    btnText.textContent = "Conectando ao Socket 9100...";

    try {
        const res = await fetch(`/api/printers/${selectedPrinterForTest.id}/test-print`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                test_type: selectedType,
                custom_message: customMsg
            })
        });

        const result = await res.json();

        feedback.classList.remove('hidden');
        if (result.success) {
            feedback.className = "p-3.5 rounded-xl text-xs flex items-start gap-2.5 border bg-emerald-950/30 border-emerald-500/40 text-emerald-300";
            feedbackTitle.textContent = "Impressão Enviada com Sucesso!";
            feedbackMsg.textContent = result.message;
            feedbackIcon.setAttribute('data-lucide', 'check-circle');
            showToast(`Teste enviado para ${selectedPrinterForTest.name}!`, 'success');
        } else {
            feedback.className = "p-3.5 rounded-xl text-xs flex items-start gap-2.5 border bg-rose-950/30 border-rose-500/40 text-rose-300";
            feedbackTitle.textContent = "Falha no Envio via Rede";
            feedbackMsg.textContent = result.message;
            feedbackIcon.setAttribute('data-lucide', 'alert-circle');
            showToast(`Falha ao imprimir teste em ${selectedPrinterForTest.name}`, 'error');
        }
        lucide.createIcons();

        // Recarregar logs do modal
        await loadTestPrintLogs(selectedPrinterForTest.id);
        // Atualizar lista principal
        await fetchPrinters();

    } catch (e) {
        feedback.classList.remove('hidden');
        feedback.className = "p-3.5 rounded-xl text-xs flex items-start gap-2.5 border bg-rose-950/30 border-rose-500/40 text-rose-300";
        feedbackTitle.textContent = "Erro de Conexão";
        feedbackMsg.textContent = e.message || 'Falha ao comunicar com o servidor.';
    } finally {
        btn.disabled = false;
        btnText.textContent = "Enviar Teste Agora";
    }
}

function printBrowserTestSheet() {
    if (!selectedPrinterForTest) return;
    const p = selectedPrinterForTest;
    const nowStr = new Date().toLocaleString('pt-BR');

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Página de Teste - ${p.name}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 40px; color: #111; }
                .header { border-bottom: 3px solid #0891b2; padding-bottom: 15px; margin-bottom: 20px; }
                h1 { margin: 0; font-size: 22px; color: #0891b2; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
                .box { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; }
                .label { font-size: 11px; color: #64748b; font-weight: bold; text-transform: uppercase; }
                .val { font-size: 14px; font-weight: bold; margin-top: 3px; font-family: monospace; }
                .footer { margin-top: 40px; border-top: 1px solid #cbd5e1; padding-top: 15px; font-size: 11px; color: #64748b; text-align: center; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>PRINT SENTINEL - PÁGINA DE TESTE DE REDE</h1>
                <p style="margin: 5px 0 0 0; font-size: 12px; color: #475569;">Disparo de Diagnóstico Técnico de Infraestrutura e TI</p>
            </div>
            <div class="grid">
                <div class="box">
                    <div class="label">Nome da Impressora</div>
                    <div class="val">${p.name}</div>
                </div>
                <div class="box">
                    <div class="label">Filial / Unidade</div>
                    <div class="val">${p.branch}</div>
                </div>
                <div class="box">
                    <div class="label">Endereço IP na Rede</div>
                    <div class="val">${p.ip}</div>
                </div>
                <div class="box">
                    <div class="label">Porta de Impressão</div>
                    <div class="val">${p.port || 9100} TCP (JetDirect)</div>
                </div>
                <div class="box">
                    <div class="label">Servidor DNS</div>
                    <div class="val">${p.dns || 'Não informado'}</div>
                </div>
                <div class="box">
                    <div class="label">Gateway Padrão</div>
                    <div class="val">${p.gateway || 'Não informado'}</div>
                </div>
                <div class="box">
                    <div class="label">Fabricante & Modelo</div>
                    <div class="val">${p.brand} - ${p.model || 'Padrão'}</div>
                </div>
                <div class="box">
                    <div class="label">Número de Série (NS)</div>
                    <div class="val">${p.serial_number || 'Não informado'}</div>
                </div>
            </div>
            <div class="box" style="margin-bottom: 20px;">
                <div class="label">Resultado do Teste</div>
                <div style="margin-top: 5px; font-size: 13px;">Comunicação estabelecida com sucesso. Folha gerada em ${nowStr} por ${currentUser?.full_name || currentUser?.username}.</div>
            </div>
            <div class="footer">
                Print Sentinel 2026 - Departamento de Tecnologia da Informação
            </div>
            <script>
                window.onload = function() { window.print(); }
            </script>
        </body>
        </html>
    `);
    printWindow.document.close();
}

// ==================== RECHECAR IMPRESSORA INDIVIDUAL ====================
async function recheckPrinterSingle(printerId, btnElement) {
    const icon = btnElement.querySelector('i');
    if (icon) icon.classList.add('animate-spin');

    try {
        const res = await fetch(`/api/printers/${printerId}/check`, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, data.status === 'online' ? 'success' : 'warning');
        await fetchPrinters();
    } catch (e) {
        showToast('Erro ao verificar impressora.', 'error');
    } finally {
        if (icon) icon.classList.remove('animate-spin');
    }
}

async function triggerCheckAll() {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('animate-spin');

    try {
        const res = await fetch('/api/printers/check-all', { method: 'POST' });
        const data = await res.json();
        showToast(data.message, 'info');
    } catch (e) {
        showToast('Falha ao iniciar varredura geral.', 'error');
    } finally {
        setTimeout(() => {
            if (icon) icon.classList.remove('animate-spin');
        }, 1200);
    }
}

// ==================== CADASTRO / EDIÇÃO DE IMPRESSORA ====================
function openPrinterModal() {
    currentEditingPrinterId = null;
    document.getElementById('printerModalTitle').textContent = "Nova Impressora";
    document.getElementById('formPrinterId').value = "";
    document.getElementById('printerForm').reset();
    document.getElementById('formPort').value = 9100;
    document.getElementById('formWebPort').value = 80;
    document.getElementById('formSubnetMask').value = "255.255.255.0";
    document.getElementById('btnDeletePrinter').classList.add('hidden');
    document.getElementById('btnSavePrinterText').textContent = "Cadastrar Impressora";

    switchPrinterTab('tab-general');
    document.getElementById('printerModal').classList.remove('hidden');
    lucide.createIcons();
}

function openEditPrinterModal(printerId) {
    const p = printersData.find(x => x.id === printerId);
    if (!p) return;

    currentEditingPrinterId = printerId;
    document.getElementById('printerModalTitle').textContent = `Editar Impressora: ${p.name}`;
    document.getElementById('formPrinterId').value = p.id;
    
    // Preencher campos
    document.getElementById('formName').value = p.name || '';
    document.getElementById('formBranch').value = p.branch || 'Matriz';
    document.getElementById('formDepartment').value = p.department || '';
    document.getElementById('formBrand').value = p.brand || 'HP';
    document.getElementById('formModel').value = p.model || '';
    document.getElementById('formPrinterType').value = p.printer_type || 'laser_mono';
    document.getElementById('formSerialNumber').value = p.serial_number || '';
    
    document.getElementById('formIp').value = p.ip || '';
    document.getElementById('formDns').value = p.dns || '';
    document.getElementById('formGateway').value = p.gateway || '';
    document.getElementById('formSubnetMask').value = p.subnet_mask || '255.255.255.0';
    document.getElementById('formMacAddress').value = p.mac_address || '';
    document.getElementById('formPort').value = p.port || 9100;
    document.getElementById('formWebPort').value = p.web_port || 80;

    document.getElementById('formTonerModel').value = p.toner_model || '';
    document.getElementById('formPin').value = p.pin || '';
    document.getElementById('formOwnership').value = p.ownership || 'propria';
    document.getElementById('formVendorContact').value = p.vendor_contact || '';
    document.getElementById('formNotes').value = p.notes || '';

    // Botão de exclusão (apenas para admin)
    if (currentUser && currentUser.role === 'admin') {
        document.getElementById('btnDeletePrinter').classList.remove('hidden');
    } else {
        document.getElementById('btnDeletePrinter').classList.add('hidden');
    }

    document.getElementById('btnSavePrinterText').textContent = "Atualizar Impressora";

    switchPrinterTab('tab-general');
    document.getElementById('printerModal').classList.remove('hidden');
    lucide.createIcons();
}

function closePrinterModal() {
    document.getElementById('printerModal').classList.add('hidden');
    currentEditingPrinterId = null;
}

function switchPrinterTab(tabId) {
    document.getElementById('tab-general').classList.add('hidden');
    document.getElementById('tab-network').classList.add('hidden');
    document.getElementById('tab-supplies').classList.add('hidden');

    document.getElementById('btnTabGeneral').className = "px-4 py-2.5 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-1.5";
    document.getElementById('btnTabNetwork').className = "px-4 py-2.5 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-1.5";
    document.getElementById('btnTabSupplies').className = "px-4 py-2.5 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-1.5";

    document.getElementById(tabId).classList.remove('hidden');

    const activeClass = "px-4 py-2.5 font-semibold text-cyan-400 border-b-2 border-cyan-400 flex items-center gap-1.5";
    if (tabId === 'tab-general') document.getElementById('btnTabGeneral').className = activeClass;
    if (tabId === 'tab-network') document.getElementById('btnTabNetwork').className = activeClass;
    if (tabId === 'tab-supplies') document.getElementById('btnTabSupplies').className = activeClass;

    lucide.createIcons();
}

function toggleFormPinVisibility() {
    const pinInput = document.getElementById('formPin');
    const eye = document.getElementById('formPinEye');
    if (pinInput.type === 'password') {
        pinInput.type = 'text';
        eye.setAttribute('data-lucide', 'eye-off');
    } else {
        pinInput.type = 'password';
        eye.setAttribute('data-lucide', 'eye');
    }
    lucide.createIcons();
}

async function handleSavePrinter(e) {
    e.preventDefault();
    const btn = document.getElementById('btnSavePrinterSubmit');
    const btnText = document.getElementById('btnSavePrinterText');

    const payload = {
        name: document.getElementById('formName').value.trim(),
        branch: document.getElementById('formBranch').value.trim(),
        department: document.getElementById('formDepartment').value.trim(),
        brand: document.getElementById('formBrand').value,
        model: document.getElementById('formModel').value.trim(),
        printer_type: document.getElementById('formPrinterType').value,
        serial_number: document.getElementById('formSerialNumber').value.trim(),
        ip: document.getElementById('formIp').value.trim(),
        dns: document.getElementById('formDns').value.trim(),
        gateway: document.getElementById('formGateway').value.trim(),
        subnet_mask: document.getElementById('formSubnetMask').value.trim(),
        mac_address: document.getElementById('formMacAddress').value.trim(),
        port: parseInt(document.getElementById('formPort').value) || 9100,
        web_port: parseInt(document.getElementById('formWebPort').value) || 80,
        toner_model: document.getElementById('formTonerModel').value.trim(),
        pin: document.getElementById('formPin').value.trim(),
        ownership: document.getElementById('formOwnership').value,
        vendor_contact: document.getElementById('formVendorContact').value.trim(),
        notes: document.getElementById('formNotes').value.trim()
    };

    btn.disabled = true;
    btnText.textContent = "Salvando...";

    try {
        let res;
        if (currentEditingPrinterId) {
            res = await fetch(`/api/printers/${currentEditingPrinterId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            res = await fetch('/api/printers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Falha ao salvar impressora.');
        }

        showToast(currentEditingPrinterId ? 'Impressora atualizada!' : 'Impressora cadastrada!', 'success');
        closePrinterModal();
        await loadInitialData();

    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = currentEditingPrinterId ? "Atualizar Impressora" : "Salvar Impressora";
    }
}

async function deleteCurrentPrinter() {
    if (!currentEditingPrinterId) return;
    if (!confirm('Tem certeza de que deseja excluir esta impressora do monitoramento?')) {
        return;
    }

    try {
        const res = await fetch(`/api/printers/${currentEditingPrinterId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha ao excluir.');

        showToast('Impressora excluída com sucesso.', 'info');
        closePrinterModal();
        await loadInitialData();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ==================== IMPORTAÇÃO DE PLANILHA ====================
function openImportModal() {
    document.getElementById('importResultAlert').classList.add('hidden');
    document.getElementById('selectedFileName').classList.add('hidden');
    document.getElementById('btnUploadManual').disabled = true;
    selectedUploadFile = null;
    document.getElementById('importModal').classList.remove('hidden');
    lucide.createIcons();
}

function closeImportModal() {
    document.getElementById('importModal').classList.add('hidden');
}

function handleFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    selectedUploadFile = file;
    const nameLabel = document.getElementById('selectedFileName');
    nameLabel.textContent = `Arquivo selecionado: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    nameLabel.classList.remove('hidden');
    document.getElementById('btnUploadManual').disabled = false;
}

async function uploadSelectedFile() {
    if (!selectedUploadFile) return;

    const btn = document.getElementById('btnUploadManual');
    const resultAlert = document.getElementById('importResultAlert');
    const resultTitle = document.getElementById('importResultTitle');
    const resultMsg = document.getElementById('importResultMsg');

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Processando...';
    lucide.createIcons();

    const formData = new FormData();
    formData.append('file', selectedUploadFile);

    try {
        const res = await fetch('/api/import/file', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha no processamento.');

        resultAlert.className = "p-3.5 rounded-xl border bg-emerald-950/30 border-emerald-500/40 text-emerald-300 text-xs";
        resultTitle.textContent = "Importação Concluída com Sucesso!";
        resultMsg.textContent = `${data.inserted} impressoras novas cadastradas, ${data.updated} atualizadas. (Total processado: ${data.total})`;
        resultAlert.classList.remove('hidden');

        showToast(`Importação finalizada: ${data.inserted} novos, ${data.updated} atualizados!`, 'success');
        await loadInitialData();

    } catch (e) {
        resultAlert.className = "p-3.5 rounded-xl border bg-rose-950/30 border-rose-500/40 text-rose-300 text-xs";
        resultTitle.textContent = "Erro na Importação";
        resultMsg.textContent = e.message;
        resultAlert.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> Processar Arquivo';
        lucide.createIcons();
    }
}

async function importLocalDocumentsSheet() {
    const btn = document.getElementById('btnQuickImport');
    const btnText = document.getElementById('btnQuickImportText');
    const resultAlert = document.getElementById('importResultAlert');
    const resultTitle = document.getElementById('importResultTitle');
    const resultMsg = document.getElementById('importResultMsg');

    btn.disabled = true;
    btnText.textContent = "Lendo planilha local da pasta Documents...";

    try {
        const res = await fetch('/api/import/quick-local-sheet', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha ao importar planilha local.');

        resultAlert.className = "p-3.5 rounded-xl border bg-emerald-950/30 border-emerald-500/40 text-emerald-300 text-xs";
        resultTitle.textContent = "Planilha Importada com Sucesso!";
        resultMsg.textContent = `Arquivo 'Planilha impressoras IP Ns e pin.xlsx': ${data.inserted} novas impressoras cadastradas e ${data.updated} atualizadas com sucesso!`;
        resultAlert.classList.remove('hidden');

        showToast(`Planilha local importada: ${data.inserted} inseridas, ${data.updated} atualizadas!`, 'success');
        await loadInitialData();

    } catch (e) {
        resultAlert.className = "p-3.5 rounded-xl border bg-rose-950/30 border-rose-500/40 text-rose-300 text-xs";
        resultTitle.textContent = "Falha ao Ler Arquivo Local";
        resultMsg.textContent = e.message;
        resultAlert.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btnText.textContent = "Importar Planilha Local em 1 Clique";
    }
}

// ==================== EXPORTAÇÃO CSV ====================
function exportCurrentViewCsv() {
    const branchParam = activeFilters.branch !== 'Todas' ? `?branch=${encodeURIComponent(activeFilters.branch)}` : '';
    window.location.href = `/api/export/csv${branchParam}`;
    showToast('Download da planilha de inventário iniciado.', 'info');
}

// ==================== PAINEL ADMIN E USUÁRIOS ====================
async function openAdminModal() {
    switchAdminTab('admin-tab-users');
    document.getElementById('adminModal').classList.remove('hidden');
    lucide.createIcons();
    await loadUsersList();
    await loadAuditLogs();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.add('hidden');
}

function switchAdminTab(tabId) {
    document.getElementById('admin-tab-users').classList.add('hidden');
    document.getElementById('admin-tab-audit').classList.add('hidden');

    document.getElementById('btnAdminTabUsers').className = "px-4 py-2.5 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-1.5";
    document.getElementById('btnAdminTabAudit').className = "px-4 py-2.5 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-1.5";

    document.getElementById(tabId).classList.remove('hidden');

    const activeClass = "px-4 py-2.5 font-semibold text-indigo-400 border-b-2 border-indigo-400 flex items-center gap-1.5";
    if (tabId === 'admin-tab-users') document.getElementById('btnAdminTabUsers').className = activeClass;
    if (tabId === 'admin-tab-audit') document.getElementById('btnAdminTabAudit').className = activeClass;

    lucide.createIcons();
}

async function loadUsersList() {
    const tbody = document.getElementById('usersTableBody');
    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) return;
        const users = await res.json();

        const moduleBadges = {
            'all': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">Todos</span>',
            'cftv': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">CFTV</span>',
            'printers': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Impressoras</span>'
        };

        tbody.innerHTML = users.map(u => `
            <tr class="hover:bg-dark-800/40">
                <td class="p-2.5 font-medium text-white">${u.full_name}</td>
                <td class="p-2.5 font-mono text-slate-300">${u.username}</td>
                <td class="p-2.5"><span class="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-dark-800 text-indigo-400 border border-indigo-500/20">${u.role}</span></td>
                <td class="p-2.5">${moduleBadges[u.allowed_modules] || u.allowed_modules || '<span class="text-slate-500">Todos</span>'}</td>
                <td class="p-2.5">${u.is_active ? '<span class="text-emerald-400">Ativo</span>' : '<span class="text-rose-400">Inativo</span>'}</td>
                <td class="p-2.5 text-slate-400 font-mono">${u.last_login || 'Nunca'}</td>
                <td class="p-2.5 text-right">
                    ${u.id !== currentUser.id ? `
                        <button onclick="deleteUserPrompt(${u.id}, '${u.username}')" class="text-rose-400 hover:text-rose-300 p-1" title="Excluir Usuário">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    ` : '<span class="text-[10px] text-slate-500 italic">Sua conta</span>'}
                </td>
            </tr>
        `).join('');
        lucide.createIcons();
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-3 text-center text-rose-400">Falha ao carregar usuários.</td></tr>';
    }
}

function openCreateUserForm() {
    document.getElementById('newUserForm').classList.remove('hidden');
}

function closeCreateUserForm() {
    document.getElementById('newUserForm').classList.add('hidden');
    document.getElementById('newUserForm').reset();
}

async function handleCreateUser(e) {
    e.preventDefault();
    const fullName = document.getElementById('newFullName').value.trim();
    const username = document.getElementById('newUsername').value.trim();
    const role = document.getElementById('newRole').value;
    const allowedModules = document.getElementById('newAllowedModules') ? document.getElementById('newAllowedModules').value : 'all';
    const password = document.getElementById('newPassword').value;

    try {
        const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name: fullName, username, role, allowed_modules: allowedModules, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha ao criar usuário.');

        showToast('Usuário cadastrado com sucesso!', 'success');
        closeCreateUserForm();
        await loadUsersList();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteUserPrompt(userId, username) {
    if (!confirm(`Tem certeza de que deseja excluir o usuário '${username}'?`)) return;

    try {
        const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha ao excluir.');
        showToast('Usuário excluído.', 'info');
        await loadUsersList();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loadAuditLogs(search = '') {
    const tbody = document.getElementById('auditTableBody');
    try {
        const url = `/api/admin/audit-logs?limit=80${search ? `&search=${encodeURIComponent(search)}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const logs = await res.json();

        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum registro de auditoria encontrado.</td></tr>';
            return;
        }

        tbody.innerHTML = logs.map(l => `
            <tr class="hover:bg-dark-800/40">
                <td class="p-2.5 text-slate-400 whitespace-nowrap">${l.created_at}</td>
                <td class="p-2.5 font-bold text-slate-200">${l.username}</td>
                <td class="p-2.5 text-indigo-300 font-semibold">${l.action}</td>
                <td class="p-2.5 text-slate-300 max-w-xs truncate" title="${l.details || ''}">${l.details || '-'}</td>
                <td class="p-2.5 text-slate-500">${l.ip_address || '-'}</td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-3 text-center text-rose-400">Erro ao carregar auditoria.</td></tr>';
    }
}

function exportAuditLogsCsv() {
    window.location.href = '/api/admin/audit-logs/export';
    showToast('Download dos logs de auditoria iniciado.', 'info');
}

// ==================== ALTERAR SENHA DO USUÁRIO ATUAL ====================
function openChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.remove('hidden');
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('confirmNewPasswordInput').value = '';
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.add('hidden');
}

async function handleChangePassword(e) {
    e.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmNew = document.getElementById('confirmNewPasswordInput').value;

    if (newPassword !== confirmNew) {
        showToast('A nova senha e a confirmação não coincidem.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Falha ao alterar senha.');

        showToast('Sua senha foi alterada com sucesso!', 'success');
        closeChangePasswordModal();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ==================== UTILITÁRIOS: CLIPBOARD, SOM E KIOSK ====================
function copyToClipboard(text, label = 'Texto') {
    navigator.clipboard.writeText(text).then(() => {
        showToast(`${label} copiado: ${text}`, 'info');
    }).catch(() => {
        showToast(`Não foi possível copiar ${label}.`, 'error');
    });
}

function initClock() {
    const update = () => {
        const now = new Date();
        const str = now.toLocaleTimeString('pt-BR');
        const clockEl = document.getElementById('currentClock');
        if (clockEl) clockEl.textContent = str;
    };
    update();
    setInterval(update, 1000);
}

function initSoundSettings() {
    updateSoundUI();
}

function toggleSoundAlert() {
    isSoundEnabled = !isSoundEnabled;
    localStorage.setItem('print_sound_enabled', isSoundEnabled);
    updateSoundUI();
    if (isSoundEnabled) {
        playDropSound();
        showToast('Alarme sonoro ativado.', 'info');
    } else {
        showToast('Alarme sonoro desativado.', 'warning');
    }
}

function updateSoundUI() {
    const icon = document.getElementById('soundIcon');
    const text = document.getElementById('soundText');
    if (isSoundEnabled) {
        icon.className = "w-4 h-4 text-emerald-400";
        icon.setAttribute('data-lucide', 'volume-2');
        text.textContent = "Som Ativo";
    } else {
        icon.className = "w-4 h-4 text-slate-500";
        icon.setAttribute('data-lucide', 'volume-x');
        text.textContent = "Mudo";
    }
    lucide.createIcons();
}

function playDropSound() {
    if (!isSoundEnabled) return;
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();

        // Tom 1: 520Hz
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(520, ctx.currentTime);
        gain1.gain.setValueAtTime(0.15, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.2);

        // Tom 2: 380Hz
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(380, ctx.currentTime + 0.22);
        gain2.gain.setValueAtTime(0.18, ctx.currentTime + 0.22);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(ctx.currentTime + 0.22);
        osc2.stop(ctx.currentTime + 0.5);

    } catch (e) {
        console.log('Web Audio não suportado ou bloqueado pelo navegador.');
    }
}

function toggleKioskMode() {
    document.body.classList.toggle('kiosk-mode');
    if (document.body.classList.contains('kiosk-mode')) {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
        showToast('Modo Telão ativado. Pressione ESC para sair.', 'info');
    } else {
        if (document.exitFullscreen && document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('kiosk-mode')) {
        toggleKioskMode();
    }
});

// ==================== SISTEMA DE TOASTS ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    const borderMap = {
        'success': 'border-emerald-500/40 bg-dark-900/95 text-emerald-300',
        'error': 'border-rose-500/40 bg-dark-900/95 text-rose-300',
        'warning': 'border-amber-500/40 bg-dark-900/95 text-amber-300',
        'info': 'border-cyan-500/40 bg-dark-900/95 text-cyan-300'
    };
    const iconMap = {
        'success': 'check-circle',
        'error': 'alert-triangle',
        'warning': 'alert-circle',
        'info': 'info'
    };

    toast.className = `p-3 rounded-xl border ${borderMap[type] || borderMap.info} shadow-2xl backdrop-blur flex items-center gap-2.5 text-xs pointer-events-auto transition-all duration-300 transform translate-y-2 opacity-0`;
    toast.innerHTML = `
        <i data-lucide="${iconMap[type] || 'info'}" class="w-4 h-4 flex-shrink-0"></i>
        <span class="flex-1 font-medium text-slate-100">${message}</span>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
    }, 10);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}
