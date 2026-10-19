# 🛡️ Sentinel Lucca - Central Unificada de Monitoramento de TI

Plataforma integrada de alta disponibilidade que combina o **CFTV Sentinel** (Monitoramento e Diagnóstico de Gravadores NVR/DVR/HDCVI) e o **Print Sentinel** (Gestão e Teste de Impressoras em Rede).

---

## 🌟 Principais Funcionalidades

1. **Central de Autenticação Unificada:**
   - Tela de Login centralizada (`/login`) protegida por cookies de sessão seguros HTTPOnly e cabeçalho `Authorization: Bearer`.
   - Compatibilidade automática com todas as credenciais e sessões legadas.
   - Perfil de Usuário com Role-Based Access Control (RBAC): **Administrador**, **Operador** e **Visualizador**.

2. **Portal Launcher / Central de Módulos (`/portal`):**
   - Dashboard Hub interativo que exibe os dois projetos integrados em cards dinâmicos.
   - Indicadores ao vivo de Gravadores Online/Offline e Impressoras Online/Alerta/Offline.
   - Acesso inteligente aos módulos conforme as permissões individuais do colaborador.
   - Painel Administrativo Centralizado para gerenciar usuários, conceder acessos a módulos, inspecionar logs de auditoria e baixar backups do banco.

3. **Módulo CFTV Sentinel (`/cftv`):**
   - Varredura de ping em tempo real e monitoramento das portas de serviço (37777, 80, etc.).
   - Monitoramento e diagnóstico da saúde dos Discos Rígidos (HDs) via API HTTP dos gravadores Intelbras/Dahua.
   - Integração com Bot de Alertas do Telegram.
   - Captura de snapshots de segurança.

4. **Módulo Print Sentinel (`/printers`):**
   - Monitoramento contínuo de ping e porta RAW 9100 de todas as impressoras de todas as filiais.
   - Disparo de Teste de Impressão Direto pela rede (Socket RAW 9100) com folha de diagnóstico.
   - Importação em massa de planilhas Excel (.xlsx) e arquivos .csv.
   - Modo Telão (Kiosk) para TVs no NOC / TI.

5. **Controle Granular de Módulos (`allowed_modules`):**
   - O Administrador pode definir no painel se o colaborador tem acesso a:
     - 🌟 **Todos os Módulos** (`all`)
     - 📹 **Apenas CFTV Sentinel** (`cftv`)
     - 🖨️ **Apenas Print Sentinel** (`printers`)
   - Usuários com acesso restrito a um único módulo são redirecionados diretamente para o módulo correspondente após o login e têm a rota do outro módulo bloqueada no backend com HTTP 403.

---

## 🚀 Como Executar

### Pré-requisitos
- Python 3.10+ instalado no sistema.

### No Windows:
Basta clicar duas vezes em **`run.bat`** ou executar no Prompt de Comando / PowerShell:
```bat
.\run.bat
```
*O script detecta o ambiente virtual automaticamente, instala dependências se necessário e abre o navegador em `http://localhost:8000`.*

### No Linux / macOS:
```bash
chmod +x run.sh
./run.sh
```

---

## 📁 Estrutura do Projeto

```text
Projeto Sentinel Lucca/
├── app/
│   ├── __init__.py
│   ├── config.py                 # Configurações globais e paths
│   ├── database.py               # SQLite unificado com auto-migração de legados
│   ├── models.py                 # Modelos Pydantic tipados
│   ├── auth.py                   # PBKDF2 hashing, tokens, RBAC e allowed_modules
│   ├── api_auth.py               # Rotas /api/auth (login, logout, me, senha)
│   ├── api_admin.py              # Rotas /api/admin (usuários, auditoria, backups)
│   ├── api_portal.py             # Rotas /api/portal/summary (KPIs para o Hub)
│   ├── api_cftv.py               # Rotas /api/recorders e /api/cftv/*
│   ├── api_printers.py           # Rotas /api/printers/* e /api/branches
│   ├── websocket_manager.py      # Gerenciador unificado de WebSockets (/ws)
│   ├── monitor_cftv.py           # Worker em background para CFTV
│   ├── monitor_printers.py       # Worker em background para Impressoras
│   ├── snapshot_service.py       # Captura de snapshots RTSP/HTTP
│   ├── telegram_service.py       # Disparo de alertas no Telegram
│   ├── print_service.py          # Envio de testes via socket RAW 9100
│   ├── import_export.py          # Importador nativo de planilhas Excel/CSV
│   └── main.py                   # Entrada FastAPI com montagem de estáticos e workers
├── data/
│   └── sentinel.db               # Banco de dados consolidado
├── static/
│   ├── login.html                # Tela de Login unificada
│   ├── portal/                   # Central de Módulos (Hub)
│   │   ├── index.html
│   │   ├── css/portal.css
│   │   └── js/portal.js
│   ├── cftv/                     # Frontend completo do CFTV Sentinel
│   │   ├── index.html
│   │   ├── css/style.css
│   │   └── js/app.js
│   └── printers/                 # Frontend completo do Print Sentinel
│       ├── index.html
│       ├── css/style.css
│       └── js/app.js
├── run.bat
├── run.sh
├── requirements.txt
└── README.md
```

---

## 🔒 Segurança e Dados Originais
- Os projetos originais (`Project IA` e `Project IA 2`) permanecem **100% intactos e inalterados**.
- Na primeira inicialização, o Sentinel Lucca lê os bancos legados e migra automaticamente todos os usuários, gravadores, impressoras e configurações para `data/sentinel.db`.
