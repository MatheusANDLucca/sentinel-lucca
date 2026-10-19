// CFTV Sentinel - Lógica Frontend em Tempo Real com Autenticação, Administração, Snapshots, Saúde de HD e Modo Telão

// Estado global da aplicação
let currentUser = null;
let recorders = [];
let adminUsers = [];
let auditLogs = [];
let activeFilter = 'all';
let searchQuery = '';
let selectedLocation = 'all';
let viewMode = 'grid';
let soundAlertEnabled = true;
let ws = null;
let reconnectTimer = null;
let audioCtx = null;
let userDropdownOpen = false;
let currentSnapshotRecorderId = null;
let isKioskMode = false;

// Inicialização ao carregar a página
document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    const authenticated = await checkAuth();
    if (!authenticated) return; // checkAuth redireciona para /login.html

    await loadSettings();
    await loadStats();
    await loadRecorders();
    initWebSocket();
    setupEventListeners();
    setupKioskListeners();
});

// ==================== AUTENTICAÇÃO E SESSÃO ====================

function getToken() {
    return localStorage.getItem('cftv_token') || localStorage.getItem('sentinel_token');
}

function getAuthHeaders(includeContentType = true) {
    const token = getToken();
    const headers = {};
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (includeContentType) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

async function checkAuth() {
    const token = getToken();
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }

    try {
        const res = await fetch('/api/auth/me', {
            headers: getAuthHeaders(false)
        });

        if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('cftv_token');
            localStorage.removeItem('cftv_user');
            window.location.href = '/login.html';
            return false;
        }

        if (res.ok) {
            currentUser = await res.json();
            
            // Validação de acesso ao módulo CFTV
            const role = currentUser.role || 'operador';
            const allowed = (currentUser.allowed_modules || 'all').toLowerCase();
            if (role !== 'admin' && allowed !== 'all' && !allowed.includes('cftv')) {
                alert('Acesso negado: Seu usuário não possui permissão para acessar o módulo CFTV Sentinel.');
                window.location.href = '/portal';
                return false;
            }

            updateCurrentUserUI();
            return true;
        }
    } catch (e) {
        console.error('Falha ao checar autenticação:', e);
    }
    return false;
}

function updateCurrentUserUI() {
    if (!currentUser) return;

    const avatar = document.getElementById('userAvatar');
    const nameTop = document.getElementById('userNameTop');
    const roleTop = document.getElementById('userRoleTop');
    const dropName = document.getElementById('dropdownFullName');
    const dropUser = document.getElementById('dropdownUsername');

    const firstLetter = (currentUser.full_name || currentUser.username).charAt(0).toUpperCase();
    if (avatar) avatar.textContent = firstLetter;
    if (nameTop) nameTop.textContent = currentUser.full_name || currentUser.username;
    if (roleTop) roleTop.textContent = currentUser.role;
    if (dropName) dropName.textContent = currentUser.full_name;
    if (dropUser) dropUser.textContent = `@${currentUser.username}`;

    const isAdmin = currentUser.role === 'admin';
    const isVisualizer = currentUser.role === 'visualizador';

    const btnAdmin = document.getElementById('btnAdminPanel');
    const btnSettings = document.getElementById('btnSettings');
    const btnAddRec = document.getElementById('btnAddRecorderHeader');
    const btnClearLogs = document.getElementById('btnClearLogs');

    if (btnAdmin) btnAdmin.classList.toggle('hidden', !isAdmin);
    if (btnSettings) btnSettings.classList.toggle('hidden', !isAdmin);
    if (btnClearLogs) btnClearLogs.classList.toggle('hidden', !isAdmin);
    if (btnAddRec) btnAddRec.classList.toggle('hidden', isVisualizer);

    lucide.createIcons();
}

function toggleUserDropdown() {
    const dd = document.getElementById('userDropdown');
    userDropdownOpen = !userDropdownOpen;
    dd.classList.toggle('hidden', !userDropdownOpen);
}

document.addEventListener('click', (e) => {
    const btn = document.getElementById('btnUserMenu');
    const dd = document.getElementById('userDropdown');
    if (btn && dd && !btn.contains(e.target) && !dd.contains(e.target)) {
        dd.classList.add('hidden');
        userDropdownOpen = false;
    }
});

async function logout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: getAuthHeaders(false)
        });
    } catch (e) {
        console.error(e);
    } finally {
        localStorage.removeItem('cftv_token');
        localStorage.removeItem('cftv_user');
        window.location.href = '/login.html';
    }
}

function openChangePasswordModal() {
    toggleUserDropdown();
    document.getElementById('changePasswordModal').classList.remove('hidden');
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.add('hidden');
}

async function handleChangeMyPasswordSubmit(e) {
    e.preventDefault();
    const curr = document.getElementById('myCurrentPassword').value;
    const newPwd = document.getElementById('myNewPassword').value;
    const confirmPwd = document.getElementById('myConfirmNewPassword').value;

    if (newPwd !== confirmPwd) {
        showToast('A confirmação da nova senha não confere.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ current_password: curr, new_password: newPwd })
        });

        if (res.ok) {
            closeChangePasswordModal();
            showToast('Sua senha foi alterada com sucesso!', 'success');
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao alterar senha.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Falha na comunicação com o servidor.', 'error');
    }
}

// ==================== MODO TELÃO (KIOSK MODE) ====================

function toggleKioskMode() {
    isKioskMode = !isKioskMode;
    document.body.classList.toggle('kiosk-mode', isKioskMode);

    if (isKioskMode) {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log('Fullscreen automático não permitido pelo navegador:', err);
            });
        }
        showToast('Modo Telão ativado. Pressione ESC para sair.', 'info');
    } else {
        if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(err => console.log(err));
        }
        showToast('Modo Telão encerrado.', 'info');
    }
}

function setupKioskListeners() {
    // Escutar saída de tela cheia nativa pelo teclado
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && isKioskMode) {
            isKioskMode = false;
            document.body.classList.remove('kiosk-mode');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isKioskMode) {
            toggleKioskMode();
        }
    });
}

// ==================== SNAPSHOT HTTP (MINIATURA DA CÂMERA) ====================

function openSnapshotModal(recorderId) {
    const rec = recorders.find(r => r.id === recorderId);
    if (!rec) return;

    currentSnapshotRecorderId = recorderId;
    const modal = document.getElementById('snapshotModal');
    const title = document.getElementById('snapshotModalTitle');
    const sub = document.getElementById('snapshotModalSubtitle');
    const img = document.getElementById('snapshotViewerImg');
    const openLink = document.getElementById('snapshotOpenNewTab');

    title.textContent = rec.name;
    sub.innerHTML = `
        <a href="${getRecorderWebUrl(rec.ip, rec.port)}" target="_blank" rel="noopener noreferrer" 
           title="Acessar interface web do gravador (${escapeHtml(rec.ip)}) em nova aba" 
           class="text-cyan-400 hover:text-cyan-300 hover:underline font-semibold inline-flex items-center gap-1 transition">
            <span>${escapeHtml(rec.ip)}</span>
            <i data-lucide="external-link" class="w-2.5 h-2.5"></i>
        </a> • Canal ${rec.snapshot_channel || 1} (${escapeHtml(rec.brand || 'CFTV')})
    `;

    const snapshotUrl = `/api/recorders/${recorderId}/snapshot?t=${Date.now()}`;
    img.src = snapshotUrl;
    openLink.href = snapshotUrl;

    const recWebLink = document.getElementById('snapshotRecorderWebLink');
    if (recWebLink) {
        recWebLink.href = getRecorderWebUrl(rec.ip, rec.port);
    }

    document.getElementById('snapshotTimestamp').textContent = `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`;
    modal.classList.remove('hidden');
    lucide.createIcons();
}

