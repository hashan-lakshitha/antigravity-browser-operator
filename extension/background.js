// Antigravity Browser Operator - Background Service Worker
const WS_URL = 'ws://127.0.0.1:8765';
let socket = null;
let isConnected = false;
let reconnectTimer = null;

console.log('[Antigravity] Background service worker initialized');

// Connect to local Antigravity MCP Bridge
function connectBridge() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[Antigravity] Connected to Local MCP Bridge at', WS_URL);
      isConnected = true;
      notifyPopup({ type: 'STATUS_CHANGE', connected: true });
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        // Handle heartbeat from server to keep service worker alive
        if (message.action === 'heartbeat') {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'heartbeat_ack', time: Date.now() }));
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

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id, result, error }));
        }
      } catch (e) {
        console.error('[Antigravity] Failed to process message:', e);
      }
    };

    socket.onclose = () => {
      isConnected = false;
      notifyPopup({ type: 'STATUS_CHANGE', connected: false });
      scheduleReconnect();
    };

    socket.onerror = () => {
      isConnected = false;
    };
  } catch (err) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      connectBridge();
    }, 2500);
  }
}

// Keep service worker alive and reconnect on any browser activity
chrome.alarms.create('antigravity_keepalive', { periodInMinutes: 0.2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'antigravity_keepalive') {
    connectBridge();
  }
});

chrome.tabs.onActivated.addListener(() => connectBridge());
chrome.tabs.onUpdated.addListener(() => connectBridge());

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
    sendResponse({ isConnected });
  } else if (request.type === 'RECONNECT') {
    connectBridge();
    sendResponse({ status: 'reconnecting' });
  }
  return true;
});

// Start connection on launch
connectBridge();
