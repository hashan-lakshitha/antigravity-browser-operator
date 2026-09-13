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
        await chrome.windows.update(tab.windowId, { focused: true });
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
      if (params.tabId) {
        const tab = await chrome.tabs.get(parseInt(params.tabId, 10));
        windowId = tab.windowId;
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return { success: true, dataUrl };
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

          return {
            title: document.title,
            url: window.location.href,
            innerText: document.body ? document.body.innerText.slice(0, 50000) : '',
            links
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
        args: [params.selector || null, params.text || null],
        func: (selector, text) => {
          let el = null;
          if (selector) {
            el = document.querySelector(selector);
          }
          if (!el && text) {
            const xpath = `//*[contains(text(), '${text}')]`;
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            el = result.singleNodeValue;
          }
          if (!el) {
            return { success: false, error: 'Element not found' };
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
          el.click();
          return { success: true, tagName: el.tagName, text: el.innerText };
        }
      });
      return injectionResults[0]?.result || {};
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
        args: [params.selector || null, params.text || '', !!params.pressEnter],
        func: (selector, text, pressEnter) => {
          const el = selector ? document.querySelector(selector) : document.activeElement;
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
          return { success: true };
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

    case 'evaluate': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [params.script],
        func: (code) => {
          try {
            return { result: eval(code) };
          } catch (e) {
            return { error: e.message };
          }
        }
      });
      return injectionResults[0]?.result || {};
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