function closeSnapshotModal() {
    document.getElementById('snapshotModal').classList.add('hidden');
    currentSnapshotRecorderId = null;
}

function refreshCurrentSnapshot() {
    if (!currentSnapshotRecorderId) return;
    const img = document.getElementById('snapshotViewerImg');
    const icon = document.getElementById('snapshotRefreshIcon');
    const loader = document.getElementById('snapshotLoading');

    if (icon) icon.classList.add('animate-spin');
    if (loader) loader.classList.remove('hidden');

    const newUrl = `/api/recorders/${currentSnapshotRecorderId}/snapshot?t=${Date.now()}`;
    const preloader = new Image();
    preloader.onload = () => {
        img.src = newUrl;
        document.getElementById('snapshotOpenNewTab').href = newUrl;
        document.getElementById('snapshotTimestamp').textContent = `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`;
        if (icon) icon.classList.remove('animate-spin');
        if (loader) loader.classList.add('hidden');
    };
    preloader.onerror = () => {
        img.src = newUrl; // Fallback SVG será renderizado
        if (icon) icon.classList.remove('animate-spin');
        if (loader) loader.classList.add('hidden');
    };
    preloader.src = newUrl;
}

// ==================== PAINEL ADMINISTRADOR ====================

function openAdminModal() {
    document.getElementById('adminModal').classList.remove('hidden');
    switchAdminTab('users');
    lucide.createIcons();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.add('hidden');
}

function switchAdminTab(tab) {
    const tabUsersBtn = document.getElementById('tabUsersBtn');
    const tabAuditBtn = document.getElementById('tabAuditBtn');
    const tabBackupBtn = document.getElementById('tabBackupBtn');
    const tabTelegramBtn = document.getElementById('tabTelegramBtn');

    const tabUsersContent = document.getElementById('tabUsersContent');
    const tabAuditContent = document.getElementById('tabAuditContent');
    const tabBackupContent = document.getElementById('tabBackupContent');
    const tabTelegramContent = document.getElementById('tabTelegramContent');

    // Reset buttons
    [tabUsersBtn, tabAuditBtn, tabBackupBtn, tabTelegramBtn].forEach(b => {
        if (b) b.className = 'py-3 px-4 font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center gap-2 transition';
    });

    // Reset contents
    [tabUsersContent, tabAuditContent, tabBackupContent, tabTelegramContent].forEach(c => {
        if (c) c.classList.add('hidden');
    });

    if (tab === 'users') {
        if (tabUsersBtn) tabUsersBtn.className = 'py-3 px-4 font-semibold text-blue-400 border-b-2 border-blue-500 flex items-center gap-2 transition';
        if (tabUsersContent) tabUsersContent.classList.remove('hidden');
        loadUsers();
    } else if (tab === 'audit') {
        if (tabAuditBtn) tabAuditBtn.className = 'py-3 px-4 font-semibold text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2 transition';
        if (tabAuditContent) tabAuditContent.classList.remove('hidden');
        loadAuditLogs();
    } else if (tab === 'backup') {
        if (tabBackupBtn) tabBackupBtn.className = 'py-3 px-4 font-semibold text-emerald-400 border-b-2 border-emerald-500 flex items-center gap-2 transition';
        if (tabBackupContent) tabBackupContent.classList.remove('hidden');
    } else if (tab === 'telegram') {
        if (tabTelegramBtn) tabTelegramBtn.className = 'py-3 px-4 font-semibold text-sky-400 border-b-2 border-sky-500 flex items-center gap-2 transition';
        if (tabTelegramContent) tabTelegramContent.classList.remove('hidden');
        loadTelegramSettings();
    }
    lucide.createIcons();
}

// Gestão de Usuários
async function loadUsers() {
    try {
        const res = await fetch('/api/admin/users', { headers: getAuthHeaders(false) });
        if (res.ok) {
            adminUsers = await res.json();
            renderUsersTable();
        }
    } catch (e) {
        console.error('Erro ao carregar usuários:', e);
    }
}

function renderUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!adminUsers || adminUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-500">Nenhum usuário cadastrado.</td></tr>';
        return;
    }

    tbody.innerHTML = adminUsers.map(u => {
        const isMe = currentUser && currentUser.id === u.id;
        const roleBadges = {
            'admin': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">Administrador</span>',
            'operador': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">Operador</span>',
            'visualizador': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">Visualizador</span>'
        };

        const moduleBadges = {
            'all': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">Todos</span>',
            'cftv': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">CFTV</span>',
            'printers': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Impressoras</span>'
        };

        const statusBadge = u.is_active
            ? '<span class="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Ativo</span>'
            : '<span class="inline-flex items-center gap-1 text-[11px] text-rose-400 font-medium"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Inativo</span>';

        return `
            <tr class="hover:bg-dark-800/60 transition">
                <td class="py-3 px-4 font-mono font-semibold text-white select-all">@${escapeHtml(u.username)}</td>
                <td class="py-3 px-4 font-medium text-slate-200">${escapeHtml(u.full_name)} ${isMe ? '<span class="text-[10px] text-blue-400 font-mono">(Você)</span>' : ''}</td>
                <td class="py-3 px-4">${roleBadges[u.role] || u.role}</td>
                <td class="py-3 px-4">${moduleBadges[u.allowed_modules] || u.allowed_modules || '<span class="text-slate-500">Todos</span>'}</td>
                <td class="py-3 px-4">${statusBadge}</td>
                <td class="py-3 px-4 text-slate-400 text-[11px] font-mono">${u.last_login ? u.last_login : 'Nunca'}</td>
                <td class="py-3 px-4 text-right">
                    <div class="flex items-center justify-end gap-1.5">
                        <button onclick="openResetPasswordModal(${u.id}, '${escapeHtml(u.username)}')" title="Redefinir Senha" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-amber-400 hover:text-white transition">
                            <i data-lucide="key" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="openUserFormModal(${u.id})" title="Editar Usuário" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white transition">
                            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                        </button>
                        ${!isMe ? `
                            <button onclick="toggleUserActive(${u.id}, ${!u.is_active}, '${escapeHtml(u.username)}')" title="${u.is_active ? 'Desativar' : 'Ativar'}" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 ${u.is_active ? 'text-amber-400' : 'text-emerald-400'} transition">
                                <i data-lucide="${u.is_active ? 'pause-circle' : 'play-circle'}" class="w-3.5 h-3.5"></i>
                            </button>
                            <button onclick="deleteUserPrompt(${u.id}, '${escapeHtml(u.username)}')" title="Excluir Usuário" class="p-1.5 rounded-lg bg-dark-700 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition">
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

function openUserFormModal(id = null) {
    const modal = document.getElementById('userFormModal');
    const title = document.getElementById('userFormTitle');
    const pwdContainer = document.getElementById('userFormPasswordContainer');
    const pwdInput = document.getElementById('userFormPassword');
    const allowedModSelect = document.getElementById('userFormAllowedModules');

    document.getElementById('userForm').reset();
    document.getElementById('userFormId').value = '';

    if (id) {
        title.innerHTML = '<i data-lucide="edit" class="w-4 h-4 text-indigo-400"></i><span>Editar Usuário</span>';
        const u = adminUsers.find(user => user.id === id);
        if (u) {
            document.getElementById('userFormId').value = u.id;
            document.getElementById('userFormUsername').value = u.username;
            document.getElementById('userFormUsername').disabled = true;
            document.getElementById('userFormFullName').value = u.full_name;
            document.getElementById('userFormRole').value = u.role;
            if (allowedModSelect) allowedModSelect.value = u.allowed_modules || 'all';
            document.getElementById('userFormIsActive').checked = u.is_active;
        }
        pwdContainer.classList.add('hidden');
        pwdInput.required = false;
    } else {
        title.innerHTML = '<i data-lucide="user-plus" class="w-4 h-4 text-indigo-400"></i><span>Cadastrar Novo Usuário</span>';
        document.getElementById('userFormUsername').disabled = false;
        if (allowedModSelect) allowedModSelect.value = 'all';
        pwdContainer.classList.remove('hidden');
        pwdInput.required = true;
    }

    modal.classList.remove('hidden');
    lucide.createIcons();
}

function closeUserFormModal() {
    document.getElementById('userFormModal').classList.add('hidden');
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('userFormId').value;
    const isEdit = Boolean(id);
    const allowedModSelect = document.getElementById('userFormAllowedModules');

    const payload = {
        full_name: document.getElementById('userFormFullName').value.trim(),
        role: document.getElementById('userFormRole').value,
        allowed_modules: allowedModSelect ? allowedModSelect.value : 'all',
        is_active: document.getElementById('userFormIsActive').checked
    };

    if (!isEdit) {
        payload.username = document.getElementById('userFormUsername').value.trim().toLowerCase();
        payload.password = document.getElementById('userFormPassword').value;
    }

    try {
        const url = isEdit ? `/api/admin/users/${id}` : '/api/admin/users';
        const method = isEdit ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeUserFormModal();
            showToast(isEdit ? 'Usuário atualizado com sucesso!' : 'Usuário criado com sucesso!', 'success');
            await loadUsers();
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao salvar usuário.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Falha na requisição.', 'error');
    }
}

async function toggleUserActive(id, newActive, username) {
    try {
        const res = await fetch(`/api/admin/users/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ is_active: newActive })
        });
        if (res.ok) {
            showToast(`Usuário @${username} foi ${newActive ? 'ativado' : 'desativado'}.`, 'info');
            await loadUsers();
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao alterar status.', 'error');
        }
    } catch (err) {
        console.error(err);
    }
}

async function deleteUserPrompt(id, username) {
    if (confirm(`Tem certeza que deseja excluir permanentemente o usuário "@${username}"?`)) {
        try {
            const res = await fetch(`/api/admin/users/${id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(false)
            });
            if (res.ok) {
                showToast(`Usuário @${username} excluído com sucesso.`, 'info');
                await loadUsers();
            } else {
                const err = await res.json();
                showToast(err.detail || 'Erro ao excluir.', 'error');
            }
        } catch (err) {
            console.error(err);
        }
    }
}

function openResetPasswordModal(id, username) {
    document.getElementById('resetUserId').value = id;
    document.getElementById('resetUsernameDisplay').textContent = `@${username}`;
    document.getElementById('resetNewPassword').value = '';
    document.getElementById('resetUserPasswordModal').classList.remove('hidden');
    lucide.createIcons();
}

function closeResetUserPasswordModal() {
    document.getElementById('resetUserPasswordModal').classList.add('hidden');
}

async function handleResetUserPasswordSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('resetUserId').value;
    const newPassword = document.getElementById('resetNewPassword').value;

    try {
        const res = await fetch(`/api/admin/users/${id}/reset-password`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ new_password: newPassword })
        });
        if (res.ok) {
            closeResetUserPasswordModal();
            showToast('Senha redefinida com sucesso!', 'success');
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao redefinir senha.', 'error');
        }
    } catch (err) {
        console.error(err);
    }
}

// Logs de Auditoria
async function loadAuditLogs() {
    const search = document.getElementById('auditSearchInput').value;
    const action = document.getElementById('auditActionFilter').value;

    let url = '/api/admin/audit-logs?limit=150';
    if (search.trim()) url += `&search=${encodeURIComponent(search.trim())}`;
    if (action && action !== 'all') url += `&action=${encodeURIComponent(action)}`;

    try {
        const res = await fetch(url, { headers: getAuthHeaders(false) });
        if (res.ok) {
            auditLogs = await res.json();
            renderAuditLogsTable();
        }
    } catch (err) {
        console.error('Erro ao buscar logs de auditoria:', err);
    }
}

function renderAuditLogsTable() {
    const tbody = document.getElementById('auditTableBody');
    if (!auditLogs || auditLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-500">Nenhum registro de auditoria encontrado.</td></tr>';
        return;
    }

    const actionBadges = {
        'LOGIN_SUCCESS': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400">LOGIN</span>',
        'LOGIN_FAILED': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400">LOGIN_FALHOU</span>',
        'LOGOUT': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">LOGOUT</span>',
        'RECORDER_CREATE': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400">CRIAR_GRAVADOR</span>',
        'RECORDER_UPDATE': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400">EDITAR_GRAVADOR</span>',
        'RECORDER_DELETE': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400">EXCLUIR_GRAVADOR</span>',
        'RECORDER_TEST': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400">TESTAR_GRAVADOR</span>',
        'RECORDER_STORAGE_CHECK': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-500/20 text-teal-400">TESTE_HD</span>',
        'DATABASE_BACKUP_DOWNLOAD': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400">BACKUP_BANCO</span>',
        'USER_CREATE': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-400">CRIAR_USUARIO</span>',
        'PASSWORD_CHANGE': '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400">TROCA_SENHA</span>'
    };

    tbody.innerHTML = auditLogs.map(log => `
        <tr class="hover:bg-dark-800/40 transition">
            <td class="py-2.5 px-3 font-mono text-slate-400 text-[11px] whitespace-nowrap">${log.created_at}</td>
            <td class="py-2.5 px-3 font-semibold text-white select-all">@${escapeHtml(log.username)}</td>
            <td class="py-2.5 px-3 whitespace-nowrap">${actionBadges[log.action] || `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-700 text-slate-300">${log.action}</span>`}</td>
            <td class="py-2.5 px-3 text-slate-300 max-w-xs md:max-w-md truncate" title="${escapeHtml(log.details || '')}">${escapeHtml(log.details || '-')}</td>
            <td class="py-2.5 px-3 font-mono text-slate-400 text-[11px]">${escapeHtml(log.ip_address || '-')}</td>
        </tr>
    `).join('');
    lucide.createIcons();
}

async function exportAuditLogsCSV() {
    try {
        const res = await fetch('/api/admin/audit-logs/export', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `auditoria_cftv_${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast('Relatório de auditoria exportado!', 'success');
        }
    } catch (e) {
        console.error(e);
        showToast('Erro ao exportar logs de auditoria.', 'error');
    }
}

