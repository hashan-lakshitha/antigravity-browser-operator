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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectBridge();
  }
  if (changeInfo.status === 'complete') {
    ensureLoggerInstalled(tabId).catch(() => {});
  }
});

// Set-of-Marks (SoM) visual annotation overlay
async function injectAnnotations(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const old = document.getElementById('__ag_som_overlay__');
        if (old) old.remove();

        const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], label, summary, [onclick]';
        const candidates = Array.from(document.querySelectorAll(interactiveSelectors));

        const overlay = document.createElement('div');
        overlay.id = '__ag_som_overlay__';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';

        let counter = 1;
        for (const el of candidates) {
          let isVisible = false;
          if (typeof el.checkVisibility === 'function') {
            isVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
          } else {
            const r = el.getBoundingClientRect();
            isVisible = (r.width > 0 || r.height > 0) && window.getComputedStyle(el).display !== 'none';
          }
          if (!isVisible) continue;

          let ref = el.getAttribute('data-ag-ref');
          if (!ref) {
            ref = String(counter++);
            el.setAttribute('data-ag-ref', ref);
          }

          const rect = el.getBoundingClientRect();
          if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          const box = document.createElement('div');
          box.style.cssText = `
            position: fixed;
            left: ${Math.max(0, rect.left)}px;
            top: ${Math.max(0, rect.top)}px;
            width: ${Math.min(window.innerWidth - Math.max(0, rect.left), rect.width)}px;
            height: ${Math.min(window.innerHeight - Math.max(0, rect.top), rect.height)}px;
            border: 2px solid #ef4444;
            background: rgba(239, 68, 68, 0.08);
            box-sizing: border-box;
            pointer-events: none;
          `;

          const badge = document.createElement('span');
          badge.textContent = ref;
          badge.style.cssText = `
            position: absolute;
            top: -12px;
            left: -2px;
            background: #ef4444;
            color: #ffffff;
            font-size: 11px;
            font-weight: 700;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            padding: 0 4px;
            height: 15px;
            line-height: 15px;
            border-radius: 3px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.5);
            white-space: nowrap;
          `;
          box.appendChild(badge);
          overlay.appendChild(box);
        }

        document.documentElement.appendChild(overlay);
        return true;
      }
    });
  } catch (e) {
    console.warn('[Browser Operator] Failed to inject SoM annotations:', e);
  }
}

async function removeAnnotations(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const overlay = document.getElementById('__ag_som_overlay__');
        if (overlay) overlay.remove();
      }
    });
  } catch (e) {}
}

