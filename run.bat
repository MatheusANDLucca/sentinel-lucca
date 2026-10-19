@echo off
chcp 65001 > nul
title Sentinel Lucca - Plataforma Unificada

echo ===================================================================
echo       SENTINEL LUCCA - CENTRAL UNIFICADA DE MONITORAMENTO
echo               CFTV Sentinel + Print Sentinel
echo ===================================================================
echo.

cd /d "%~dp0"

IF NOT EXIST ".venv\Scripts\python.exe" (
    echo [INFO] Criando ambiente virtual .venv...
    python -m venv .venv
    echo [INFO] Instalando dependencias do sistema...
    .\.venv\Scripts\pip install -r requirements.txt
)

:: Obter IP local da máquina para acesso via celular e rede
set SERVER_IP=
for /f "delims=" %%I in ('.\.venv\Scripts\python.exe -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()" 2^>nul') do set SERVER_IP=%%I

echo [INFO] Servidor Web iniciando...
echo [INFO] Acesso neste computador (Local):  http://localhost:8000
if defined SERVER_IP (
    echo [INFO] Acesso no Celular / Rede Wi-Fi:  http://%SERVER_IP%:8000
) else (
    echo [INFO] Acesso no Celular / Rede Wi-Fi:  http://SEU_IP:8000
)
echo.
echo [ATENÇÃO - ACESSO VIA CELULAR]:
echo  1. O celular DEVE estar conectado na mesma rede Wi-Fi deste computador.
echo  2. Certifique-se de executar 'liberar_firewall_porta_8000.bat' como Administrador.
echo.
echo Pressione CTRL+C para encerrar o servidor a qualquer momento.
echo.

:: Abrir navegador automaticamente em segundo plano apos 2 segundos
start "" cmd /c "timeout /t 2 /nobreak > nul & start http://localhost:8000"

:: Executar aplicacao FastAPI com Uvicorn
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

pause
