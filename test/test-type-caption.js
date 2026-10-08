const WebSocket = require('ws');
const { getOrCreateToken } = require('../server/auth.js');

async function testSelectAllDelete() {
  const token = getOrCreateToken();
  const ws = new WebSocket('ws://127.0.0.1:8765/mcp?token=' + encodeURIComponent(token));
  await new Promise(r => ws.on('open', r));

  const tabId = 1217015007;

  // Let's attach debugger, focus editor, send Ctrl+A and Backspace
  // In extension background.js, evaluate can run debugger commands or we can use evaluate
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

  const script = `(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return { error: 'No editor' };
    editor.focus();

    // In Draft.js, set content to empty using selection
    const sel = window.getSelection();
    sel.selectAllChildren(editor);
    document.execCommand('delete');
    
    // Check if still not empty
    if (editor.innerText.trim().length > 0) {
      // Force empty block
      while (editor.firstChild) {
        editor.removeChild(editor.firstChild);
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return { text: editor.innerText };
  })()`;

  const res = await send('evaluate', { tabId, script });
  console.log('Cleared result:', res);
  ws.close();
}

testSelectAllDelete().catch(console.error);