// In-page logger for console errors & network requests (injected into MAIN world)
async function ensureLoggerInstalled(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (window.__ag_logger_installed) return;
        window.__ag_logger_installed = true;
        window.__ag_logs = { console: [], network: [] };
        const MAX_LOGS = 200;

        const origError = console.error;
        const origWarn = console.warn;
        const origLog = console.log;
        const origInfo = console.info;

        function pushConsole(level, args) {
          try {
            const text = Array.from(args).map(a => {
              if (typeof a === 'string') return a;
              try { return JSON.stringify(a); } catch (e) { return String(a); }
            }).join(' ');
            window.__ag_logs.console.push({
              level,
              text: text.slice(0, 1000),
              time: Date.now()
            });
            if (window.__ag_logs.console.length > MAX_LOGS) window.__ag_logs.console.shift();
          } catch (e) {}
        }

        console.error = function(...args) { pushConsole('error', args); return origError.apply(console, args); };
        console.warn = function(...args) { pushConsole('warn', args); return origWarn.apply(console, args); };
        console.log = function(...args) { pushConsole('log', args); return origLog.apply(console, args); };
        console.info = function(...args) { pushConsole('info', args); return origInfo.apply(console, args); };

        window.addEventListener('error', (event) => {
          pushConsole('error', [`[Uncaught Error] ${event.message} at ${event.filename || ''}:${event.lineno || ''}`]);
        });
        window.addEventListener('unhandledrejection', (event) => {
          pushConsole('error', [`[Unhandled Promise Rejection] ${event.reason}`]);
        });

        // Intercept Fetch
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
          const startTime = Date.now();
          const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || 'unknown');
          const method = (args[1]?.method || 'GET').toUpperCase();
          try {
            const response = await origFetch.apply(this, args);
            window.__ag_logs.network.push({
              type: 'fetch',
              method,
              url,
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              durationMs: Date.now() - startTime,
              time: startTime
            });
            if (window.__ag_logs.network.length > MAX_LOGS) window.__ag_logs.network.shift();
            return response;
          } catch (err) {
            window.__ag_logs.network.push({
              type: 'fetch',
              method,
              url,
              status: 0,
              statusText: 'Network Error',
              ok: false,
              error: err.message,
              durationMs: Date.now() - startTime,
              time: startTime
            });
            if (window.__ag_logs.network.length > MAX_LOGS) window.__ag_logs.network.shift();
            throw err;
          }
        };

        // Intercept XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__ag_req = { method: (method || 'GET').toUpperCase(), url, startTime: Date.now() };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          if (this.__ag_req) {
            this.addEventListener('loadend', () => {
              window.__ag_logs.network.push({
                type: 'xhr',
                method: this.__ag_req.method,
                url: this.__ag_req.url,
                status: this.status,
                statusText: this.statusText,
                ok: this.status >= 200 && this.status < 300,
                durationMs: Date.now() - this.__ag_req.startTime,
                time: this.__ag_req.startTime
              });
              if (window.__ag_logs.network.length > MAX_LOGS) window.__ag_logs.network.shift();
            });
          }
          return origSend.apply(this, arguments);
        };
      }
    });
  } catch (e) {}
}

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

    case 'batch_actions': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const actions = Array.isArray(params.actions) ? params.actions : [];
      const results = [];

      for (let i = 0; i < actions.length; i++) {
        const item = actions[i];
        const actionType = item.type || item.action;
        let actRes = null;

        if (actionType === 'wait') {
          const ms = item.ms || item.time || 500;
          await new Promise(r => setTimeout(r, Math.min(ms, 15000)));
          actRes = { success: true, waitedMs: ms };
        } else if (actionType === 'wait_for') {
          actRes = await handleAction('wait_for', { ...item, tabId });
        } else if (actionType === 'click') {
          actRes = await handleAction('click', { ...item, tabId });
        } else if (actionType === 'type') {
          actRes = await handleAction('type', { ...item, tabId });
        } else if (actionType === 'select_option') {
          actRes = await handleAction('select_option', { ...item, tabId });
        } else if (actionType === 'set_checked') {
          actRes = await handleAction('set_checked', { ...item, tabId });
        } else if (actionType === 'scroll') {
          actRes = await handleAction('scroll', { ...item, tabId });
        } else if (actionType === 'navigate') {
          actRes = await handleAction('navigate', { ...item, tabId });
        } else {
          actRes = { error: `Unsupported batch action: ${actionType}` };
        }

        results.push({ index: i, type: actionType, result: actRes });
        if (actRes && (actRes.error || actRes.success === false) && !item.continueOnError) {
          break;
        }
      }

      return { success: true, executedCount: results.length, results };
    }

    case 'navigate': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      // Clear beforeunload listeners to prevent blocking "Leave site?" prompts
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            window.onbeforeunload = null;
            window.addEventListener('beforeunload', (e) => {
              e.stopImmediatePropagation();
              delete e['returnValue'];
            }, true);
          }
        });
      } catch (e) {}

      await chrome.tabs.update(tabId, { url: params.url });

      // Fast wait: wait for 'interactive' (DOMContentLoaded) by default or 'complete'
      const waitUntil = params.waitUntil || 'interactive';
      if (waitUntil === 'complete') {
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
      } else {
        // Fast path: resolves as soon as DOM is interactive or title is loaded
        await new Promise((resolve) => {
          let resolved = false;
          const finish = () => {
            if (!resolved) {
              resolved = true;
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          const listener = (updatedTabId, info) => {
            if (updatedTabId === tabId && (info.status === 'complete' || info.title)) {
              finish();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);

          // Poll document.readyState (usually ready in 400-800ms)
          (async () => {
            for (let i = 0; i < 20; i++) {
              if (resolved) return;
              try {
                const [res] = await chrome.scripting.executeScript({
                  target: { tabId },
                  func: () => document.readyState
                });
                if (res && (res.result === 'interactive' || res.result === 'complete')) {
                  finish();
                  return;
                }
              } catch (e) {}
              await new Promise(r => setTimeout(r, 200));
            }
            finish();
          })();

          setTimeout(finish, 8000);
        });
      }

      const updatedTab = await chrome.tabs.get(tabId);
      return { success: true, tabId, title: updatedTab.title, url: updatedTab.url };
    }

    case 'screenshot': {
      let windowId = null;
      let targetTabId = null;
      if (params.tabId) {
        targetTabId = parseInt(params.tabId, 10);
      } else {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = active?.id;
      }
      if (targetTabId) {
        try {
          const tab = await chrome.tabs.get(targetTabId);
          windowId = tab?.windowId;
        } catch (e) {}
      }

      const imgFormat = params.format === 'png' ? 'png' : 'jpeg';
      const imgQuality = typeof params.quality === 'number' ? params.quality : 80;

      if (params.annotate && targetTabId) {
        await injectAnnotations(targetTabId);
      }

      try {
        // 1. Try CDP Page.captureScreenshot first (fast, works even if window is behind or unfocused)
        if (targetTabId) {
          try {
            try { await chrome.debugger.detach({ tabId: targetTabId }); } catch (e) {}
            await chrome.debugger.attach({ tabId: targetTabId }, '1.3');
            try {
              await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.enable', {});
              const cdpOpts = { format: imgFormat };
              if (imgFormat === 'jpeg') cdpOpts.quality = imgQuality;
              const res = await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.captureScreenshot', cdpOpts);
              if (res && res.data) {
                return { success: true, dataUrl: `data:image/${imgFormat};base64,` + res.data, format: imgFormat };
              }
            } finally {
              try { await chrome.debugger.detach({ tabId: targetTabId }); } catch (e) {}
            }
          } catch (dbgErr) {
            console.warn('[Browser Operator] CDP screenshot failed, falling back to captureVisibleTab:', dbgErr);
          }
        }

        // 2. Fallback: captureVisibleTab with timeout
        if (windowId) {
          try {
            const win = await chrome.windows.get(windowId);
            if (win.state === 'minimized') {
              await chrome.windows.update(windowId, { state: 'normal', focused: true });
              await new Promise(r => setTimeout(r, 400));
            }
          } catch (e) {}
        }
        const captureOpts = { format: imgFormat };
        if (imgFormat === 'jpeg') captureOpts.quality = imgQuality;
        const dataUrl = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('captureVisibleTab timed out')), 3000);
          chrome.tabs.captureVisibleTab(windowId, captureOpts, (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          });
        });
        return { success: true, dataUrl, format: imgFormat };
      } finally {
        if (params.annotate && targetTabId) {
          await removeAnnotations(targetTabId);
        }
      }
    }

    case 'handle_dialog': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const accept = params.accept !== undefined ? Boolean(params.accept) : true;
      const promptText = params.promptText || undefined;
      let needDetach = false;

      try {
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          needDetach = true;
        } catch (attachErr) {
          if (!attachErr.message.includes('Already attached')) {
            throw attachErr;
          }
        }

        await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
          accept,
          ...(promptText ? { promptText } : {})
        });
        return { success: true, tabId, handled: true, accept };
      } catch (err) {
        return { success: false, error: err.message };
      } finally {
        if (needDetach) {
          try { await chrome.debugger.detach({ tabId }); } catch (e) {}
        }
      }
    }

    case 'get_dom': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const maxTextLength = typeof params.maxTextLength === 'number' ? params.maxTextLength : 3000;
      const includeLinks = Boolean(params.includeLinks);

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [maxTextLength, includeLinks],
        func: (maxText, withLinks) => {
          // Tag and index visible interactive elements
          const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], label, summary';
          const candidates = Array.from(document.querySelectorAll(interactiveSelectors));
          
          let refCounter = 1;
          const elements = [];
          const compactLines = [];

          for (const el of candidates) {
            // High-speed native visibility check (Blink C++) - prevents layout reflow thrashing
            let isVisible = false;
            if (typeof el.checkVisibility === 'function') {
              isVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            } else {
              const rect = el.getBoundingClientRect();
              isVisible = (rect.width > 0 || rect.height > 0) && window.getComputedStyle(el).display !== 'none';
            }
            if (!isVisible) continue;

            const ref = String(refCounter++);
            el.setAttribute('data-ag-ref', ref);

            const rawText = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
            const text = rawText.replace(/\s+/g, ' ').slice(0, 80);
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || undefined;
            const type = el.type || undefined;
            const checked = typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') === 'true' ? true : (el.getAttribute('aria-checked') === 'false' ? false : undefined));

            elements.push({
              ref,
              tag,
              type,
              role,
              text: text || undefined,
              name: el.name || undefined,
              placeholder: el.placeholder || undefined,
              href: el.href ? el.href.slice(0, 120) : undefined,
              checked
            });

            // Token-dense compact single-line representation
            let desc = `[${ref}] <${tag}`;
            if (type && type !== 'text') desc += ` type="${type}"`;
            if (role && role !== tag) desc += ` role="${role}"`;
            desc += `>`;
            if (text) desc += ` "${text}"`;
            if (el.placeholder) desc += ` (placeholder: "${el.placeholder}")`;
            if (el.href) {
              const pathOnly = el.href.replace(window.location.origin, '');
              desc += ` (href: ${pathOnly.slice(0, 45)})`;
            }
            if (checked !== undefined) desc += ` [checked: ${checked}]`;
            compactLines.push(desc);

            if (elements.length >= 150) break;
          }

          // Clean, meaningful body text (stripped of script/style/nav noise and truncated)
          let bodyText = '';
          if (document.body && maxText > 0) {
            bodyText = (document.body.innerText || '')
              .replace(/\n\s*\n+/g, '\n')
              .trim()
              .slice(0, maxText);
          }

          const resObj = {
            title: document.title,
            url: window.location.href,
            compactDom: compactLines.join('\n'),
            elements,
            innerText: bodyText
          };

          if (withLinks) {
            resObj.links = Array.from(document.querySelectorAll('a[href]'))
              .map(a => ({ text: a.innerText.trim(), href: a.href }))
              .filter(l => l.text.length > 0)
              .slice(0, 30);
          }

          return resObj;
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
              return { success: true, tagName: 'COORDINATE', text: '', x, y, isCoordinate: true };
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
            y: y !== null ? y : Math.round(rect.top + rect.height / 2),
            isCanvas: el.tagName === 'CANVAS'
          };
        }
      });

      const res = injectionResults[0]?.result || {};
      // Only invoke slow CDP debugger if coordinate click or canvas was targeted
      if ((params.x !== undefined && params.y !== undefined) || res.isCanvas || res.isCoordinate) {
        if (res.x !== undefined && res.y !== undefined && res.x > 0 && res.y > 0) {
          try {
            try { await chrome.debugger.detach({ tabId }); } catch (e) {}
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

      // 1. Try Chrome DevTools Protocol for native input simulation (supports Lexical, Draft.js, React, multi-line)
      try {
        try { await chrome.debugger.detach({ tabId }); } catch (e) {}
        await chrome.debugger.attach({ tabId }, '1.3');
        try {
          // Focus element first
          await chrome.scripting.executeScript({
            target: { tabId },
            args: [params.selector || null, params.ref || null],
            func: (sel, r) => {
              let el = r ? document.querySelector(`[data-ag-ref="${r}"]`) : null;
              if (!el && sel) el = document.querySelector(sel);
              if (!el) el = document.querySelector('div[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea, input:not([type="hidden"])');
              if (el) el.focus();
            }
          });

          // Select all and Backspace to clear existing content cleanly
          if (params.clear !== false) {
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 65,
              modifiers: 2
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              windowsVirtualKeyCode: 65,
              modifiers: 2
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 8
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              windowsVirtualKeyCode: 8
            });
          }

          // Insert text natively line by line
          const text = params.text || '';
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 0) {
              await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: lines[i] });
            }
            if (i < lines.length - 1) {
              await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                key: 'Enter',
                code: 'Enter',
                text: '\r',
                unmodifiedText: '\r',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13
              });
              await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13
              });
            }
          }

          if (params.pressEnter) {
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 13
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              windowsVirtualKeyCode: 13
            });
          }

          return { success: true, method: 'cdp_native_type', textLength: text.length };
        } finally {
          try { await chrome.debugger.detach({ tabId }); } catch (e) {}
        }
      } catch (dbgErr) {
        console.warn('[Browser Operator] CDP type failed, falling back to script:', dbgErr);
      }

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

      // 1. Try Chrome DevTools Protocol with FileChooser interception or DOM.setFileInputFiles
      if (params.filePath) {
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          try {
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {});

            // Check if existing input[type="file"] exists first
            const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
            const selector = params.selector || 'input[type="file"]';
            let existingNode = null;
            try {
              existingNode = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
                nodeId: doc.root.nodeId,
                selector
              });
            } catch (e) {}

            if (existingNode && existingNode.nodeId && !params.ref) {
              await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
                files: [params.filePath],
                nodeId: existingNode.nodeId
              });
              await chrome.scripting.executeScript({
                target: { tabId },
                args: [selector],
                func: (sel) => {
                  const input = document.querySelector(sel);
                  if (input) {
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              });
              return { success: true, method: 'cdp_native_existing', filePath: params.filePath };
            }

            // Intercept file chooser dialog (supports clicking buttons like "Add Video")
            let fileChosen = false;
            let fileError = null;

            const onEvent = async (source, method, eventParams) => {
              if (source.tabId === tabId && method === 'Page.fileChooserOpened') {
                try {
                  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
                    files: [params.filePath],
                    backendNodeId: eventParams.backendNodeId
                  });
                  fileChosen = true;
                } catch (err) {
                  fileError = err;
                }
              }
            };

            chrome.debugger.onEvent.addListener(onEvent);
            try {
              await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });

              // Get element position for trusted native CDP mouse click
              const coordsRes = await chrome.scripting.executeScript({
                target: { tabId },
                args: [params.selector || null, params.ref || null],
                func: (sel, r) => {
                  let el = r ? document.querySelector(`[data-ag-ref="${r}"]`) : null;
                  if (!el && sel) el = document.querySelector(sel);
                  if (!el) {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    el = btns.find(b => (b.innerText || '').toLowerCase().includes('add video'));
                  }
                  if (!el) return null;
                  const rect = el.getBoundingClientRect();
                  return {
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                  };
                }
              });

              const coords = coordsRes[0]?.result;
              if (coords) {
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  x: coords.x,
                  y: coords.y,
                  button: 'left',
                  clickCount: 1
                });
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
                  type: 'mouseReleased',
                  x: coords.x,
                  y: coords.y,
                  button: 'left',
                  clickCount: 1
                });
              } else {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: () => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    const el = btns.find(b => (b.innerText || '').toLowerCase().includes('add video'));
                    if (el) el.click();
                  }
                });
              }

              // Wait up to 6 seconds for fileChooserOpened event
              for (let i = 0; i < 60; i++) {
                if (fileChosen || fileError) break;
                await new Promise(r => setTimeout(r, 100));
              }

              if (fileChosen) {
                return { success: true, method: 'cdp_file_chooser_intercepted', filePath: params.filePath };
              }
              if (fileError) throw fileError;
            } finally {
              chrome.debugger.onEvent.removeListener(onEvent);
              try {
                await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false });
              } catch (e) {}
            }
          } finally {
            try { await chrome.debugger.detach({ tabId }); } catch (e) {}
          }
        } catch (dbgErr) {
          console.warn('[Browser Operator] CDP file upload failed, falling back to DataTransfer:', dbgErr);
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

          // If targeted element is a button (e.g. Add Video) and not a file input, click it while intercepting input creation
          if (el && el.tagName !== 'INPUT') {
            const originalClick = HTMLInputElement.prototype.click;
            let intercepted = null;
            HTMLInputElement.prototype.click = function() {
              if (this.type === 'file') {
                intercepted = this;
                return;
              }
              return originalClick.apply(this, arguments);
            };
            try {
              el.click();
              if (intercepted) el = intercepted;
            } finally {
              HTMLInputElement.prototype.click = originalClick;
            }
          }

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
        try { await chrome.debugger.detach({ tabId }); } catch (e) {}
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

    case 'wait_for': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      const state = params.state || 'visible';
      const timeoutMs = Math.min(Math.max(params.timeout || 10000, 500), 30000);
      const startTime = Date.now();

      if (state === 'network_idle') {
        let reachedIdle = false;
        try {
          try { await chrome.debugger.detach({ tabId }); } catch (e) {}
          await chrome.debugger.attach({ tabId }, '1.3');
          try {
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
            let inFlight = 0;
            let idleTimer = null;

            const onNetworkEvent = (source, method) => {
              if (source.tabId !== tabId) return;
              if (method === 'Network.requestWillBeSent') {
                inFlight++;
                if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
              } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
                inFlight = Math.max(0, inFlight - 1);
                if (inFlight === 0 && !idleTimer) {
                  idleTimer = setTimeout(() => { reachedIdle = true; }, 500);
                }
              }
            };

            chrome.debugger.onEvent.addListener(onNetworkEvent);
            idleTimer = setTimeout(() => { reachedIdle = true; }, 500);

            try {
              while (Date.now() - startTime < timeoutMs) {
                if (reachedIdle) break;
                await new Promise(r => setTimeout(r, 100));
              }
            } finally {
              if (idleTimer) clearTimeout(idleTimer);
              chrome.debugger.onEvent.removeListener(onNetworkEvent);
            }
          } finally {
            try { await chrome.debugger.detach({ tabId }); } catch (e) {}
          }
        } catch (dbgErr) {
          console.warn('[Browser Operator] CDP network_idle failed, falling back to script polling:', dbgErr);
          let lastCount = -1;
          let stableCount = 0;
          while (Date.now() - startTime < timeoutMs) {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => ({
                readyState: document.readyState,
                resCount: typeof performance !== 'undefined' ? performance.getEntriesByType('resource').length : 0
              })
            });
            if (res?.result?.readyState === 'complete') {
              if (res.result.resCount === lastCount) {
                stableCount++;
                if (stableCount >= 3) { reachedIdle = true; break; }
              } else {
                lastCount = res.result.resCount;
                stableCount = 0;
              }
            }
            await new Promise(r => setTimeout(r, 200));
          }
        }

        return {
          success: true,
          state: 'network_idle',
          reachedIdle,
          waitedMs: Date.now() - startTime
        };
      }

      // Waiting for element: selector, text, or ref
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [
          params.selector || null,
          params.text || null,
          params.ref || null,
          state,
          timeoutMs
        ],
        func: async (selector, text, ref, targetState, maxWait) => {
          const t0 = Date.now();
          function findTarget() {
            let el = null;
            if (ref) el = document.querySelector(`[data-ag-ref="${ref}"]`);
            if (!el && selector) el = document.querySelector(selector);
            if (!el && text) {
              const lower = text.toLowerCase().trim();
              const all = Array.from(document.querySelectorAll('body *:not(script):not(style):not(noscript)'));
              el = all.find(e => {
                const t = (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase();
                return t === lower || t.includes(lower);
              });
            }
            return el;
          }

          function checkCondition(el) {
            if (targetState === 'hidden') {
              if (!el) return true;
              if (typeof el.checkVisibility === 'function') {
                return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
              }
              const r = el.getBoundingClientRect();
              return r.width === 0 || r.height === 0 || window.getComputedStyle(el).display === 'none';
            }

            if (!el) return false;
            let isVisible = false;
            if (typeof el.checkVisibility === 'function') {
              isVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            } else {
              const r = el.getBoundingClientRect();
              isVisible = (r.width > 0 || r.height > 0) && window.getComputedStyle(el).display !== 'none';
            }
            if (!isVisible) return false;

            if (targetState === 'clickable') {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              return !disabled;
            }
            return true; // visible
          }

          while (Date.now() - t0 < maxWait) {
            const el = findTarget();
            if (checkCondition(el)) {
              return {
                found: true,
                waitedMs: Date.now() - t0,
                tag: el ? el.tagName.toLowerCase() : undefined,
                text: el ? (el.innerText || el.value || '').slice(0, 80) : undefined
              };
            }
            await new Promise(r => setTimeout(r, 100));
          }

          return {
            found: false,
            waitedMs: Date.now() - t0,
            error: `Timeout (${maxWait}ms) reached waiting for element condition "${targetState}"`
          };
        }
      });

      const res = injectionResults[0]?.result || {};
      if (!res.found && state !== 'hidden') {
        return { success: false, error: res.error || 'Timeout waiting for element', waitedMs: res.waitedMs };
      }
      return { success: true, ...res };
    }

    case 'get_console_logs': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      await ensureLoggerInstalled(tabId);
      const filterTypes = Array.isArray(params.types) ? params.types : null;
      const doClear = Boolean(params.clear);

      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [filterTypes, doClear],
        func: (types, clear) => {
          let logs = window.__ag_logs?.console || [];
          if (types && types.length > 0) {
            logs = logs.filter(l => types.includes(l.level));
          }
          const errors = logs.filter(l => l.level === 'error');
          const warnings = logs.filter(l => l.level === 'warn');
          const out = {
            totalCount: logs.length,
            errorCount: errors.length,
            warningCount: warnings.length,
            logs: logs.slice(-100)
          };
          if (clear && window.__ag_logs) {
            window.__ag_logs.console = [];
          }
          return out;
        }
      });

      return { success: true, tabId, ...(res?.result || {}) };
    }

    case 'get_network_logs': {
      let tabId = params.tabId ? parseInt(params.tabId, 10) : null;
      if (!tabId) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!tabId) throw new Error('No active tab found');

      await ensureLoggerInstalled(tabId);
      const failedOnly = Boolean(params.failedOnly);
      const limit = typeof params.limit === 'number' ? params.limit : 50;
      const doClear = Boolean(params.clear);

      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [failedOnly, limit, doClear],
        func: (onlyFailed, maxLimit, clear) => {
          let reqs = window.__ag_logs?.network || [];
          if (reqs.length === 0 && typeof performance !== 'undefined') {
            const perf = performance.getEntriesByType('resource');
            reqs = perf.slice(-maxLimit).map(p => ({
              type: p.initiatorType || 'resource',
              method: 'GET',
              url: p.name,
              status: 200,
              ok: true,
              durationMs: Math.round(p.duration),
              time: Math.round(p.startTime)
            }));
          }

          if (onlyFailed) {
            reqs = reqs.filter(r => !r.ok || r.status >= 400 || r.status === 0);
          }

          const failed = reqs.filter(r => !r.ok || r.status >= 400 || r.status === 0);
          const out = {
            totalCount: reqs.length,
            failedCount: failed.length,
            requests: reqs.slice(-maxLimit),
            failedRequests: failed.slice(-maxLimit)
          };

          if (clear && window.__ag_logs) {
            window.__ag_logs.network = [];
          }
          return out;
        }
      });

      return { success: true, tabId, ...(res?.result || {}) };
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
