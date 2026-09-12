// Test WebSocket client to simulate the Chrome Extension
const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:8765');

ws.on('open', () => {
  console.log('Test Extension Connected to Bridge!');
});

ws.on('message', (data) => {
  console.log('Received action from MCP Server:', data.toString());
  const msg = JSON.parse(data.toString());
  
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