// ==================== DOWNLOAD BACKUP DO BANCO (1 CLIQUE) ====================

async function downloadDatabaseBackup() {
    try {
        showToast('Gerando backup consistente do banco de dados...', 'info');
        const res = await fetch('/api/admin/backup/download', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cftv_sentinel_backup_${new Date().toISOString().slice(0,19).replace(/[-:T]/g, '')}.db`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast('Backup do banco de dados baixado com sucesso!', 'success');
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao gerar backup.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Falha na comunicação ao baixar backup.', 'error');
    }
}

async function exportRecordersCSV() {
    try {
        const res = await fetch('/api/export/csv', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gravadores_cftv_${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast('Relatório de gravadores exportado!', 'success');
        }
    } catch (e) {
        console.error(e);
        showToast('Erro ao exportar gravadores.', 'error');
    }
}

// ==================== DASHBOARD & TELEMETRIA ====================

function initClock() {
    const clockEl = document.getElementById('currentClock');
    const update = () => {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('pt-BR');
    };
    update();
    setInterval(update, 1000);
}

function playAlertSound(isTest = false) {
    if (!soundAlertEnabled && !isTest) return;

    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        const now = audioCtx.currentTime;
        
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.3, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.25);

        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(660, now + 0.2);
        gain2.gain.setValueAtTime(0.35, now + 0.2);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.55);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.2);
        osc2.stop(now + 0.55);

    } catch (e) {
        console.warn('Não foi possível reproduzir som de alerta:', e);
    }
}

async function loadSettings() {
    try {
        const res = await fetch('/api/settings', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const data = await res.json();
            soundAlertEnabled = data.sound_alert_enabled;
            updateSoundButtonUI();
        }
    } catch (e) {
        console.error('Erro ao carregar configurações:', e);
    }
}

function updateSoundButtonUI() {
    const icon = document.getElementById('soundIcon');
    const text = document.getElementById('soundText');
    if (soundAlertEnabled) {
        icon.className = 'w-4 h-4 text-emerald-400';
        icon.setAttribute('data-lucide', 'volume-2');
        text.textContent = 'Som Ativo';
    } else {
        icon.className = 'w-4 h-4 text-slate-500';
        icon.setAttribute('data-lucide', 'volume-x');
        text.textContent = 'Mudo';
    }
    lucide.createIcons();
}

async function toggleSound() {
    soundAlertEnabled = !soundAlertEnabled;
    updateSoundButtonUI();
    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ sound_alert_enabled: soundAlertEnabled })
        });
        showToast(soundAlertEnabled ? 'Alerta sonoro ativado.' : 'Alerta sonoro silenciado.', 'info');
    } catch (e) {
        console.error(e);
    }
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const wsBadge = document.getElementById('wsStatusBadge');
    const wsText = document.getElementById('wsStatusText');

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket conectado com sucesso.');
            wsBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400';
            wsText.textContent = 'Tempo Real Conectado';
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            } catch (e) {
                console.error('Erro ao parsear mensagem WebSocket:', e);
            }
        };

        ws.onclose = () => {
            console.warn('Conexão WebSocket perdida. Tentando reconectar...');
            wsBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400';
            wsText.textContent = 'Reconectando...';
            reconnectTimer = setTimeout(initWebSocket, 3000);
        };

        ws.onerror = (err) => {
            console.error('Erro no WebSocket:', err);
            ws.close();
        };

    } catch (err) {
        console.error('Falha ao inicializar WebSocket:', err);
        reconnectTimer = setTimeout(initWebSocket, 3000);
    }
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'RECORDER_STATUS_UPDATE':
            updateRecorderInList(data.recorder);
            loadStats();
            break;

        case 'RECORDER_ALERT':
            handleRecorderAlert(data.alert);
            break;

        case 'RECORDER_ADDED':
            recorders.unshift(data.recorder);
            renderRecorders();
            loadStats();
            break;

        case 'RECORDER_UPDATED':
            updateRecorderInList(data.recorder);
            loadStats();
            break;

        case 'RECORDER_DELETED':
            recorders = recorders.filter(r => r.id !== data.recorder_id);
            renderRecorders();
            loadStats();
            break;

        case 'CYCLE_COMPLETED':
            loadStats();
            break;
    }
}

function updateRecorderInList(updated) {
    const idx = recorders.findIndex(r => r.id === updated.id);
    if (idx !== -1) {
        recorders[idx] = updated;
    } else {
        recorders.unshift(updated);
    }
    renderRecorders();
}

function handleRecorderAlert(alert) {
    if (alert.event_type === 'offline') {
        playAlertSound();
        showToast(`ALERTA: O gravador '${alert.recorder_name}' (${alert.ip}) ficou OFFLINE!`, 'error', 7000);
    } else if (alert.event_type === 'online') {
        showToast(`NORMALIZADO: O gravador '${alert.recorder_name}' (${alert.ip}) voltou a ficar ONLINE.`, 'success', 5000);
    }
}

async function loadRecorders() {
    try {
        const res = await fetch('/api/recorders', { headers: getAuthHeaders(false) });
        if (res.status === 401) {
            window.location.href = '/login.html';
            return;
        }
        if (res.ok) {
            recorders = await res.json();
            renderRecorders();
        }
    } catch (e) {
        console.error('Erro ao buscar gravadores:', e);
    }
}

async function loadStats() {
    try {
        const res = await fetch('/api/stats', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const data = await res.json();
            document.getElementById('statTotal').textContent = data.total;
            document.getElementById('statOnline').textContent = data.online;
            document.getElementById('statOffline').textContent = data.offline;
            document.getElementById('statLatency').textContent = data.avg_latency;
            document.getElementById('statUptime').textContent = `${data.uptime_percentage}%`;

            const locSelect = document.getElementById('locationSelect');
            const currentVal = locSelect.value;
            locSelect.innerHTML = '<option value="all">Todas as Filiais/Locais</option>';
            data.locations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc;
                opt.textContent = loc;
                if (loc === currentVal) opt.selected = true;
                locSelect.appendChild(opt);
            });
        }
    } catch (e) {
        console.error('Erro ao carregar estatísticas:', e);
    }
}

function renderRecorders() {
    const gridContainer = document.getElementById('gridContainer');
    const tableBody = document.getElementById('tableBody');
    const emptyState = document.getElementById('emptyState');
    const tableContainer = document.getElementById('tableContainer');

    const filtered = recorders.filter(r => {
        if (activeFilter !== 'all' && r.status !== activeFilter) return false;
        if (selectedLocation !== 'all' && r.location !== selectedLocation) return false;

        if (searchQuery.trim() !== '') {
            const q = searchQuery.toLowerCase();
            const matchName = r.name.toLowerCase().includes(q);
            const matchIp = r.ip.toLowerCase().includes(q);
            const matchBrand = (r.brand || '').toLowerCase().includes(q);
            const matchLoc = (r.location || '').toLowerCase().includes(q);
            if (!matchName && !matchIp && !matchBrand && !matchLoc) return false;
        }

        return true;
    });

    if (filtered.length === 0) {
        gridContainer.classList.add('hidden');
        tableContainer.classList.add('hidden');
        emptyState.classList.remove('hidden');
        lucide.createIcons();
        return;
    }

    emptyState.classList.add('hidden');

    if (viewMode === 'grid') {
        gridContainer.classList.remove('hidden');
        tableContainer.classList.add('hidden');
        gridContainer.innerHTML = filtered.map(r => createRecorderCardHTML(r)).join('');
    } else {
        gridContainer.classList.add('hidden');
        tableContainer.classList.remove('hidden');
        tableBody.innerHTML = filtered.map(r => createRecorderTableRowHTML(r)).join('');
    }

    lucide.createIcons();
}

function getStorageBadgeHTML(status, info) {
    const s = (status || 'ok').toLowerCase();
    const tooltip = escapeHtml(info || 'HD Normal');
    if (s === 'ok') {
        return `<span class="px-2 py-0.5 rounded text-[10px] font-semibold storage-badge-ok inline-flex items-center gap-1" title="${tooltip}"><i data-lucide="hard-drive" class="w-3 h-3"></i> HD: Normal</span>`;
    } else if (s === 'warning') {
        return `<span class="px-2 py-0.5 rounded text-[10px] font-semibold storage-badge-warning inline-flex items-center gap-1" title="${tooltip}"><i data-lucide="hard-drive" class="w-3 h-3"></i> HD: Alerta</span>`;
    } else if (s === 'error') {
        return `<span class="px-2 py-0.5 rounded text-[10px] font-semibold storage-badge-error inline-flex items-center gap-1" title="${tooltip}"><i data-lucide="alert-triangle" class="w-3 h-3"></i> HD: Falha!</span>`;
    }
    return `<span class="px-2 py-0.5 rounded text-[10px] font-semibold storage-badge-unknown inline-flex items-center gap-1"><i data-lucide="hard-drive" class="w-3 h-3"></i> HD: -</span>`;
}

function createRecorderCardHTML(r) {
    const isOnline = r.status === 'online';
    const isOffline = r.status === 'offline';
    const isPaused = !r.is_active;
    const canEdit = currentUser && (currentUser.role === 'admin' || currentUser.role === 'operador');
    const canDelete = currentUser && currentUser.role === 'admin';

    let statusBadge = '';
    let borderClass = 'border-dark-700';
    let pulseClass = '';

    if (isPaused) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> PAUSADO
        </span>`;
    } else if (isOnline) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ONLINE
        </span>`;
        borderClass = 'border-emerald-500/30 hover:border-emerald-500/50';
    } else if (isOffline) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span> OFFLINE
        </span>`;
        borderClass = 'border-rose-500/50 hover:border-rose-500/80 bg-rose-950/10';
        pulseClass = 'card-offline-pulse';
    } else {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> CHECANDO...
        </span>`;
    }

    const brandClass = getBrandBadgeClass(r.brand);
    const storageBadge = getStorageBadgeHTML(r.storage_status, r.storage_info);

    return `
    <div class="recorder-card bg-dark-800 border ${borderClass} ${pulseClass} rounded-xl p-5 shadow-sm flex flex-col justify-between space-y-4">
        <div>
            <div class="flex items-start justify-between gap-3 mb-2.5">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${brandClass}">${escapeHtml(r.brand || 'CFTV')}</span>
                        ${storageBadge}
                        ${r.location ? `<span class="text-[11px] text-slate-400 flex items-center gap-1"><i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${escapeHtml(r.location)}</span>` : ''}
                    </div>
                    <h4 class="text-sm font-bold text-white truncate" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</h4>
                </div>
                ${statusBadge}
            </div>

            <div class="bg-dark-900/80 rounded-lg p-3 border border-dark-700 space-y-2 text-xs font-mono">
                <div class="flex items-center justify-between">
                    <span class="text-slate-400 font-sans text-[11px]">Endereço IP:</span>
                    <a href="${getRecorderWebUrl(r.ip, r.port)}" target="_blank" rel="noopener noreferrer" 
                       title="Acessar interface web do gravador (${escapeHtml(r.ip)}) em nova aba" 
                       class="text-cyan-400 hover:text-cyan-300 hover:underline font-semibold select-all inline-flex items-center gap-1 transition group">
                        <span>${escapeHtml(r.ip)}${r.port ? `:${r.port}` : ''}</span>
                        <i data-lucide="external-link" class="w-3 h-3 text-cyan-500/70 group-hover:text-cyan-300 transition-colors"></i>
                    </a>
                </div>
                <div class="flex items-center justify-between">
                    <span class="text-slate-400 font-sans text-[11px]">Latência (Ping):</span>
                    <span class="${getLatencyClass(r.latency_ms, r.status)} font-semibold">
                        ${isOnline ? `${r.latency_ms} ms` : (isOffline ? 'Inacessível' : '--')}
                    </span>
                </div>
            </div>

            ${r.description ? `<p class="text-[11px] text-slate-400 mt-2.5 line-clamp-2" title="${escapeHtml(r.description)}">${escapeHtml(r.description)}</p>` : ''}
        </div>

        <div class="pt-3 border-t border-dark-700 flex items-center justify-between text-[11px] text-slate-500">
            <span title="Última checagem">Checado: ${r.last_checked ? formatDateTime(r.last_checked) : 'Nunca'}</span>
            
            <div class="card-actions-row flex items-center gap-1">
                <!-- Botão Snapshot Câmera -->
                <button onclick="openSnapshotModal(${r.id})" title="Ver Câmera ao Vivo (Snapshot)" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-cyan-400 hover:text-white transition">
                    <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                </button>

                <!-- Botão Testar Conexão -->
                ${canEdit ? `
                    <button onclick="checkRecorderNow(${r.id}, this)" title="Testar Conexão Imediatamente" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-blue-400 hover:text-white transition">
                        <i data-lucide="zap" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="openRecorderModal(${r.id})" title="Editar Informações" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white transition">
                        <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                    </button>
                ` : ''}
                ${canDelete ? `
                    <button onclick="deleteRecorderPrompt(${r.id}, '${escapeHtml(r.name)}')" title="Excluir Gravador" class="p-1.5 rounded-lg bg-dark-700 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition">
                        <i data-lucide="trash" class="w-3.5 h-3.5"></i>
                    </button>
                ` : ''}
            </div>
        </div>
    </div>
    `;
}

function createRecorderTableRowHTML(r) {
    const isOnline = r.status === 'online';
    const isOffline = r.status === 'offline';
    const isPaused = !r.is_active;
    const canEdit = currentUser && (currentUser.role === 'admin' || currentUser.role === 'operador');
    const canDelete = currentUser && currentUser.role === 'admin';

    let statusBadge = '';
    if (isPaused) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400">Pausado</span>`;
    } else if (isOnline) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Online</span>`;
    } else if (isOffline) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/20 text-rose-400 border border-rose-500/30 animate-pulse">Offline</span>`;
    } else {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400">Checando</span>`;
    }

    const brandClass = getBrandBadgeClass(r.brand);
    const storageBadge = getStorageBadgeHTML(r.storage_status, r.storage_info);

    return `
    <tr class="hover:bg-dark-700/40 transition">
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4 font-semibold text-white">${escapeHtml(r.name)}</td>
        <td class="py-3 px-4 font-mono select-all">
            <a href="${getRecorderWebUrl(r.ip, r.port)}" target="_blank" rel="noopener noreferrer" 
               title="Acessar interface web do gravador (${escapeHtml(r.ip)}) em nova aba" 
               class="text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1 transition group font-semibold">
                <span>${escapeHtml(r.ip)}${r.port ? `:${r.port}` : ''}</span>
                <i data-lucide="external-link" class="w-3 h-3 text-cyan-500/70 group-hover:text-cyan-300 transition-colors"></i>
            </a>
        </td>
        <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${brandClass}">${escapeHtml(r.brand || 'Outro')}</span></td>
        <td class="py-3 px-4 text-slate-400">${escapeHtml(r.location || '-')}</td>
        <td class="py-3 px-4 font-mono font-semibold ${getLatencyClass(r.latency_ms, r.status)}">${isOnline ? `${r.latency_ms} ms` : '-'}</td>
        <td class="py-3 px-4">${storageBadge}</td>
        <td class="py-3 px-4 text-slate-500 text-[11px]">${r.last_checked ? formatDateTime(r.last_checked) : '-'}</td>
        <td class="py-3 px-4 text-right">
            <div class="flex items-center justify-end gap-1">
                <button onclick="openSnapshotModal(${r.id})" title="Ver Câmera" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-cyan-400 hover:text-white transition">
                    <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                </button>
                ${canEdit ? `
                    <button onclick="checkRecorderNow(${r.id}, this)" title="Testar Imediatamente" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-blue-400 hover:text-white transition">
                        <i data-lucide="zap" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="openRecorderModal(${r.id})" title="Editar" class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-slate-300 hover:text-white transition">
                        <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                    </button>
                ` : ''}
                ${canDelete ? `
                    <button onclick="deleteRecorderPrompt(${r.id}, '${escapeHtml(r.name)}')" title="Excluir" class="p-1.5 rounded-lg bg-dark-700 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition">
                        <i data-lucide="trash" class="w-3.5 h-3.5"></i>
                    </button>
                ` : ''}
            </div>
        </td>
    </tr>
    `;
}

