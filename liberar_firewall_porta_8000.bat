@echo off
chcp 65001 > nul
title Liberar Porta 8000 no Firewall do Windows - Sentinel Lucca

echo ===================================================================
echo     CONFIGURACAO AUTOMATICA DE FIREWALL - PORTA 8000 TCP
echo                      Sentinel Lucca
echo ===================================================================
echo.

:: Verificar se esta rodando como Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERRO] Este script precisa ser executado como Administrador!
    echo.
    echo Por favor, clique com o BOTAO DIREITO neste arquivo e escolha:
    echo "Executar como Administrador"
    echo.
    pause
    exit /b 1
)

echo [INFO] Criando regra de entrada para permitir conexoes na porta 8000...
netsh advfirewall firewall add rule name="Sentinel Lucca (Porta 8000 TCP)" dir=in action=allow protocol=TCP localport=8000

echo.
echo ===================================================================
echo [SUCESSO] Porta 8000 liberada com sucesso no Firewall do Windows!
echo Os computadores da rede agora podem acessar o Sentinel Lucca em:
echo http://SEU_IP:8000
echo ===================================================================
echo.
pause
