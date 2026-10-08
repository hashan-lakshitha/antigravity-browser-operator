// Antigravity Browser Operator - Background Service Worker
const WS_URL = 'ws://127.0.0.1:8765';
let socket = null;
let isConnected = false;
let authRequired = false;
let authError = null;
let reconnectTimer = null;
let isConnecting = false;

console.log('[Antigravity] Background service worker initialized');

// Storage helper functions for security token
async function getStoredToken() {
  try {
    const data = await chrome.storage.local.get(['antigravity_token']);
    return data.antigravity_token ? data.antigravity_token.trim() : null;
  } catch (e) {
    return null;
  }
}

async function setStoredToken(token) {
  try {
    if (token && token.trim()) {
      await chrome.storage.local.set({ antigravity_token: token.trim() });
    } else {
      await chrome.storage.local.remove('antigravity_token');
    }
    authRequired = false;
    authError = null;
    if (socket) {
      try {
        const oldSocket = socket;
        socket = null;
        oldSocket.close();
      } catch (e) {}
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectBridge();
  } catch (e) {
    console.error('[Antigravity] Failed to save token:', e);
  }
}

// Connect to local Antigravity MCP Bridge
async function connectBridge() {
  if (isConnecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  try {
    const token = await getStoredToken();
    if (!token) {
      console.warn('[Antigravity] No auth token found. Token configuration required.');
      isConnected = false;
      authRequired = true;
      authError = 'Security token required. Please enter the token in the extension popup.';
      notifyPopup({ type: 'STATUS_CHANGE', connected: false, authRequired, authError });
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const bridgeUrl = `${WS_URL}?token=${encodeURIComponent(token)}`;
    const currentWs = new WebSocket(bridgeUrl);
    socket = currentWs;

    currentWs.onopen = () => {
      console.log('[Antigravity] Connected to Local MCP Bridge at', WS_URL);
    };

    currentWs.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        // Handle authentication events
        if (message.action === 'auth_success') {
          console.log('[Antigravity] Authenticated with Bridge');
          isConnected = true;
          authRequired = false;
          authError = null;
          notifyPopup({ type: 'STATUS_CHANGE', connected: true, authRequired: false });
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          return;
        }

        if (message.action === 'auth_error') {
          console.warn('[Antigravity] Authentication failed:', message.error);
          isConnected = false;
          authRequired = true;
          authError = message.error;
          notifyPopup({ type: 'STATUS_CHANGE', connected: false, authRequired: true, authError });
          return;
        }

        // Handle heartbeat from server to keep service worker alive
        if (message.action === 'heartbeat') {
          if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify({ action: 'heartbeat_ack', time: Date.now() }));
          }
          return;
        }

        const { id, action, params } = message;
        console.log(`[Antigravity] Action: ${action} (ID: ${id})`, params);

        let result = null;
        let error = null;

        try {
          result = await handleAction(action, params);
        } catch (err) {
          console.error(`[Antigravity] Error in ${action}:`, err);
          error = err.message || String(err);
        }

        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ id, result, error }));
        }
      } catch (e) {
        console.error('[Antigravity] Failed to process message:', e);
      }
    };

    currentWs.onclose = (event) => {
      if (socket === currentWs) {
        socket = null;
        isConnected = false;
        if (event.code === 4001 || event.code === 4003) {
          authRequired = true;
          authError = 'Authentication failed. Please verify your security token.';
        }
        notifyPopup({ type: 'STATUS_CHANGE', connected: false, authRequired, authError });
        scheduleReconnect();
      }
    };

    currentWs.onerror = () => {
      if (socket === currentWs) {
        isConnected = false;
      }
    };
  } catch (err) {
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 2500);
}

// Keep service worker alive and reconnect on any browser activity
chrome.alarms.create('antigravity_keepalive', { periodInMinutes: 0.2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'antigravity_keepalive' && (!socket || socket.readyState !== WebSocket.OPEN)) {
    connectBridge();
  }
});

chrome.tabs.onActivated.addListener(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectBridge();
  }
});
chrome.tabs.onUpdated.addListener(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectBridge();
  }
});