function getBrandBadgeClass(brand) {
    const b = (brand || '').toLowerCase();
    if (b.includes('intelbras')) return 'brand-badge-intelbras';
    if (b.includes('hikvision')) return 'brand-badge-hikvision';
    if (b.includes('dahua')) return 'brand-badge-dahua';
    return 'brand-badge-default';
}

function getLatencyClass(latency, status) {
    if (status !== 'online') return 'text-slate-500';
    if (latency < 25) return 'text-emerald-400';
    if (latency < 75) return 'text-amber-400';
    return 'text-rose-400';
}

function formatDateTime(str) {
    if (!str) return '-';
    const parts = str.split(' ');
    if (parts.length === 2) {
        return parts[1];
    }
    return str;
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

function getRecorderWebUrl(ip, port) {
    if (!ip) return '#';
    let cleanIp = String(ip).trim();
    if (cleanIp.startsWith('http://') || cleanIp.startsWith('https://')) {
        return cleanIp;
    }
    if (cleanIp.includes(':')) {
        return `http://${cleanIp}`;
    }
    // Porta 37777 é a porta de serviço TCP dos gravadores Intelbras/Dahua.
    // O acesso Web (HTTP) dos gravadores no navegador roda na porta 80 por padrão.
    if (!port || port == 37777 || port == 80) {
        return `http://${cleanIp}`;
    }
    return `http://${cleanIp}:${port}`;
}

function setViewMode(mode) {
    viewMode = mode;
    const btnGrid = document.getElementById('viewGridBtn');
    const btnTable = document.getElementById('viewTableBtn');

    if (mode === 'grid') {
        btnGrid.className = 'p-1.5 rounded text-blue-400 bg-dark-700 transition';
        btnTable.className = 'p-1.5 rounded text-slate-400 hover:text-white transition';
    } else {
        btnGrid.className = 'p-1.5 rounded text-slate-400 hover:text-white transition';
        btnTable.className = 'p-1.5 rounded text-blue-400 bg-dark-700 transition';
    }
    renderRecorders();
}

function setupEventListeners() {
    document.querySelectorAll('.status-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.status-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.status;
            renderRecorders();
        });
    });

    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderRecorders();
    });

    document.getElementById('locationSelect').addEventListener('change', (e) => {
        selectedLocation = e.target.value;
        renderRecorders();
    });

    document.getElementById('btnSoundToggle').addEventListener('click', toggleSound);

    document.getElementById('btnRefreshAll').addEventListener('click', async () => {
        const icon = document.getElementById('refreshIcon');
        icon.classList.add('animate-spin');
        try {
            await fetch('/api/recorders/check-all', {
                method: 'POST',
                headers: getAuthHeaders(false)
            });
            showToast('Varredura completa disparada!', 'info');
        } catch (e) {
            console.error(e);
        } finally {
            setTimeout(() => icon.classList.remove('animate-spin'), 1000);
        }
    });

    const auditSearch = document.getElementById('auditSearchInput');
    const auditFilter = document.getElementById('auditActionFilter');
    if (auditSearch) auditSearch.addEventListener('input', () => loadAuditLogs());
    if (auditFilter) auditFilter.addEventListener('change', () => loadAuditLogs());
}

