const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

async function testCdpType() {
  const token = getOrCreateToken();
  const ws = new WebSocket('ws://127.0.0.1:8765/mcp?token=' + encodeURIComponent(token));
  await new Promise(r => ws.on('open', r));

  const tabId = 1217015007;

  const send = (action, params) => new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, action, params }));
  });

  // Focus the editor
  await send('evaluate', {
    tabId,
    script: `(() => {
      const editor = document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (editor) editor.focus();
    })()`
  });

  // Now let's test executing CDP commands via a test action or evaluate
  // Wait, let's see what happens if we add this to background.js in type action!
}
