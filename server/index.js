#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { getOrCreateToken } = require('./auth.js');
const memory = require('./memory.js');

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
        name: 'browser_batch_actions',
        description: 'Executes multiple sequential browser actions (click, type, wait, scroll, select_option, set_checked, navigate) in a single turn without round-trip LLM pauses. Drastically speeds up multi-step tasks, form filling, and searching.',
        inputSchema: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              description: 'Array of actions to execute sequentially. Supported types: "click" (ref, selector, text), "type" (ref, selector, text, pressEnter), "wait" (ms), "scroll" (direction, amount), "select_option" (ref, value, text), "set_checked" (ref, checked), "navigate" (url).',
              items: { type: 'object' }
            },
            tabId: { type: 'number', description: 'Optional tab ID.' }
          },
          required: ['actions']
        }
      },
      {
        name: 'browser_navigate',
        description: 'Navigates the specified or active tab in the user’s Chrome browser to a URL and waits for page load.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to navigate to.' },
            tabId: { type: 'number', description: 'Optional tab ID. If omitted, navigates the active tab.' },
            waitUntil: { type: 'string', enum: ['interactive', 'complete'], description: 'Wait condition: "interactive" (default, fast - resolves as soon as DOM is ready) or "complete" (waits for all background ads/trackers).' }
          },
          required: ['url'],
        },
      },
      {
        name: 'browser_get_dom',
        description: 'Extracts the page title, URL, token-dense compact DOM representation, indexed interactive elements with refs, and clean text of the tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Optional tab ID.' },
            maxTextLength: { type: 'number', description: 'Maximum characters of body text to extract (defaults to 3000 to save tokens).' },
            includeLinks: { type: 'boolean', description: 'Whether to include standalone links array (defaults to false as elements already index links).' }
          },
        },
      },
      {
        name: 'browser_click',
        description: 'Clicks an element on the active or specified tab using an indexed ref, CSS selector, or visible text.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Indexed reference ID of the element (e.g. "1", "2") assigned by browser_get_dom.' },
            selector: { type: 'string', description: 'CSS selector of element to click.' },
            text: { type: 'string', description: 'Visible text inside element to click.' },
            x: { type: 'number', description: 'X pixel coordinate to click.' },
            y: { type: 'number', description: 'Y pixel coordinate to click.' },
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
            ref: { type: 'string', description: 'Indexed reference ID of the input element (e.g. "1", "2") assigned by browser_get_dom.' },
            selector: { type: 'string', description: 'CSS selector of input element.' },
            text: { type: 'string', description: 'Text to type.' },
            pressEnter: { type: 'boolean', description: 'Whether to press Enter after typing.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'browser_select_option',
        description: 'Selects an option from a <select> dropdown or listbox on the active or specified tab.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Indexed reference ID of the select element.' },
            selector: { type: 'string', description: 'CSS selector of the select element.' },
            value: { type: 'string', description: 'Value of the option to select.' },
            text: { type: 'string', description: 'Visible label text of the option to select.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
        },
      },
      {
        name: 'browser_set_checked',
        description: 'Sets the checked state of a checkbox, radio button, or switch toggle.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Indexed reference ID of the checkbox/radio element.' },
            selector: { type: 'string', description: 'CSS selector of the checkbox/radio element.' },
            checked: { type: 'boolean', description: 'Desired checked state (true or false). Default is true.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
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
        description: 'Captures a visible screenshot of the active or specified tab in Chrome and saves it as an image on disk.',
        inputSchema: {
          type: 'object',
          properties: {
            savePath: { type: 'string', description: 'Optional file path to save the image. If omitted, saves to project screenshots folder.' },
            format: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format (defaults to "jpeg" for fast lightweight transfer).' },
            quality: { type: 'number', description: 'Compression quality 1-100 (defaults to 80 for jpeg).' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
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
      {
        name: 'browser_upload_file',
        description: 'Uploads a local file to a file input on the active or specified tab completely autonomously without opening OS file picker.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute local file path to upload (e.g. D:\\facebook-ai-agent\\assets\\cover.jpg).' },
            selector: { type: 'string', description: 'Optional CSS selector of the file input (defaults to input[type="file"]).' },
            ref: { type: 'string', description: 'Optional indexed reference ID from browser_get_dom.' },
            tabId: { type: 'number', description: 'Optional tab ID.' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'browser_handle_dialog',
        description: 'Handles, accepts, or dismisses browser native JavaScript modal dialogs (alerts, confirms, prompts, and "Leave site?" beforeunload dialogs) using Chrome DevTools Protocol.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Target tab ID (optional, defaults to active tab).' },
            accept: { type: 'boolean', description: 'Whether to accept (click Leave/OK/Yes) or dismiss (click Cancel/No). Defaults to true.' },
            promptText: { type: 'string', description: 'Optional prompt text to enter into the dialog.' },
          },
        },
      },
      {
        name: 'browser_save_recipe',
        description: 'Saves a successful multi-step workflow/macro into the agent’s muscle memory. Stored recipes can be recalled and executed in seconds for repetitive site tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique identifier name for this workflow (e.g. "search_daraz_item", "upload_facebook_reel").' },
            domain: { type: 'string', description: 'Domain name for this recipe (e.g. "facebook.com", "google.com").' },
            description: { type: 'string', description: 'What this recipe accomplishes.' },
            actions: {
              type: 'array',
              description: 'Array of batch actions (click, type, wait, scroll, select_option, set_checked) that form the recipe.',
              items: { type: 'object' }
            },
            notes: { type: 'string', description: 'Optional tips or timing notes.' }
          },
          required: ['name', 'domain', 'actions']
        }
      },
      {
        name: 'browser_find_recipe',
        description: 'Searches the agent’s muscle memory for existing recipes on a domain or task. Returns stored action sequences ready to run via browser_batch_actions.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Optional domain to filter recipes (e.g. "facebook.com").' },
            query: { type: 'string', description: 'Search keywords describing the desired task (e.g. "upload", "search").' }
          }
        }
      },
      {
        name: 'browser_learn_site_quirk',
        description: 'Records a site-specific quirk, pitfall, selector tip, or bypass rule into the long-term knowledge library.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Website domain (e.g. "facebook.com", "youtube.com").' },
            quirk: { type: 'string', description: 'The observed quirk or behavior (e.g. "Search box uses div[role=textbox] not input").' },
            category: { type: 'string', enum: ['modal_dialog', 'input_quirk', 'file_upload', 'navigation', 'security', 'general'], description: 'Category of quirk.' },
            advice: { type: 'string', description: 'Recommended solution or strategy for future agents.' },
            selector: { type: 'string', description: 'Optional reliable CSS selector.' }
          },
          required: ['domain', 'quirk']
        }
      },
      {
        name: 'browser_get_site_memory',
        description: 'Retrieves all learned knowledge, known quirks, and saved recipes for a specific domain or the active tab.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Website domain or URL to inspect memory for.' },
            tabId: { type: 'number', description: 'Optional tab ID to extract domain from active tab.' }
          }
        }
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
      case 'browser_batch_actions': {
        const result = await sendAction('batch_actions', {
          actions: args.actions,
          tabId: args.tabId
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_navigate': {
        const result = await sendAction('navigate', {
          url: args.url,
          tabId: args.tabId,
          waitUntil: args.waitUntil || 'interactive'
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_get_dom': {
        const result = await sendAction('get_dom', {
          tabId: args.tabId,
          maxTextLength: args.maxTextLength,
          includeLinks: args.includeLinks
        });
        if (result && result.url) {
          try {
            const domainIntel = memory.getSiteIntelligence(result.url);
            if (domainIntel && (domainIntel.knownQuirks.length > 0 || domainIntel.savedRecipes.length > 0)) {
              result.siteMemory = domainIntel;
            }
          } catch (e) {}
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_click': {
        const result = await sendAction('click', { selector: args.selector, text: args.text, ref: args.ref, tabId: args.tabId, x: args.x, y: args.y });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_type': {
        const result = await sendAction('type', { selector: args.selector, text: args.text, pressEnter: args.pressEnter, ref: args.ref, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_select_option': {
        const result = await sendAction('select_option', { selector: args.selector, ref: args.ref, value: args.value, text: args.text, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_set_checked': {
        const result = await sendAction('set_checked', { selector: args.selector, ref: args.ref, checked: args.checked, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_scroll': {
        const result = await sendAction('scroll', { direction: args.direction, amount: args.amount, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'browser_screenshot': {
        const result = await sendAction('screenshot', {
          tabId: args.tabId,
          format: args.format || 'jpeg',
          quality: args.quality || 80
        });
        let savedPath = null;
        if (result && result.dataUrl) {
          try {
            const matches = result.dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
            const ext = matches ? (matches[1] === 'jpeg' ? 'jpg' : matches[1]) : (result.format || 'jpg');
            const base64Data = matches ? matches[2] : result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const screenshotsDir = path.resolve(__dirname, '..', 'screenshots');
            if (!fs.existsSync(screenshotsDir)) {
              fs.mkdirSync(screenshotsDir, { recursive: true });
            }
            savedPath = args.savePath ? path.resolve(args.savePath) : path.join(screenshotsDir, `screenshot_${Date.now()}.${ext}`);
            const targetDir = path.dirname(savedPath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(savedPath, buffer);
          } catch (fsErr) {
            console.error('[MCP Server] Failed to save screenshot to disk:', fsErr.message);
          }
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: !!(result && result.dataUrl),
              format: result && result.format ? result.format : 'jpeg',
              savedPath: savedPath || undefined,
              fileUrl: savedPath ? `file:///${savedPath.replace(/\\/g, '/')}` : undefined,
              dataLength: result && result.dataUrl ? result.dataUrl.length : 0
            }, null, 2)
          }]
        };
      }
      case 'browser_evaluate': {
        const result = await sendAction('evaluate', { script: args.script, tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_upload_file': {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = 'application/octet-stream';
        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.mp4') mimeType = 'video/mp4';
        else if (ext === '.webp') mimeType = 'image/webp';

        const result = await sendAction('upload_file', {
          filePath,
          fileName,
          mimeType,
          base64Data,
          selector: args.selector,
          ref: args.ref,
          tabId: args.tabId
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_handle_dialog': {
        const result = await sendAction('handle_dialog', {
          tabId: args.tabId,
          accept: args.accept !== undefined ? args.accept : true,
          promptText: args.promptText
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_save_recipe': {
        const result = memory.saveRecipe({
          name: args.name,
          domain: args.domain,
          description: args.description,
          actions: args.actions,
          notes: args.notes
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_find_recipe': {
        const result = memory.findRecipe(args.query, args.domain);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_learn_site_quirk': {
        const result = memory.recordSiteQuirk({
          domain: args.domain,
          quirk: args.quirk,
          category: args.category || 'general',
          advice: args.advice,
          selector: args.selector
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'browser_get_site_memory': {
        let domain = args.domain;
        if (!domain) {
          const tab = await sendAction('get_active_tab');
          if (tab && tab.url) domain = tab.url;
        }
        const result = memory.getSiteIntelligence(domain) || { domain, knownQuirks: [], savedRecipes: [] };
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
