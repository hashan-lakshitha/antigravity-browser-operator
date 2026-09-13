#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { getOrCreateToken } = require('./auth.js');

const WS_PORT = 8765;
function getBridgeUrl() {
  const token = getOrCreateToken();
  return `ws://127.0.0.1:${WS_PORT}/mcp?token=${encodeURIComponent(token)}`;
}

let bridgeWs = null;
let messageId = 1;
const pendingRequests = new Map();

// Auto-spawn bridge daemon in background if not running
function ensureBridgeRunning() {
  const bridgeScript = path.join(__dirname, 'bridge.js');
  try {
    const child = spawn('node', [bridgeScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.error('[MCP Server] Spawned bridge daemon in background');
  } catch (e) {
    console.error('[MCP Server] Failed to auto-spawn bridge:', e.message);
  }
}

// Connect to bridge daemon
function connectToBridge(retry = true) {
  return new Promise((resolve) => {
    const bridgeUrl = getBridgeUrl();
    bridgeWs = new WebSocket(bridgeUrl);

    bridgeWs.on('open', () => {
      console.error('[MCP Server] Connected and Authenticated to Bridge Daemon');
      resolve(true);
    });

    bridgeWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.action === 'auth_success' || response.action === 'auth_error') {
          if (response.action === 'auth_error') {
            console.error('[MCP Server] Authentication failed with Bridge Daemon:', response.error);
          }
          return;
        }

        const { id, result, error } = response;
        if (pendingRequests.has(id)) {
          const { resolve: reqResolve, reject: reqReject } = pendingRequests.get(id);
          pendingRequests.delete(id);
          if (error) {
            reqReject(new Error(error));
          } else {
            reqResolve(result);
          }
        }
      } catch (e) {
        console.error('[MCP Server] Error handling bridge message:', e);
      }
    });

    bridgeWs.on('error', (err) => {
      if (retry) {
        console.error('[MCP Server] Bridge not running, auto-starting...');
        ensureBridgeRunning();
        setTimeout(() => {
          connectToBridge(false).then(resolve);
        }, 800);
      } else {
        console.error('[MCP Server] Bridge connection error:', err.message);
        resolve(false);
      }
    });

    bridgeWs.on('close', () => {
      console.error('[MCP Server] Bridge connection closed');
    });
  });
}

// Helper: send request to bridge
function sendAction(action, params = {}, timeoutMs = 25000) {
  return new Promise(async (resolve, reject) => {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      await connectToBridge(true);
    }

    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Unable to connect to Bridge Daemon. Please make sure Google Chrome is open with the Antigravity extension.'));
    }

    const id = messageId++;
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for action "${action}" (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      }
    });

    bridgeWs.send(JSON.stringify({ id, action, params }));
  });
}

// 2. Setup MCP Server
const server = new Server(
  {
    name: 'antigravity-browser-operator',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'browser_list_tabs',
        description: 'Lists all open tabs in the user’s live Chrome browser with tab ID, title, URL, and active status.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_select_tab',
        description: 'Switches to / focuses a specific tab in the user’s Chrome browser by tab ID.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'number', description: 'The numeric ID of the tab to focus.' } },
          required: ['tabId'],
        },
      },
      {
        name: 'browser_new_tab',
        description: 'Opens a new tab in the user’s Chrome browser with a specified URL.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The URL to open.' } },
          required: ['url'],
        },
      },
      {
        name: 'browser_close_tab',
        description: 'Closes a specific tab in the user’s Chrome browser by tab ID.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'number', description: 'The numeric ID of the tab to close.' } },
          required: ['tabId'],
        },
      },
      {
        name: 'browser_navigate',
        description: 'Navigates the specified or active tab in the user’s Chrome browser to a URL and waits for page load.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to navigate to.' },
            tabId: { type: 'number', description: 'Optional tab ID. If omitted, navigates the active tab.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'browser_get_dom',
        description: 'Extracts the page title, URL, visible text content, and HTML snippet of the specified or active tab.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'number', description: 'Optional tab ID.' } },
        },
      },
      {
        name: 'browser_click',
        description: 'Clicks an element on the active or specified tab using a CSS selector or visible text.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to click.' },
            text: { type: 'string', description: 'Visible text inside element to click.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
        },
      },
      {
        name: 'browser_type',
        description: 'Types text into an input or textarea element on the active or specified tab.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of input element.' },
            text: { type: 'string', description: 'Text to type.' },
            pressEnter: { type: 'boolean', description: 'Whether to press Enter after typing.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'browser_scroll',
        description: 'Scrolls the active or specified tab up or down.',
        inputSchema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'], description: 'Direction to scroll.' },
            amount: { type: 'number', description: 'Pixel amount to scroll.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Captures a visible screenshot of the active or specified tab in Chrome as a data URL.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'number', description: 'Optional tab ID.' } },
        },
      },
      {
        name: 'browser_evaluate',
        description: 'Executes arbitrary JavaScript in the context of the active or specified tab and returns the result.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'JavaScript code to execute.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
          required: ['script'],
        },
      },
    ],
  };
});

// Tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'browser_list_tabs': {
        const tabs = await sendAction('list_tabs');
        return { content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }] };
      }
      case 'browser_select_tab': {
        const result = await sendAction('select_tab', { tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_new_tab': {
        const result = await sendAction('new_tab', { url: args.url });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_close_tab': {
        const result = await sendAction('close_tab', { tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_navigate': {
        const result = await sendAction('navigate', { url: args.url, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_get_dom': {
        const result = await sendAction('get_dom', { tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_click': {
        const result = await sendAction('click', { selector: args.selector, text: args.text, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_type': {
        const result = await sendAction('type', { selector: args.selector, text: args.text, pressEnter: args.pressEnter, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_scroll': {
        const result = await sendAction('scroll', { direction: args.direction, amount: args.amount, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_screenshot': {
        const result = await sendAction('screenshot', { tabId: args.tabId });
        return { content: [{ type: 'text', text: `Screenshot captured (length: ${result.dataUrl ? result.dataUrl.length : 0})` }] };
      }
      case 'browser_evaluate': {
        const result = await sendAction('evaluate', { script: args.script, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// Start MCP Server
async function main() {
  await connectToBridge(true);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Antigravity Browser Operator] MCP Server connected via stdio');
}

main().catch((err) => {
  console.error('[Antigravity Browser Operator] Fatal error:', err);
  process.exit(1);
});
