#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const { getOrCreateToken, validateToken, TOKEN_FILE } = require('./auth.js');

const WS_PORT = 8765;
const extensionClients = new Set();
const mcpClients = new Set();
const pendingRequests = new Map();

// Initialize or retrieve secret token
const activeToken = getOrCreateToken();

function getActiveExtension() {
  for (const ws of extensionClients) {
    if (ws.readyState === 1) return ws;
  }
  return null;
}

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const isMcp = parsedUrl.pathname.includes('mcp');
  const tokenParam = parsedUrl.searchParams.get('token');
  const origin = req.headers.origin;

  console.log(`[Bridge Daemon] Connection attempt: isMcp=${isMcp}, Origin=${origin}, TokenPresent=${!!tokenParam}, TokenValid=${validateToken(tokenParam)}`);

  // 1. Cross-Site WebSocket Hijacking (CSWSH) Protection
  // Malicious websites running in any browser will send Origin: http:// or https://
  if (origin) {
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      console.warn(`[Bridge Daemon] Rejected untrusted web origin: ${origin}`);
      ws.close(4003, 'Forbidden: Web origins are not permitted');
      return;
    }
    // MCP client is a local backend process and should never have a web browser origin
    if (isMcp && (origin.startsWith('http://') || origin.startsWith('https://') || origin.startsWith('chrome-extension://'))) {
      console.warn(`[Bridge Daemon] Rejected MCP connection with browser origin: ${origin}`);
      ws.close(4003, 'Forbidden: MCP client cannot have browser origin');
      return;
    }
  }

  // 2. Token Authentication
  let isAuthenticated = validateToken(tokenParam);
  let authTimeout = null;

  const handleAuthenticatedClient = () => {
    if (isMcp) {
      console.log('[Bridge Daemon] MCP Server client connected and authenticated');
      mcpClients.add(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action === 'auth') return; // already authenticated

          const activeExt = getActiveExtension();
          // Forward action to Chrome Extension
          if (activeExt) {
            pendingRequests.set(msg.id, ws);
            activeExt.send(JSON.stringify(msg));
          } else {
            ws.send(JSON.stringify({
              id: msg.id,
              error: 'Chrome Extension is not connected or not authenticated. Please make sure Google Chrome is open with the paired token.'
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
    } else {
      console.log('[Bridge Daemon] Chrome Extension connected and authenticated');
      for (const oldWs of extensionClients) {
        if (oldWs !== ws && oldWs.readyState === 1) {
          try {
            oldWs.close();
          } catch (e) {}
        }
      }
      extensionClients.clear();
      extensionClients.add(ws);

      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.action === 'heartbeat_ack' || response.action === 'auth') return;

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
    }

    try {
      ws.send(JSON.stringify({ action: 'auth_success', client: isMcp ? 'mcp' : 'extension' }));
    } catch (e) {}
  };

  if (isAuthenticated) {
    handleAuthenticatedClient();
  } else {
    // Give client 3 seconds to send an auth message
    authTimeout = setTimeout(() => {
      console.warn(`[Bridge Daemon] Disconnecting unauthenticated ${isMcp ? 'MCP' : 'Extension'} client (timeout)`);
      try {
        ws.send(JSON.stringify({ action: 'auth_error', error: 'Authentication timeout: Valid token required' }));
      } catch (e) {}
      ws.close(4001, 'Unauthorized');
    }, 3000);

    const initialMessageHandler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === 'auth' && validateToken(msg.token)) {
          clearTimeout(authTimeout);
          isAuthenticated = true;
          ws.removeListener('message', initialMessageHandler);
          handleAuthenticatedClient();
          return;
        }
      } catch (e) {}

      // Invalid token or non-auth message while unauthenticated
      clearTimeout(authTimeout);
      console.warn(`[Bridge Daemon] Authentication failed for ${isMcp ? 'MCP' : 'Extension'} client`);
      try {
        ws.send(JSON.stringify({ action: 'auth_error', error: 'Invalid authentication token' }));
      } catch (e) {}
      ws.close(4001, 'Unauthorized');
    };

    ws.on('message', initialMessageHandler);
    ws.on('close', () => clearTimeout(authTimeout));
  }
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
console.log(`[Bridge Daemon] Security Token: ${activeToken}`);
console.log(`[Bridge Daemon] Token file: ${TOKEN_FILE}`);
