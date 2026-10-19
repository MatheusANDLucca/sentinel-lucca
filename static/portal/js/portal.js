/**
 * Sentinel Lucca - Lógica do Portal Central e Hub de Módulos
 */

let currentUser = null;
let currentSummary = null;
let usersList = [];
let ws = null;

document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    const ok = await checkAuth();
    if (!ok) return;

    await loadSummary();
    initWebSocket();
    lucide.createIcons();

    // Atualização periódica a cada 15 segundos
    setInterval(loadSummary, 15000);
});

function initClock() {
    const clockEl = document.getElementById('liveClock');
    function update() {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('pt-BR');
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
        const res = await fetch('/api/auth/me', {
            headers: getAuthHeaders(false)
        });

        if (!res.ok) {
            throw new Error('Não autenticado');
        }

        currentUser = await res.json();
        updateUserUI();
        return true;
    } catch (e) {
        localStorage.removeItem('sentinel_token');
        localStorage.removeItem('cftv_token');
        localStorage.removeItem('print_token');
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
    document.getElementById('headerUserRole').textContent = `Perfil: ${currentUser.role.toUpperCase()}`;

    // Módulos
    let modText = "Todos os Módulos";
    if (currentUser.allowed_modules === "cftv") modText = "Apenas CFTV Sentinel";
    if (currentUser.allowed_modules === "printers") modText = "Apenas Print Sentinel";
    document.getElementById('dropModules').textContent = `Acesso: ${modText}`;

    // Avatar
    const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
    document.getElementById('userAvatar').textContent = initials;

    // Botão de admin
    if (currentUser.role === 'admin') {
        const adminBtn = document.getElementById('adminPanelBtn');
        adminBtn.classList.remove('hidden');
        adminBtn.classList.add('flex');
    }
}

function toggleUserDropdown() {
    const drop = document.getElementById('userDropdown');
    drop.classList.toggle('hidden');
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
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: getAuthHeaders(false)
        });
    } catch (e) {
        console.error('Logout request error:', e);
    }
    localStorage.clear();
    window.location.href = '/login.html';
}

function navigateTo(url) {
    window.location.href = url;
}

// ==================== CARREGAR RESUMO DOS MÓDULOS ====================

async function loadSummary() {
    try {
        const res = await fetch('/api/portal/summary', {
            headers: getAuthHeaders(false)
        });
        if (res.status === 401 || res.status === 403) {
            console.warn('Sessão expirada no Portal Central. Redirecionando para login...');
            localStorage.removeItem('sentinel_token');
            localStorage.removeItem('cftv_token');
            localStorage.removeItem('print_token');
            window.location.href = '/login.html';
            return;
        }
        if (!res.ok) return;

        currentSummary = await res.json();
        renderSummaryUI();
    } catch (e) {
        console.error('Erro ao carregar resumo do portal:', e);
    }
}

function renderSummaryUI() {
    if (!currentSummary) return;

    const { cftv, printers } = currentSummary;

    // 1. CARD CFTV
    const cftvCard = document.getElementById('cftvCard');
    const cftvBadge = document.getElementById('cftvStatusBadge');
    const cftvBtn = document.getElementById('cftvActionBtn');

    if (cftv.has_access) {
        cftvCard.classList.remove('locked');
        document.getElementById('cftvTotal').textContent = cftv.total;
        document.getElementById('cftvOnline').textContent = cftv.online;
        document.getElementById('cftvOffline').textContent = cftv.offline;

        cftvBadge.className = "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-1.5";
        cftvBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>${cftv.online}/${cftv.total} Online (${cftv.sla}%)</span>`;

        cftvBtn.disabled = false;
        cftvBtn.className = "w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold py-3 px-5 rounded-2xl shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-2 group-hover:gap-3 cursor-pointer";
        cftvBtn.innerHTML = `<span>Acessar CFTV Sentinel</span><i data-lucide="arrow-right" class="w-4 h-4"></i>`;
    } else {
        cftvCard.classList.add('locked');
        document.getElementById('cftvTotal').textContent = "-";
        document.getElementById('cftvOnline').textContent = "-";
        document.getElementById('cftvOffline').textContent = "-";

        cftvBadge.className = "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center gap-1.5";
        cftvBadge.innerHTML = `<i data-lucide="lock" class="w-3.5 h-3.5"></i><span>Acesso Restrito</span>`;

        cftvBtn.disabled = true;
        cftvBtn.className = "w-full bg-dark-800 text-slate-500 font-semibold py-3 px-5 rounded-2xl border border-white/5 transition flex items-center justify-center gap-2 cursor-not-allowed";
        cftvBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i><span>Módulo não permitido</span>`;
    }

    // 2. CARD IMPRESSORAS
    const printCard = document.getElementById('printersCard');
    const printBadge = document.getElementById('printersStatusBadge');
    const printBtn = document.getElementById('printersActionBtn');

    if (printers.has_access) {
        printCard.classList.remove('locked');
        document.getElementById('printersTotal').textContent = printers.total;
        document.getElementById('printersOnline').textContent = printers.online;
        document.getElementById('printersBranches').textContent = printers.branches;

        printBadge.className = "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 flex items-center gap-1.5";
        printBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span><span>${printers.online}/${printers.total} Online (${printers.sla}%)</span>`;

        printBtn.disabled = false;
        printBtn.className = "w-full bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-500 hover:to-teal-500 text-white font-semibold py-3 px-5 rounded-2xl shadow-lg shadow-cyan-600/30 transition flex items-center justify-center gap-2 group-hover:gap-3 cursor-pointer";
        printBtn.innerHTML = `<span>Acessar Print Sentinel</span><i data-lucide="arrow-right" class="w-4 h-4"></i>`;
    } else {
        printCard.classList.add('locked');
        document.getElementById('printersTotal').textContent = "-";
        document.getElementById('printersOnline').textContent = "-";
        document.getElementById('printersBranches').textContent = "-";

        printBadge.className = "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center gap-1.5";
        printBadge.innerHTML = `<i data-lucide="lock" class="w-3.5 h-3.5"></i><span>Acesso Restrito</span>`;

        printBtn.disabled = true;
        printBtn.className = "w-full bg-dark-800 text-slate-500 font-semibold py-3 px-5 rounded-2xl border border-white/5 transition flex items-center justify-center gap-2 cursor-not-allowed";
        printBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i><span>Módulo não permitido</span>`;
    }

    lucide.createIcons();
}