// Modal CRUD: Adicionar / Editar Gravador
function openRecorderModal(id = null) {
    const modal = document.getElementById('recorderModal');
    const modalBox = document.getElementById('recorderModalBox');
    const title = document.getElementById('modalTitle');
    const form = document.getElementById('recorderForm');

    form.reset();
    document.getElementById('recorderId').value = '';
    document.getElementById('inputPort').value = '37777';
    document.getElementById('inputBrand').value = 'Intelbras';
    document.getElementById('inputIsActive').checked = true;
    document.getElementById('inputSnapshotChannel').value = '1';
    document.getElementById('inputSnapshotUser').value = '';
    document.getElementById('inputSnapshotPassword').value = '';
    document.getElementById('inputStorageStatus').value = 'ok';
    document.getElementById('inputStorageInfo').value = 'HD 1: Normal';

    if (id) {
        title.textContent = 'Editar Gravador';
        const rec = recorders.find(r => r.id === id);
        if (rec) {
            document.getElementById('recorderId').value = rec.id;
            document.getElementById('inputName').value = rec.name;
            document.getElementById('inputIp').value = rec.ip;
            document.getElementById('inputPort').value = rec.port || '';
            document.getElementById('inputBrand').value = rec.brand || 'Intelbras';
            document.getElementById('inputLocation').value = rec.location || '';
            document.getElementById('inputDescription').value = rec.description || '';
            document.getElementById('inputIsActive').checked = rec.is_active;
            document.getElementById('inputSnapshotChannel').value = rec.snapshot_channel || 1;
            document.getElementById('inputSnapshotUser').value = rec.snapshot_user || '';
            document.getElementById('inputSnapshotPassword').value = rec.snapshot_password || '';
            document.getElementById('inputStorageStatus').value = rec.storage_status || 'ok';
            document.getElementById('inputStorageInfo').value = rec.storage_info || 'HD 1: Normal';
        }
    } else {
        title.textContent = 'Adicionar Novo Gravador';
    }

    modal.classList.remove('hidden');
    setTimeout(() => {
        modalBox.classList.remove('scale-95', 'opacity-0');
        modalBox.classList.add('scale-100', 'opacity-100');
    }, 10);
    lucide.createIcons();
}

