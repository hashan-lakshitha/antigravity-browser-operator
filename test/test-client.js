// Test WebSocket client to simulate the Chrome Extension
const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

const token = getOrCreateToken();
const ws = new WebSocket(`ws://127.0.0.1:8765?token=${encodeURIComponent(token)}`);

ws.on('open', () => {
  console.log('Test Extension Connected and Authenticated to Bridge!');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.action === 'auth_success' || msg.action === 'heartbeat') return;

  console.log('Received action from MCP Server:', data.toString());
  
  if (msg.action === 'list_tabs') {
    ws.send(JSON.stringify({
      id: msg.id,
      result: [
        { id: 1, title: 'LinkedIn', url: 'https://www.linkedin.com/feed/', active: true },
        { id: 2, title: 'GitHub', url: 'https://github.com', active: false }
      ]
    }));
  } else {
    ws.send(JSON.stringify({
      id: msg.id,
      result: { success: true, echoedAction: msg.action }
    }));
  }
});
