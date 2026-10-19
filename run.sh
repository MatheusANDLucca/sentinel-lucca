#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "==================================================================="
echo "      SENTINEL LUCCA - CENTRAL UNIFICADA DE MONITORAMENTO"
echo "              (CFTV Sentinel + Print Sentinel)"
echo "==================================================================="

if [ ! -d ".venv" ]; then
    echo "[INFO] Criando ambiente virtual .venv..."
    python3 -m venv .venv
    echo "[INFO] Instalando dependências..."
    ./.venv/bin/pip install -r requirements.txt
fi

echo "[INFO] Iniciando servidor em http://0.0.0.0:8000 ..."
./.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
