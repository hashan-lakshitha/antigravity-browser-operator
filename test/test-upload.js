const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

async function testUpload() {
  const token = getOrCreateToken();
  const ws = new WebSocket('ws://127.0.0.1:8765/mcp?token=' + encodeURIComponent(token));

  await new Promise((resolve) => ws.on('open', resolve));
  console.log('Connected to bridge');

  // Let's send evaluate to test Page.setInterceptFileChooserDialog on tab 1217015007
  // Or send an action
}
