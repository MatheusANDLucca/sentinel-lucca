import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import STATIC_DIR, SERVER_HOST, SERVER_PORT
from app.database import init_db
from app.monitor_cftv import cftv_worker
from app.monitor_printers import printer_worker
from app.websocket_manager import ws_manager

from app.api_auth import router as auth_router
from app.api_admin import router as admin_router
from app.api_portal import router as portal_router
from app.api_cftv import router as cftv_router
from app.api_printers import router as printers_router
from app.api_rma import router as rma_router

# Configuração de Logs
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("sentinel.main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Iniciando Projeto Sentinel Lucca (CFTV + Impressoras + RMA Patrimonial)...")
    await init_db()
    await cftv_worker.start()
    await printer_worker.start()
    yield
    logger.info("Encerrando Projeto Sentinel Lucca...")
    await cftv_worker.stop()
    await printer_worker.stop()

app = FastAPI(
    title="Projeto Sentinel Lucca",
    description="Sistema Centralizado de CFTV, Impressoras em Rede e Controle Patrimonial / RMA.",
    version="2.1.0",
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Roteadores da API
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(portal_router)
app.include_router(cftv_router)
app.include_router(printers_router)
app.include_router(rma_router)

# WebSocket Unificado e Endpoints Específicos
@app.websocket("/ws")
@app.websocket("/ws/cftv")
@app.websocket("/ws/printers")
@app.websocket("/ws/rma")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text('{"type":"PONG"}')
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.error("Exceção na conexão WebSocket: %s", e)
        ws_manager.disconnect(websocket)

# Montagem de Arquivos Estáticos
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Rotas de Frontend
@app.get("/")
@app.get("/portal")
@app.get("/hub")
async def serve_portal():
    return FileResponse(str(STATIC_DIR / "portal" / "index.html"))

@app.get("/login")
@app.get("/login.html")
async def serve_login():
    return FileResponse(str(STATIC_DIR / "login.html"))

@app.get("/cftv")
@app.get("/cftv/")
async def serve_cftv():
    return FileResponse(str(STATIC_DIR / "cftv" / "index.html"))

@app.get("/printers")
@app.get("/printers/")
async def serve_printers():
    return FileResponse(str(STATIC_DIR / "printers" / "index.html"))

@app.get("/rma")
@app.get("/rma/")
async def serve_rma():
    return FileResponse(str(STATIC_DIR / "rma" / "index.html"))

@app.get("/rma/print")
@app.get("/rma/print/{request_id}")
async def serve_rma_print(request_id: Optional[int] = None):
    return FileResponse(str(STATIC_DIR / "rma" / "print.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=SERVER_HOST, port=SERVER_PORT, reload=True)
