#!/usr/bin/env node
const { WebSocketServer } = require('ws');

const WS_PORT = 8765;
let extensionWs = null;
const mcpClients = new Set();
const pendingRequests = new Map();

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
        // Forward action to Chrome Extension
        if (extensionWs && extensionWs.readyState === 1) {
          pendingRequests.set(msg.id, ws);
          extensionWs.send(JSON.stringify(msg));
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
  extensionWs = ws;

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
    if (extensionWs === ws) extensionWs = null;
  });

  ws.on('error', (err) => {
    console.error('[Bridge Daemon] Extension socket error:', err.message);
  });
});

// Periodic heartbeat to keep Chrome Extension service worker awake
setInterval(() => {
  if (extensionWs && extensionWs.readyState === 1) {
    try {
      extensionWs.send(JSON.stringify({ action: 'heartbeat' }));
    } catch (e) {}
  }
}, 15000);

console.log(`[Bridge Daemon] WebSocket running on ws://127.0.0.1:${WS_PORT}`);
