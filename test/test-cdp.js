const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

async function test() {
  const token = getOrCreateToken();
  const ws = new WebSocket('ws://127.0.0.1:8765/mcp?token=' + encodeURIComponent(token));
  await new Promise(r => ws.on('open', r));

  const tabId = 1217015007;

  // Test CDP evaluate
  const send = (action, params) => new Promise((resolve) => {
    const id = Date.now();
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, action, params }));
  });

  const res = await send('evaluate', {
    tabId,
    script: "(() => { return { title: document.title, url: location.href }; })()"
  });
  console.log('Evaluate res:', res);
  ws.close();
}

test().catch(console.error);