// Notify popup UI if open
function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Main Action Dispatcher
async function handleAction(action, params = {}) {
  switch (action) {
    case 'ping':
      return { pong: true, time: Date.now() };

    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        favIconUrl: t.favIconUrl,
        windowId: t.windowId
      }));
    }

    case 'get_active_tab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? { id: tab.id, title: tab.title, url: tab.url } : null;
    }

    case 'select_tab': {
      const tabId = parseInt(params.tabId, 10);
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (tab && tab.windowId) {
        try {
          const win = await chrome.windows.get(tab.windowId);
          const updateInfo = { focused: true };
          if (win.state === 'minimized') {
            updateInfo.state = 'normal';
          }
          await chrome.windows.update(tab.windowId, updateInfo);
        } catch (e) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
      return { success: true, tabId };
    }

    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: params.url || 'https://www.google.com' });
      return { success: true, tabId: tab.id, url: tab.url };
    }

    case 'close_tab': {
      const tabId = parseInt(params.tabId, 10);
      await chrome.tabs.remove(tabId);
      return { success: true };
    }

    case 'navigate': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      await chrome.tabs.update(tabId, { url: params.url });

      // Wait for tab to complete loading (up to 15s)
      await new Promise((resolve) => {
        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });

      const updatedTab = await chrome.tabs.get(tabId);
      return { success: true, tabId, title: updatedTab.title, url: updatedTab.url };
    }

    case 'screenshot': {
      let windowId = null;
      let targetTabId = null;
      if (params.tabId) {
        targetTabId = parseInt(params.tabId, 10);
        const tab = await chrome.tabs.get(targetTabId);
        windowId = tab.windowId;
      }
      if (windowId) {
        try {
          const win = await chrome.windows.get(windowId);
          if (win.state === 'minimized') {
            await chrome.windows.update(windowId, { state: 'normal', focused: true });
            await new Promise(r => setTimeout(r, 400));
          }
        } catch (e) {}
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        return { success: true, dataUrl };
      } catch (err) {
        if (targetTabId) {
          try {
            await chrome.debugger.attach({ tabId: targetTabId }, '1.3');
            try {
              const res = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.captureScreenshot', { format: 'png' });
              if (res && res.data) {
                return { success: true, dataUrl: 'data:image/png;base64,' + res.data };
              }
            } finally {
              try { await chrome.debugger.detach({ tabId: targetTabId }); } catch(e){}
            }
          } catch (dbgErr) {}
        }
        throw err;
      }
    }

    case 'get_dom': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => ({ text: a.innerText.trim(), href: a.href }))
            .filter(l => l.text.length > 0)
            .slice(0, 100);

          // Tag and index visible interactive elements
          const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], label, summary';
          const candidates = Array.from(document.querySelectorAll(interactiveSelectors));
          
          let refCounter = 1;
          const elements = [];
          for (const el of candidates) {
            // Check visibility
            const rect = el.getBoundingClientRect();
            const isVisible = (rect.width > 0 || rect.height > 0) && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';
            if (!isVisible) continue;

            const ref = String(refCounter++);
            el.setAttribute('data-ag-ref', ref);

            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 80);
            elements.push({
              ref,
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              role: el.getAttribute('role') || undefined,
              text: text || undefined,
              name: el.name || undefined,
              placeholder: el.placeholder || undefined,
              href: el.href ? el.href.slice(0, 120) : undefined,
              checked: typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') === 'true' ? true : (el.getAttribute('aria-checked') === 'false' ? false : undefined))
            });

            if (elements.length >= 150) break;
          }

          return {
            title: document.title,
            url: window.location.href,
            innerText: document.body ? document.body.innerText.slice(0, 50000) : '',
            links,
            elements
          };
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'click': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.selector || null, params.text || null, params.ref || null, params.x !== undefined ? params.x : null, params.y !== undefined ? params.y : null],
        func: (selector, text, ref, x, y) => {
          let el = null;
          if (x !== null && y !== null) {
            el = document.elementFromPoint(x, y);
            if (!el) {
              return { success: true, tagName: 'COORDINATE', text: '', x, y };
            }
          }
          if (!el && ref) {
            el = document.querySelector(`[data-ag-ref="${ref}"]`);
          }
          if (!el && selector) {
            el = document.querySelector(selector);
          }
          if (!el && text) {
            const lowerText = text.toLowerCase().trim();
            // 1. Check interactive elements for exact match
            const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [onclick], label, summary, li';
            const candidates = Array.from(document.querySelectorAll(interactiveSelectors));
            el = candidates.find(c => {
              const t = (c.innerText || c.getAttribute('aria-label') || c.getAttribute('title') || '').toLowerCase().trim();
              return t === lowerText;
            });

            // 2. Check leaf elements for exact match
            if (!el) {
              const leaves = Array.from(document.querySelectorAll('body *:not(script):not(style):not(noscript):not(svg):not(path)'))
                .filter(c => c.children.length === 0);
              el = leaves.find(c => (c.innerText || '').toLowerCase().trim() === lowerText);
            }

            // 3. Check candidates for substring match, innermost/shortest text first
            if (!el) {
              const matches = candidates.filter(c => {
                const t = (c.innerText || c.value || c.getAttribute('aria-label') || c.getAttribute('title') || '').toLowerCase();
                return t.includes(lowerText);
              });
              matches.sort((a, b) => (a.innerText || a.value || '').length - (b.innerText || b.value || '').length);
              el = matches[0];
            }

            // 4. Check any visible element, innermost/shortest text first
            if (!el) {
              const nonCodeElements = Array.from(document.querySelectorAll('body *:not(script):not(style):not(noscript):not(svg):not(path)'))
                .filter(c => (c.innerText || '').toLowerCase().includes(lowerText));
              nonCodeElements.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
              el = nonCodeElements[0];
            }
          }
          if (!el) {
            return { success: false, error: 'Element not found' };
          }
          el.scrollIntoView({ block: 'center' });
          el.focus();
          const mouseOpts = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch (e) {}
          try { el.dispatchEvent(new PointerEvent('pointerup', mouseOpts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch (e) {}
          el.click();

          const rect = el.getBoundingClientRect();
          return {
            success: true,
            tagName: el.tagName,
            ref: el.getAttribute('data-ag-ref') || undefined,
            text: (el.innerText || el.value || '').trim().slice(0, 100),
            x: x !== null ? x : Math.round(rect.left + rect.width / 2),
            y: y !== null ? y : Math.round(rect.top + rect.height / 2)
          };
        }
      });

      const res = injectionResults[0]?.result || {};
      if (res.x !== undefined && res.y !== undefined && res.x > 0 && res.y > 0) {
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          try {
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: res.x,
              y: res.y,
              button: 'left',
              clickCount: 1
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: res.x,
              y: res.y,
              button: 'left',
              clickCount: 1
            });
          } finally {
            try { await chrome.debugger.detach({ tabId }); } catch (e) {}
          }
        } catch (dbgErr) {}
      }
      return res;
    }

    case 'type': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.selector || null, params.text || '', !!params.pressEnter, params.ref || null],
        func: (selector, text, pressEnter, ref) => {
          let el = null;
          if (ref) {
            el = document.querySelector(`[data-ag-ref="${ref}"]`);
          }
          if (!el && selector) {
            el = document.querySelector(selector);
          }
          if (!el) {
            el = document.activeElement;
          }
          if (!el) return { success: false, error: 'Target input element not found' };

          el.focus();
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.innerText = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (pressEnter) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }
          return { success: true, ref: el.getAttribute('data-ag-ref') || undefined };
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'select_option': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.selector || null, params.ref || null, params.value || null, params.text || null],
        func: (selector, ref, value, text) => {
          let el = null;
          if (ref) el = document.querySelector(`[data-ag-ref="${ref}"]`);
          if (!el && selector) el = document.querySelector(selector);
          if (!el) return { success: false, error: 'Select element not found' };

          if (el.tagName !== 'SELECT') {
            const option = el.querySelector(`[data-value="${value}"], [value="${value}"]`) ||
              Array.from(el.querySelectorAll('*')).find(o => (o.innerText || '').trim() === text);
            if (option) {
              option.click();
              return { success: true, selectedText: option.innerText };
            }
            return { success: false, error: 'Element is not a <select> and matching option was not found' };
          }

          let selected = false;
          for (let i = 0; i < el.options.length; i++) {
            const opt = el.options[i];
            if ((value && opt.value === value) || (text && opt.text.trim().toLowerCase() === text.trim().toLowerCase())) {
              el.selectedIndex = i;
              selected = true;
              break;
            }
          }
          if (!selected && value) {
            el.value = value;
            selected = true;
          }
          if (!selected) {
            return { success: false, error: `Option with value="${value}" or text="${text}" not found` };
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selectedIndex: el.selectedIndex, value: el.value, text: el.options[el.selectedIndex]?.text };
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'set_checked': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.selector || null, params.ref || null, params.checked !== false],
        func: (selector, ref, checked) => {
          let el = null;
          if (ref) el = document.querySelector(`[data-ag-ref="${ref}"]`);
          if (!el && selector) el = document.querySelector(selector);
          if (!el) return { success: false, error: 'Target element not found' };

          if ('checked' in el) {
            if (el.checked !== checked) {
              el.checked = checked;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
          } else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
            el.setAttribute('aria-checked', String(checked));
            el.click();
          } else {
            el.click();
          }
          return { success: true, checked: el.checked ?? el.getAttribute('aria-checked') };
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'upload_file': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      // 1. Try Chrome DevTools Protocol DOM.setFileInputFiles first
      if (params.filePath) {
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          try {
            const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
            const selector = params.selector || 'input[type="file"]';
            const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
              nodeId: doc.root.nodeId,
              selector
            });
            if (node && node.nodeId) {
              await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
                files: [params.filePath],
                nodeId: node.nodeId
              });
              return { success: true, method: 'cdp_native', filePath: params.filePath };
            }
          } finally {
            try { await chrome.debugger.detach({ tabId }); } catch (e) {}
          }
        } catch (dbgErr) {
          console.warn('[Browser Operator] CDP file input failed, falling back to DataTransfer:', dbgErr);
        }
      }

      // 2. Fallback: Base64 DataTransfer injection (bypasses OS file picker completely)
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [
          params.selector || 'input[type="file"]',
          params.ref || null,
          params.base64Data,
          params.fileName || 'upload.jpg',
          params.mimeType || 'image/jpeg'
        ],
        func: (selector, ref, base64Data, fileName, mimeType) => {
          let el = null;
          if (ref) el = document.querySelector(`[data-ag-ref="${ref}"]`);
          if (!el && selector) el = document.querySelector(selector);
          if (!el) el = document.querySelector('input[type="file"]');
          if (!el) return { success: false, error: 'No file input found on page' };

          try {
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() });

            const dt = new DataTransfer();
            dt.items.add(file);
            el.files = dt.files;

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            return { success: true, method: 'datatransfer_injected', fileName, fileSize: file.size };
          } catch (err) {
            return { success: false, error: err.message };
          }
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'scroll': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.direction || 'down', params.amount || 500],
        func: (direction, amount) => {
          window.scrollBy({
            top: direction === 'down' ? amount : -amount,
            behavior: 'smooth'
          });
        }
      });
      return { success: true };
    }

    case 'video_control': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.op || 'status', params.rate || null, params.seek !== undefined ? params.seek : null],
        func: (op, rate, seek) => {
          const v = document.querySelector('video');
          if (!v) return { error: 'No video element found' };
          if (op === 'play') v.play();
          if (op === 'pause') v.pause();
          if (rate) v.playbackRate = rate;
          if (seek !== null && seek !== undefined) v.currentTime = seek;
          return {
            paused: v.paused,
            currentTime: v.currentTime,
            duration: v.duration,
            playbackRate: v.playbackRate,
            ended: v.ended
          };
        }
      });
      return injectionResults[0]?.result || {};
    }

    case 'evaluate': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      // 1. Try Chrome DevTools Protocol debugger first (bypasses CSP unsafe-eval completely)
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        try {
          const evalRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: params.script || '',
            returnByValue: true,
            awaitPromise: true
          });
          if (evalRes && evalRes.exceptionDetails) {
            return { error: evalRes.exceptionDetails.text || evalRes.exceptionDetails.exception?.description };
          }
          return evalRes.result ? evalRes.result.value : evalRes;
        } finally {
          try { await chrome.debugger.detach({ tabId }); } catch (e) {}
        }
      } catch (dbgErr) {
        // Fallback to chrome.scripting.executeScript if debugger attach is unavailable
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId },
          args: [params.script || ''],
          func: (code) => {
            try {
              return { result: window.eval(code) };
            } catch (e) {
              return { error: e.message };
            }
          }
        });
        return injectionResults[0]?.result || {};
      }
    }

    case 'reload_extension': {
      setTimeout(() => { chrome.runtime.reload(); }, 100);
      return { success: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Listen for popup inquiries
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_STATUS') {
    getStoredToken().then((token) => {
      sendResponse({
        isConnected,
        authRequired,
        authError,
        hasToken: !!token
      });
    });
    return true;
  } else if (request.type === 'GET_TOKEN') {
    getStoredToken().then((token) => {
      sendResponse({ token });
    });
    return true;
  } else if (request.type === 'SET_TOKEN') {
    setStoredToken(request.token).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (request.type === 'RECONNECT') {
    connectBridge().then(() => {
      sendResponse({ status: 'reconnecting' });
    });
    return true;
  }
  return true;
});

// Start connection on launch
connectBridge();
