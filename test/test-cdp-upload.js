const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

async function testCdpUpload() {
  const token = getOrCreateToken();
  const ws = new WebSocket('ws://127.0.0.1:8765/mcp?token=' + encodeURIComponent(token));
  await new Promise(r => ws.on('open', r));

  const tabId = 1217015007;
  const filePath = 'D:\\facebook-ai-agent\\videos\\reel_001_ribeye_steak_asmr.mp4';

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

  // Call upload_file with x and y or ref
  console.log('Sending upload_file action...');
  const res = await send('upload_file', {
    tabId,
    filePath,
    ref: '8'
  });
  console.log('Upload result:', res);
  ws.close();
}

testCdpUpload().catch(console.error);