// ==================== WEBSOCKET ====================

function initWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket Portal conectado.');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'BATCH_STATUS_UPDATE' || data.type === 'CYCLE_COMPLETED' || data.type === 'RECORDER_ALERT' || data.type === 'PRINTER_STATUS_CHANGED') {
                loadSummary();
            }
        } catch (e) {}
    };

    ws.onclose = () => {
        setTimeout(initWebSocket, 4000);
    };
}

// ==================== PAINEL DE ADMINISTRAÇÃO ====================

function openAdminModal() {
    const modal = document.getElementById('adminModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    switchAdminTab('users');
    lucide.createIcons();
}

function closeAdminModal() {
    const modal = document.getElementById('adminModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function switchAdminTab(tab) {
    const tabs = ['users', 'audit', 'backup'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const content = document.getElementById(`tabContent${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (t === tab) {
            btn.className = "px-4 py-2 rounded-xl text-xs font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 transition";
            content.classList.remove('hidden');
        } else {
            btn.className = "px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-white/5 transition";
            content.classList.add('hidden');
        }
    });

    if (tab === 'users') loadUsers();
    if (tab === 'audit') loadAuditLogs();
}

async function loadUsers() {
    try {
        const res = await fetch('/api/admin/users', { headers: getAuthHeaders(false) });
        if (!res.ok) throw new Error('Falha ao listar usuários');
        usersList = await res.json();

        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = '';

        usersList.forEach(u => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-white/5 transition";

            // Formatação do badge de Módulos Permitidos
            let modBadge = '<span class="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">🌟 Todos os Módulos</span>';
            if (u.allowed_modules === 'cftv') {
                modBadge = '<span class="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">📹 Apenas CFTV</span>';
            } else if (u.allowed_modules === 'printers') {
                modBadge = '<span class="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">🖨️ Apenas Impressoras</span>';
            }

            const statusBadge = u.is_active
                ? '<span class="text-emerald-400 flex items-center gap-1 font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Ativo</span>'
                : '<span class="text-rose-400 flex items-center gap-1 font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>Inativo</span>';

            tr.innerHTML = `
                <td class="py-3 px-4 font-semibold text-white">${u.full_name}</td>
                <td class="py-3 px-4 font-mono text-slate-400">@${u.username}</td>
                <td class="py-3 px-4">
                    <span class="px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${u.role === 'admin' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-300'}">
                        ${u.role}
                    </span>
                </td>
                <td class="py-3 px-4">${modBadge}</td>
                <td class="py-3 px-4">${statusBadge}</td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1.5">
                        <button onclick="editUser(${u.id})" title="Editar Usuário" class="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-white/5 rounded-lg transition">
                            <i data-lucide="edit" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="promptResetPassword(${u.id}, '${u.username}')" title="Redefinir Senha" class="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-white/5 rounded-lg transition">
                            <i data-lucide="key" class="w-3.5 h-3.5"></i>
                        </button>
                        ${u.id !== currentUser.id ? `
                        <button onclick="confirmDeleteUser(${u.id}, '${u.username}')" title="Excluir Usuário" class="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-white/5 rounded-lg transition">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                        ` : ''}
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        lucide.createIcons();
    } catch (e) {
        console.error(e);
    }
}

function openUserCreateModal() {
    document.getElementById('editUserId').value = '';
    document.getElementById('userModalTitle').textContent = 'Novo Usuário';
    document.getElementById('formFullName').value = '';
    document.getElementById('formUsername').value = '';
    document.getElementById('formUsername').disabled = false;
    document.getElementById('formPassword').value = '';
    document.getElementById('formPassword').required = true;
    document.getElementById('pwdGroup').classList.remove('hidden');
    document.getElementById('formRole').value = 'operador';
    document.getElementById('formActive').value = '1';
    document.getElementById('formAllowedModules').value = 'all';

    const modal = document.getElementById('userFormModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function editUser(userId) {
    const user = usersList.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('editUserId').value = user.id;
    document.getElementById('userModalTitle').textContent = `Editar Usuário: @${user.username}`;
    document.getElementById('formFullName').value = user.full_name;
    document.getElementById('formUsername').value = user.username;
    document.getElementById('formUsername').disabled = true;
    document.getElementById('formPassword').value = '';
    document.getElementById('formPassword').required = false;
    document.getElementById('pwdGroup').classList.add('hidden');
    document.getElementById('formRole').value = user.role;
    document.getElementById('formActive').value = user.is_active ? '1' : '0';
    document.getElementById('formAllowedModules').value = user.allowed_modules || 'all';

    const modal = document.getElementById('userFormModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeUserFormModal() {
    const modal = document.getElementById('userFormModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function saveUser(e) {
    e.preventDefault();
    const editId = document.getElementById('editUserId').value;
    const full_name = document.getElementById('formFullName').value.trim();
    const username = document.getElementById('formUsername').value.trim();
    const role = document.getElementById('formRole').value;
    const is_active = document.getElementById('formActive').value === '1';
    const allowed_modules = document.getElementById('formAllowedModules').value;

    try {
        if (!editId) {
            // Criar
            const password = document.getElementById('formPassword').value;
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: getAuthHeaders(true),
                body: JSON.stringify({ username, password, full_name, role, is_active, allowed_modules })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Erro ao criar usuário');
            }
        } else {
            // Atualizar
            const res = await fetch(`/api/admin/users/${editId}`, {
                method: 'PUT',
                headers: getAuthHeaders(true),
                body: JSON.stringify({ full_name, role, is_active, allowed_modules })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Erro ao atualizar usuário');
            }
        }

        closeUserFormModal();
        await loadUsers();
    } catch (err) {
        alert(err.message);
    }
}

async function promptResetPassword(userId, username) {
    const newPass = prompt(`Digite a nova senha para o usuário @${username} (mínimo 4 caracteres):`);
    if (!newPass) return;

    if (newPass.length < 4) {
        alert('A senha deve ter pelo menos 4 caracteres.');
        return;
    }

    try {
        const res = await fetch(`/api/admin/users/${userId}/reset-password`, {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify({ new_password: newPass })
        });
        if (!res.ok) throw new Error('Erro ao redefinir senha');
        alert(`Senha do usuário @${username} redefinida com sucesso!`);
    } catch (e) {
        alert(e.message);
    }
}

async function confirmDeleteUser(userId, username) {
    if (!confirm(`Deseja realmente excluir permanentemente o usuário @${username}?`)) return;

    try {
        const res = await fetch(`/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: getAuthHeaders(false)
        });
        if (!res.ok) throw new Error('Erro ao excluir usuário');
        await loadUsers();
    } catch (e) {
        alert(e.message);
    }
}

// ==================== LOGS DE AUDITORIA ====================

async function loadAuditLogs() {
    const search = document.getElementById('auditSearchInput')?.value || '';
    try {
        const res = await fetch(`/api/admin/audit-logs?search=${encodeURIComponent(search)}&limit=80`, {
            headers: getAuthHeaders(false)
        });
        if (!res.ok) return;

        const logs = await res.json();
        const tbody = document.getElementById('auditTableBody');
        tbody.innerHTML = '';

        logs.forEach(l => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-white/5 transition";
            tr.innerHTML = `
                <td class="py-2.5 px-4 text-slate-400">${l.created_at}</td>
                <td class="py-2.5 px-4 text-cyan-300 font-semibold">@${l.username}</td>
                <td class="py-2.5 px-4"><span class="px-2 py-0.5 rounded bg-white/5 text-slate-200 text-[10px]">${l.action}</span></td>
                <td class="py-2.5 px-4 text-slate-300 max-w-xs truncate" title="${l.details || ''}">${l.details || '-'}</td>
                <td class="py-2.5 px-4 text-slate-400">${l.ip_address || '-'}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error(e);
    }
}

// ==================== ALTERAR SENHA DO USUÁRIO ====================

function openChangePasswordModal() {
    document.getElementById('currentPwd').value = '';
    document.getElementById('newPwd').value = '';
    const modal = document.getElementById('changePwdModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeChangePasswordModal() {
    const modal = document.getElementById('changePwdModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function handleChangePassword(e) {
    e.preventDefault();
    const current_password = document.getElementById('currentPwd').value;
    const new_password = document.getElementById('newPwd').value;

    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify({ current_password, new_password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Erro ao alterar senha');

        alert('Senha alterada com sucesso!');
        closeChangePasswordModal();
    } catch (err) {
        alert(err.message);
    }
}
