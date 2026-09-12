#!/usr/bin/env node
const { WebSocketServer } = require('ws');

const WS_PORT = 8765;
const extensionClients = new Set();
const mcpClients = new Set();
const pendingRequests = new Map();

function getActiveExtension() {
  for (const ws of extensionClients) {
    if (ws.readyState === 1) return ws;
  }
  return null;
}

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws, req) => {
  const url = req.url || '';

  // If MCP server connects (e.g. ws://127.0.0.1:8765/mcp)
  if (url.includes('mcp')) {
    console.log('[Bridge Daemon] MCP Server client connected');
    mcpClients.add(ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const activeExt = getActiveExtension();
        // Forward action to Chrome Extension
        if (activeExt) {
          pendingRequests.set(msg.id, ws);
          activeExt.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({
            id: msg.id,
            error: 'Chrome Extension is not connected. Please make sure Google Chrome is open.'
          }));
        }
      } catch (e) {
        console.error('[Bridge Daemon] Error forwarding MCP request:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Bridge Daemon] MCP Server disconnected');
      mcpClients.delete(ws);
    });

    return;
  }

  // Otherwise, it's the Chrome Extension connecting!
  console.log('[Bridge Daemon] Chrome Extension connected');
  extensionClients.add(ws);

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      if (response.action === 'heartbeat_ack') return;

      const { id } = response;
      if (pendingRequests.has(id)) {
        const mcpClient = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (mcpClient && mcpClient.readyState === 1) {
          mcpClient.send(JSON.stringify(response));
        }
      }
    } catch (e) {
      console.error('[Bridge Daemon] Error handling extension response:', e);
    }
  });

  ws.on('close', () => {
    console.log('[Bridge Daemon] Chrome Extension disconnected');
    extensionClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Bridge Daemon] Extension socket error:', err.message);
    extensionClients.delete(ws);
  });
});

// Periodic heartbeat to keep Chrome Extension service worker awake
setInterval(() => {
  for (const ws of extensionClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ action: 'heartbeat' }));
      } catch (e) {}
    }
  }
}, 10000);

console.log(`[Bridge Daemon] WebSocket running on ws://127.0.0.1:${WS_PORT}`);