function closeRecorderModal() {
    const modal = document.getElementById('recorderModal');
    const modalBox = document.getElementById('recorderModalBox');
    modalBox.classList.remove('scale-100', 'opacity-100');
    modalBox.classList.add('scale-95', 'opacity-0');
    setTimeout(() => modal.classList.add('hidden'), 150);
}

async function handleRecorderSubmit(event) {
    event.preventDefault();
    const btn = document.getElementById('btnSubmitForm');
    btn.disabled = true;

    const id = document.getElementById('recorderId').value;
    const payload = {
        name: document.getElementById('inputName').value.trim(),
        ip: document.getElementById('inputIp').value.trim(),
        port: parseInt(document.getElementById('inputPort').value) || null,
        brand: document.getElementById('inputBrand').value,
        location: document.getElementById('inputLocation').value.trim(),
        description: document.getElementById('inputDescription').value.trim(),
        is_active: document.getElementById('inputIsActive').checked,
        snapshot_channel: parseInt(document.getElementById('inputSnapshotChannel').value) || 1,
        snapshot_user: document.getElementById('inputSnapshotUser').value.trim(),
        snapshot_password: document.getElementById('inputSnapshotPassword').value,
        storage_status: document.getElementById('inputStorageStatus').value,
        storage_info: document.getElementById('inputStorageInfo').value.trim()
    };

    try {
        let res;
        if (id) {
            res = await fetch(`/api/recorders/${id}`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify(payload)
            });
        } else {
            res = await fetch('/api/recorders', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(payload)
            });
        }

        if (res.ok) {
            closeRecorderModal();
            showToast(id ? 'Gravador atualizado com sucesso!' : 'Gravador cadastrado com sucesso!', 'success');
            await loadRecorders();
            await loadStats();
        } else {
            const errData = await res.json();
            showToast(errData.detail || 'Erro ao salvar gravador.', 'error');
        }
    } catch (e) {
        console.error('Erro na requisição:', e);
        showToast('Falha na comunicação com o servidor.', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function checkRecorderNow(id, btnElement) {
    if (btnElement) {
        const icon = btnElement.querySelector('i');
        if (icon) icon.classList.add('animate-spin');
    }

    try {
        const res = await fetch(`/api/recorders/${id}/check`, {
            method: 'POST',
            headers: getAuthHeaders(false)
        });
        if (res.ok) {
            const updated = await res.json();
            updateRecorderInList(updated);
            loadStats();
            showToast(`Conexão com '${updated.name}': ${updated.status.toUpperCase()} (${updated.latency_ms} ms)`, updated.status === 'online' ? 'success' : 'error');
        } else {
            const err = await res.json();
            showToast(err.detail || 'Erro ao testar conexão.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Erro ao testar gravador.', 'error');
    } finally {
        if (btnElement) {
            const icon = btnElement.querySelector('i');
            if (icon) icon.classList.remove('animate-spin');
        }
    }
}

async function deleteRecorderPrompt(id, name) {
    if (confirm(`Tem certeza que deseja excluir o gravador "${name}" do monitoramento?`)) {
        try {
            const res = await fetch(`/api/recorders/${id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(false)
            });
            if (res.ok) {
                showToast(`Gravador "${name}" excluído.`, 'info');
                await loadRecorders();
                await loadStats();
            } else {
                const err = await res.json();
                showToast(err.detail || 'Erro ao excluir gravador.', 'error');
            }
        } catch (e) {
            console.error(e);
            showToast('Erro ao excluir gravador.', 'error');
        }
    }
}

// Modal Histórico de Incidentes
async function openLogsModal() {
    const modal = document.getElementById('logsModal');
    const tbody = document.getElementById('logsTableBody');
    const empty = document.getElementById('emptyLogsMsg');

    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-slate-500">Carregando histórico...</td></tr>';
    modal.classList.remove('hidden');

    try {
        const res = await fetch('/api/logs?limit=50', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const logs = await res.json();
            if (logs.length === 0) {
                tbody.innerHTML = '';
                empty.classList.remove('hidden');
            } else {
                empty.classList.add('hidden');
                tbody.innerHTML = logs.map(log => {
                    const isDown = log.event_type === 'offline';
                    const badge = isDown 
                        ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400">OFFLINE</span>'
                        : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400">ONLINE</span>';
                    return `
                        <tr class="hover:bg-dark-700/30">
                            <td class="py-2.5 px-3 font-mono text-slate-400">${log.created_at}</td>
                            <td class="py-2.5 px-3 font-semibold text-white">${escapeHtml(log.recorder_name)}</td>
                            <td class="py-2.5 px-3 font-mono">
                                <a href="${getRecorderWebUrl(log.recorder_ip)}" target="_blank" rel="noopener noreferrer" 
                                   title="Acessar interface web do gravador (${escapeHtml(log.recorder_ip)}) em nova aba" 
                                   class="text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1 transition">
                                    <span>${escapeHtml(log.recorder_ip)}</span>
                                    <i data-lucide="external-link" class="w-2.5 h-2.5 text-cyan-500/70"></i>
                                </a>
                            </td>
                            <td class="py-2.5 px-3">${badge}</td>
                            <td class="py-2.5 px-3 text-slate-400">${escapeHtml(log.message || '-')}</td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.error(e);
    }
    lucide.createIcons();
}

function closeLogsModal() {
    document.getElementById('logsModal').classList.add('hidden');
}

async function clearIncidentLogs() {
    if (confirm('Deseja realmente limpar todo o histórico de incidentes registrados?')) {
        try {
            const res = await fetch('/api/logs', {
                method: 'DELETE',
                headers: getAuthHeaders(false)
            });
            if (res.ok) {
                openLogsModal();
                showToast('Histórico limpo com sucesso.', 'info');
            }
        } catch (e) {
            console.error(e);
        }
    }
}

// Modal Configurações
async function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    try {
        const res = await fetch('/api/settings', { headers: getAuthHeaders(false) });
        if (res.ok) {
            const data = await res.json();
            document.getElementById('settingInterval').value = data.check_interval;
            document.getElementById('settingSound').checked = data.sound_alert_enabled;
        }
    } catch (e) {
        console.error(e);
    }
    modal.classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('hidden');
}

async function saveSettings() {
    const interval = parseInt(document.getElementById('settingInterval').value) || 10;
    const sound = document.getElementById('settingSound').checked;

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                check_interval: interval,
                sound_alert_enabled: sound
            })
        });
        if (res.ok) {
            soundAlertEnabled = sound;
            updateSoundButtonUI();
            closeSettingsModal();
            showToast('Configurações salvas com sucesso!', 'success');
        }
    } catch (e) {
        console.error(e);
        showToast('Erro ao salvar configurações.', 'error');
    }
}

