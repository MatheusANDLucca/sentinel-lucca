import json
import logging
from typing import List
from fastapi import WebSocket

logger = logging.getLogger("sentinel.websocket")

class WebSocketManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("Cliente WebSocket conectado. Conexões ativas: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("Cliente WebSocket desconectado. Conexões ativas: %d", len(self.active_connections))

    async def broadcast(self, message: dict):
        """Transmite uma mensagem JSON para todas as telas conectadas."""
        if not self.active_connections:
            return

        payload = json.dumps(message)
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception as e:
                logger.warning("Falha ao enviar mensagem WebSocket para cliente: %s", e)
                disconnected.append(connection)

        for dead_conn in disconnected:
            self.disconnect(dead_conn)

# Instância global compartilhada
ws_manager = WebSocketManager()
