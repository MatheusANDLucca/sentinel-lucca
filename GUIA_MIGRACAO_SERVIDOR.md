# 📘 Guia Completo de Migração e Instalação em Servidor
## Sentinel Lucca (CFTV Sentinel + Print Sentinel)

Este guia foi elaborado para permitir que você migre ou instale o **Sentinel Lucca** em outro computador ou servidor (Windows ou Linux) mantendo 100% dos dados, gravadores, impressoras e usuários cadastrados.

---

## 🗂️ O que precisa ser copiado da máquina atual?

Basta copiar a pasta inteira do projeto:
`c:\Users\TI-4817\Documents\Projeto Sentinel Lucca`

### ⚠️ Dica importante antes de copiar:
- **Pode excluir ou não copiar a pasta `.venv`:** Ela é recriada automaticamente e de forma limpa no novo computador.
- **O arquivo mais importante é:** `data/sentinel.db`. Nele estão gravados todos os seus usuários, gravadores de CFTV, impressoras, histórico de auditoria e senhas.

---

## 🖥️ Cenário A: Instalando em um Servidor Windows (Windows 10, 11 ou Windows Server)

### Passo 1: Instalar o Python
1. Acesse [python.org/downloads](https://www.python.org/downloads/) e baixe a versão estável do Python (3.10 ou superior).
2. Ao executar o instalador, **MUITO IMPORTANTE:**
   - Marque a caixinha: **☑ Add python.exe to PATH** (Adicionar Python ao PATH).
   - Clique em **Install Now**.

### Passo 2: Colocar a pasta no local definitivo
Recomendamos colocar o projeto em um local de fácil acesso para o servidor, por exemplo:
`C:\Sentinel Lucca` ou `C:\Projetos\Sentinel Lucca`

### Passo 3: Liberar a porta 8000 no Firewall do Windows
Para que os outros computadores da rede possam acessar o painel:
1. Abra o **PowerShell como Administrador**.
2. Cole o comando abaixo e tecle Enter:
```powershell
New-NetFirewallRule -DisplayName "Sentinel Lucca (Porta 8000)" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
```

### Passo 4: Primeira Inicialização
1. Abra a pasta do projeto.
2. Dê um duplo clique no arquivo **`run.bat`**.
3. O script irá:
   - Detectar o Python.
   - Criar o ambiente virtual `.venv` isolado.
   - Instalar automaticamente as dependências (`fastapi`, `uvicorn`, `aiosqlite`, `pillow`, etc.).
   - Abrir o navegador em `http://localhost:8000`.

---

## ⚙️ Como colocar o Sentinel Lucca para iniciar automaticamente com o Windows (24/7)

Para que o monitoramento nunca pare e inicie sozinho mesmo se o servidor for reiniciado:

### Método 1: Pelo Agendador de Tarefas do Windows (Sem programas extras)
1. Pressione `Win + R`, digite `taskschd.msc` e tecle Enter.
2. No menu à direita, clique em **Criar Tarefa...** (Create Task).
3. Na aba **Geral**:
   - Nome: `Sentinel Lucca - Servidor`
   - Marque: **Executar estando o usuário conectado ou não**.
   - Marque: **Executar com privilégios mais altos**.
4. Na aba **Disparadores**:
   - Clique em **Novo**.
   - Em "Iniciar a tarefa", selecione: **Na inicialização do sistema** (At startup).
   - Clique em OK.
5. Na aba **Ações**:
   - Clique em **Novo**.
   - Ação: **Iniciar um programa**.
   - Programa/script: `C:\Sentinel Lucca\run.bat`
   - Iniciar em (obrigatório): `C:\Sentinel Lucca\`
   - Clique em OK e salve a tarefa (informe a senha do Windows se solicitado).

---

## 🐧 Cenário B: Instalando em um Servidor Linux (Ubuntu / Debian / AlmaLinux)

Se optar por um servidor Linux (ótimo para servidores dedicados sem interface gráfica):

### Passo 1: Atualizar o sistema e instalar o Python
```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-pip
```

### Passo 2: Copiar o projeto
Coloque o projeto em `/opt/sentinel-lucca` e dê permissões:
```bash
sudo mv "Projeto Sentinel Lucca" /opt/sentinel-lucca
cd /opt/sentinel-lucca
chmod +x run.sh
```

### Passo 3: Executar a instalação inicial
```bash
./run.sh
```

### Passo 4: Criar o serviço contínuo no Linux (systemd)
Crie o arquivo de serviço:
```bash
sudo nano /etc/systemd/system/sentinel.service
```
Cole o conteúdo:
```ini
[Unit]
Description=Sentinel Lucca - Servidor de Monitoramento de TI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sentinel-lucca
ExecStart=/opt/sentinel-lucca/.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
Ative e inicie o serviço:
```bash
sudo systemctl daemon-reload
sudo systemctl enable sentinel
sudo systemctl start sentinel
```

---

## 🌐 Como outros computadores da rede acessam o sistema?

1. No servidor, descubra o IP dele:
   - No Windows: abra o CMD e digite `ipconfig` (Ex: `192.168.1.100` ou `172.16.0.50`).
   - No Linux: digite `hostname -I`.
2. Em qualquer computador, celular ou tablet conectado na mesma rede corporativa, basta abrir o navegador e digitar:
   `http://IP_DO_SERVIDOR:8000`

Exemplo:
`http://192.168.1.100:8000`

---

## 🔒 Checklist de Validação Final
- [ ] O servidor tem acesso aos IPs das impressoras (consegue pingar a porta 9100).
- [ ] O servidor tem acesso aos IPs dos gravadores (consegue pingar a porta 37777).
- [ ] A porta 8000 está liberada no Firewall do servidor.
- [ ] O arquivo `data/sentinel.db` foi copiado mantendo todos os gravadores e impressoras.