// Toast Notifications System
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');

    let bgClass = 'bg-dark-800 border-dark-600 text-slate-100';
    let iconName = 'info';
    let iconColor = 'text-blue-400';

    if (type === 'error') {
        bgClass = 'bg-dark-800 border-rose-500/50 text-white shadow-rose-900/20';
        iconName = 'alert-octagon';
        iconColor = 'text-rose-400';
    } else if (type === 'success') {
        bgClass = 'bg-dark-800 border-emerald-500/50 text-white shadow-emerald-900/20';
        iconName = 'check-circle-2';
        iconColor = 'text-emerald-400';
    }

    toast.className = `pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-xl transition-all duration-300 transform translate-y-2 opacity-0 text-xs ${bgClass}`;
    toast.innerHTML = `
        <i data-lucide="${iconName}" class="w-4 h-4 ${iconColor} flex-shrink-0 mt-0.5"></i>
        <div class="flex-1 font-medium leading-relaxed">${escapeHtml(message)}</div>
        <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white p-0.5"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
    }, 10);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==================== BACKUP DO BANCO DE DADOS ====================
async function downloadDatabaseBackup() {
    try {
        showToast('Preparando backup seguro do banco de dados...', 'info');
        const res = await fetch('/api/admin/backup/download', {
            headers: getAuthHeaders(false)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Erro ao baixar backup.' }));
            showToast(err.detail || 'Falha ao baixar backup.', 'error');
            return;
        }
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        a.download = `cftv_backup_${now}.db`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        showToast('Backup baixado com sucesso!', 'success');
    } catch (e) {
        console.error(e);
        showToast('Erro de conexão ao baixar backup.', 'error');
    }
}

// ==================== TELEGRAM BOT INTEGRATION ====================
async function loadTelegramSettings() {
    try {
        const res = await fetch('/api/settings', { headers: getAuthHeaders(false) });
        if (!res.ok) return;
        const s = await res.json();
        
        const enabledEl = document.getElementById('tg_enabled');
        const tokenEl = document.getElementById('tg_bot_token');
        const chatEl = document.getElementById('tg_chat_id');
        const offEl = document.getElementById('tg_notify_offline');
        const onEl = document.getElementById('tg_notify_online');
        const hdEl = document.getElementById('tg_notify_hd');

        if (enabledEl) enabledEl.checked = !!s.telegram_enabled;
        if (tokenEl) tokenEl.value = s.telegram_bot_token || '';
        if (chatEl) chatEl.value = s.telegram_chat_id || '';
        if (offEl) offEl.checked = s.telegram_notify_offline !== false;
        if (onEl) onEl.checked = s.telegram_notify_online !== false;
        if (hdEl) hdEl.checked = s.telegram_notify_hd !== false;

        const feedback = document.getElementById('tgTestFeedback');
        if (feedback) feedback.classList.add('hidden');
    } catch (e) {
        console.error('Erro ao carregar configurações do Telegram:', e);
    }
}

async function saveTelegramSettings(event) {
    if (event) event.preventDefault();
    
    const payload = {
        telegram_enabled: document.getElementById('tg_enabled')?.checked || false,
        telegram_bot_token: document.getElementById('tg_bot_token')?.value?.trim() || '',
        telegram_chat_id: document.getElementById('tg_chat_id')?.value?.trim() || '',
        telegram_notify_offline: document.getElementById('tg_notify_offline')?.checked || false,
        telegram_notify_online: document.getElementById('tg_notify_online')?.checked || false,
        telegram_notify_hd: document.getElementById('tg_notify_hd')?.checked || false
    };

    const btn = document.getElementById('btnSaveTg');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Salvando...</span>';

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showToast('Configurações do Telegram salvas com sucesso!', 'success');
        } else {
            const err = await res.json().catch(() => ({ detail: 'Erro ao salvar.' }));
            showToast(err.detail || 'Falha ao salvar configurações.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Erro de conexão ao salvar configurações.', 'error');
    } finally {
        if (btn) btn.innerHTML = originalText;
        lucide.createIcons();
    }
}

async function testTelegramBot() {
    const feedback = document.getElementById('tgTestFeedback');
    const btn = document.getElementById('btnTestTg');

    const bot_token = document.getElementById('tg_bot_token')?.value?.trim() || '';
    const chat_id = document.getElementById('tg_chat_id')?.value?.trim() || '';

    if (!bot_token) {
        showToast('Preencha o Token do Bot antes de disparar o teste!', 'error');
        document.getElementById('tg_bot_token')?.focus();
        return;
    }
    if (!chat_id) {
        showToast('Preencha o Chat ID antes de disparar o teste!', 'error');
        document.getElementById('tg_chat_id')?.focus();
        return;
    }

    const payload = {
        telegram_bot_token: bot_token,
        telegram_chat_id: chat_id
    };

    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-sky-400"></i><span>Enviando Teste...</span>';
    }

    if (feedback) {
        feedback.className = 'p-3.5 rounded-xl text-xs flex items-center gap-3 bg-dark-900 border border-dark-700 text-slate-300';
        feedback.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-sky-400"></i><span>Conectando à API do Telegram...</span>';
        feedback.classList.remove('hidden');
        lucide.createIcons();
    }

    try {
        const res = await fetch('/api/settings/test-telegram', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (feedback) {
            if (res.ok && data.success) {
                feedback.className = 'p-3.5 rounded-xl text-xs flex items-start gap-3 bg-sky-950/40 border border-sky-500/40 text-sky-300';
                feedback.innerHTML = `
                    <i data-lucide="check-circle" class="w-4 h-4 text-sky-400 mt-0.5 flex-shrink-0"></i>
                    <div>
                        <span class="font-bold text-sky-200">Mensagem entregue com sucesso! (Status HTTP ${data.status_code})</span>
                        <p class="text-[11px] text-sky-400/80 mt-0.5">Verifique seu Telegram! A mensagem de teste chegou ao destino configurado.</p>
                    </div>
                `;
                showToast('Mensagem de teste enviada com sucesso para o Telegram!', 'success');
            } else {
                feedback.className = 'p-3.5 rounded-xl text-xs flex items-start gap-3 bg-rose-950/40 border border-rose-500/40 text-rose-300';
                feedback.innerHTML = `
                    <i data-lucide="alert-triangle" class="w-4 h-4 text-rose-400 mt-0.5 flex-shrink-0"></i>
                    <div>
                        <span class="font-bold text-rose-200">Falha ao enviar para o Telegram (Status HTTP ${data.status_code || res.status}):</span>
                        <p class="text-[11px] text-rose-300/80 mt-0.5 font-mono break-all">${escapeHtml(data.response || data.detail || 'Erro ao conectar ao Telegram.')}</p>
                    </div>
                `;
                showToast('Falha no envio do teste de Telegram. Confira o erro na tela.', 'error');
            }
        }
    } catch (e) {
        console.error(e);
        if (feedback) {
            feedback.className = 'p-3.5 rounded-xl text-xs flex items-start gap-3 bg-rose-950/40 border border-rose-500/40 text-rose-300';
            feedback.innerHTML = `
                <i data-lucide="alert-octagon" class="w-4 h-4 text-rose-400 mt-0.5 flex-shrink-0"></i>
                <div>
                    <span class="font-bold text-rose-200">Erro de Conexão:</span>
                    <p class="text-[11px] text-rose-300/80 mt-0.5">${escapeHtml(e.message)}</p>
                </div>
            `;
        }
        showToast('Erro de conexão ao testar Telegram.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
        lucide.createIcons();
    }
}

function togglePasswordVisibility(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
}

