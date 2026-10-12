#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const { getOrCreateToken, validateToken, TOKEN_FILE } = require('./auth.js');
const profiles = require('./profiles.js');

const WS_PORT = 8765;

// Multi-Profile Extension Router Collections
// extensionClients: Map<extId, { id, ws, profile, folder, email, connectedAt, lastActive }>
const extensionClients = new Map();
// tabToExtensionMap: Map<tabId (number), extId (string)>
const tabToExtensionMap = new Map();
// mcpClients: Set<WebSocket>
const mcpClients = new Set();
// pendingRequests: Map<reqId, { mcpWs, extId, isListTabs }>
const pendingRequests = new Map();
// pendingBroadcasts: Map<reqId, { mcpWs, total, remaining, allTabs, timer }>
const pendingBroadcasts = new Map();
// pendingSubRequests: Map<subId, { parentId, extId }>
const pendingSubRequests = new Map();

let nextExtId = 1;

// Initialize or retrieve secret token
const activeToken = getOrCreateToken();

function resolveProfileMetadata(queryProfile, queryEmail, queryFolder) {
  try {
    const allProfiles = profiles.listProfiles();
    const emailLower = (queryEmail || '').toLowerCase().trim();
    const profileLower = (queryProfile || '').toLowerCase().trim();
    const folderLower = (queryFolder || '').toLowerCase().trim();

    // 1. Match by email
    if (emailLower) {
      const match = allProfiles.find(p => p.email && p.email.toLowerCase() === emailLower);
      if (match) return { name: match.name, folder: match.folder, email: match.email };
    }
    // 2. Match by folder (e.g. "Profile 13" or "Default")
    if (folderLower) {
      const match = allProfiles.find(p => p.folder.toLowerCase() === folderLower);
      if (match) return { name: match.name, folder: match.folder, email: match.email };
    }
    // 3. Match by name
    if (profileLower) {
      const match = allProfiles.find(p => p.name.toLowerCase() === profileLower || p.folder.toLowerCase() === profileLower);
      if (match) return { name: match.name, folder: match.folder, email: match.email };
    }
  } catch (e) {}

  return {
    name: queryProfile || 'Default',
    folder: queryFolder || 'Default',
    email: queryEmail || ''
  };
}

function getExtensionByTabId(tabId) {
  if (tabId !== undefined && tabId !== null) {
    const tabNum = Number(tabId);
    const extId = tabToExtensionMap.get(tabNum);
    if (extId && extensionClients.has(extId)) {
      const client = extensionClients.get(extId);
      if (client.ws.readyState === 1) return client;
    }
  }
  return null;
}

function getActiveExtension(preferredProfile = null) {
  if (preferredProfile) {
    const lower = String(preferredProfile).toLowerCase().trim();
    for (const client of extensionClients.values()) {
      if (client.ws.readyState === 1) {
        if (
          (client.profile && client.profile.toLowerCase().includes(lower)) ||
          (client.folder && client.folder.toLowerCase().includes(lower)) ||
          (client.email && client.email.toLowerCase().includes(lower))
        ) {
          return client;
        }
      }
    }
  }

  // Fall back to the most recently active extension socket
  let best = null;
  for (const client of extensionClients.values()) {
    if (client.ws.readyState === 1) {
      if (!best || client.lastActive > best.lastActive) {
        best = client;
      }
    }
  }
  return best;
}

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const isMcp = parsedUrl.pathname.includes('mcp');
  const tokenParam = parsedUrl.searchParams.get('token');
  const queryProfile = parsedUrl.searchParams.get('profile');
  const queryEmail = parsedUrl.searchParams.get('email');
  const queryFolder = parsedUrl.searchParams.get('folder');
  const origin = req.headers.origin;

  console.log(`[Bridge Daemon] Connection attempt: isMcp=${isMcp}, Origin=${origin}, TokenPresent=${!!tokenParam}, TokenValid=${validateToken(tokenParam)}`);

  // 1. Cross-Site WebSocket Hijacking (CSWSH) Protection
  if (origin) {
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      console.warn(`[Bridge Daemon] Rejected untrusted web origin: ${origin}`);
      ws.close(4003, 'Forbidden: Web origins are not permitted');
      return;
    }
    if (isMcp && (origin.startsWith('http://') || origin.startsWith('https://') || origin.startsWith('chrome-extension://'))) {
      console.warn(`[Bridge Daemon] Rejected MCP connection with browser origin: ${origin}`);
      ws.close(4003, 'Forbidden: MCP client cannot have browser origin');
      return;
    }
  }

  // 2. Token Authentication
  let isAuthenticated = validateToken(tokenParam);
  let authTimeout = null;
  let clientExtInfo = null;

  const handleAuthenticatedClient = (authPayload = {}) => {
    if (isMcp) {
      console.log('[Bridge Daemon] MCP Server client connected and authenticated');
      mcpClients.add(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action === 'auth') return;

          // Special Bridge-level queries
          if (msg.action === 'get_bridge_status' || msg.action === 'list_connected_profiles') {
            const connectedList = Array.from(extensionClients.values()).map(c => ({
              id: c.id,
              profile: c.profile,
              folder: c.folder,
              email: c.email,
              connectedAt: c.connectedAt,
              lastActive: c.lastActive
            }));
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                connectedCount: extensionClients.size,
                profiles: connectedList
              }
            }));
            return;
          }

          // Case A: Broadcast list_tabs across ALL connected Chrome profiles
          if (msg.action === 'list_tabs') {
            const activeExts = Array.from(extensionClients.values()).filter(c => c.ws.readyState === 1);
            if (activeExts.length === 0) {
              ws.send(JSON.stringify({
                id: msg.id,
                error: 'No Chrome Extension is connected. Please make sure Google Chrome is open with the paired token.'
              }));
              return;
            }

            if (activeExts.length === 1) {
              const single = activeExts[0];
              pendingRequests.set(msg.id, { mcpWs: ws, extId: single.id, isListTabs: true });
              single.ws.send(JSON.stringify(msg));
              return;
            }

            // Multiple profile extensions connected: broadcast & aggregate
            const requestId = msg.id;
            const broadcastTracker = {
              mcpWs: ws,
              total: activeExts.length,
              remaining: activeExts.length,
              allTabs: [],
              timer: null
            };

            const finalizeBroadcast = () => {
              if (broadcastTracker.timer) {
                clearTimeout(broadcastTracker.timer);
                broadcastTracker.timer = null;
              }
              pendingBroadcasts.delete(requestId);
              if (broadcastTracker.mcpWs.readyState === 1) {
                broadcastTracker.mcpWs.send(JSON.stringify({
                  id: requestId,
                  result: broadcastTracker.allTabs
                }));
              }
            };

            broadcastTracker.timer = setTimeout(finalizeBroadcast, 2500);
            pendingBroadcasts.set(requestId, broadcastTracker);

            for (const client of activeExts) {
              const subId = `bcast_${requestId}_${client.id}`;
              pendingSubRequests.set(subId, { parentId: requestId, extId: client.id });
              try {
                client.ws.send(JSON.stringify({
                  id: subId,
                  action: 'list_tabs',
                  params: msg.params || {}
                }));
              } catch (e) {
                broadcastTracker.remaining--;
                if (broadcastTracker.remaining <= 0) finalizeBroadcast();
              }
            }
            return;
          }

          // Case B: Route actions by tabId or preferred profile
          let targetExt = getExtensionByTabId(msg.params?.tabId);

          if (!targetExt) {
            const preferred = msg.params?.profile || msg.params?.profileFolder;
            targetExt = getActiveExtension(preferred);
          }

          if (targetExt) {
            pendingRequests.set(msg.id, { mcpWs: ws, extId: targetExt.id });
            targetExt.ws.send(JSON.stringify(msg));
          } else {
            ws.send(JSON.stringify({
              id: msg.id,
              error: 'Chrome Extension is not connected or target tab is no longer active. Please ensure Chrome is open.'
            }));
          }
        } catch (e) {
          console.error('[Bridge Daemon] Error routing MCP request:', e);
        }
      });

      ws.on('close', () => {
        console.log('[Bridge Daemon] MCP Server disconnected');
        mcpClients.delete(ws);
      });
    } else {
      // Chrome Extension client connected (Multi-Profile Support)
      const extId = `ext_${nextExtId++}`;
      const initialProfile = authPayload.profile || queryProfile;
      const initialEmail = authPayload.email || queryEmail;
      const initialFolder = authPayload.folder || queryFolder;

      const meta = resolveProfileMetadata(initialProfile, initialEmail, initialFolder);

      clientExtInfo = {
        id: extId,
        ws,
        profile: meta.name,
        folder: meta.folder,
        email: meta.email,
        connectedAt: Date.now(),
        lastActive: Date.now()
      };

      extensionClients.set(extId, clientExtInfo);
      console.log(`[Bridge Daemon] Chrome Extension connected (${extId}: "${clientExtInfo.profile}" [${clientExtInfo.folder}]). Active extensions: ${extensionClients.size}`);

      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.action === 'heartbeat_ack' || response.action === 'auth') return;

          // Update profile nickname or metadata dynamically if announced by extension
          if (response.action === 'set_profile') {
            const updatedMeta = resolveProfileMetadata(response.profile, response.email, response.folder);
            clientExtInfo.profile = updatedMeta.name;
            clientExtInfo.folder = updatedMeta.folder;
            clientExtInfo.email = updatedMeta.email;
            console.log(`[Bridge Daemon] Updated profile for ${clientExtInfo.id}: "${clientExtInfo.profile}"`);
            return;
          }

          const { id, result, error } = response;
          clientExtInfo.lastActive = Date.now();

          // 1. Check if response is part of a broadcast list_tabs
          if (pendingSubRequests.has(id)) {
            const { parentId, extId: subExtId } = pendingSubRequests.get(id);
            pendingSubRequests.delete(id);
            const broadcast = pendingBroadcasts.get(parentId);
            if (broadcast) {
              if (Array.isArray(result)) {
                for (const tab of result) {
                  tab.profile = clientExtInfo.profile;
                  tab.profileFolder = clientExtInfo.folder;
                  tabToExtensionMap.set(Number(tab.id), clientExtInfo.id);
                  broadcast.allTabs.push(tab);
                }
              }
              broadcast.remaining--;
              if (broadcast.remaining <= 0) {
                if (broadcast.timer) clearTimeout(broadcast.timer);
                pendingBroadcasts.delete(parentId);
                if (broadcast.mcpWs.readyState === 1) {
                  broadcast.mcpWs.send(JSON.stringify({
                    id: parentId,
                    result: broadcast.allTabs
                  }));
                }
              }
            }
            return;
          }

          // 2. Handle normal pending request
          if (pendingRequests.has(id)) {
            const req = pendingRequests.get(id);
            pendingRequests.delete(id);
            const mcpWs = req.mcpWs || req;

            if (Array.isArray(result)) {
              for (const tab of result) {
                if (tab && tab.id) {
                  tab.profile = clientExtInfo.profile;
                  tab.profileFolder = clientExtInfo.folder;
                  tabToExtensionMap.set(Number(tab.id), clientExtInfo.id);
                }
              }
            } else if (result && result.tabId) {
              tabToExtensionMap.set(Number(result.tabId), clientExtInfo.id);
            }

            if (mcpWs && mcpWs.readyState === 1) {
              mcpWs.send(JSON.stringify(response));
            }
          }
        } catch (e) {
          console.error('[Bridge Daemon] Error handling extension response:', e);
        }
      });

      ws.on('close', () => {
        console.log(`[Bridge Daemon] Chrome Extension disconnected (${clientExtInfo.id}: "${clientExtInfo.profile}")`);
        extensionClients.delete(clientExtInfo.id);

        // Prune tabs owned by this extension
        for (const [tId, mappedExtId] of tabToExtensionMap.entries()) {
          if (mappedExtId === clientExtInfo.id) {
            tabToExtensionMap.delete(tId);
          }
        }
      });

      ws.on('error', (err) => {
        console.error(`[Bridge Daemon] Extension socket error (${clientExtInfo.id}):`, err.message);
        extensionClients.delete(clientExtInfo.id);
      });
    }

    try {
      ws.send(JSON.stringify({
        action: 'auth_success',
        client: isMcp ? 'mcp' : 'extension',
        extId: clientExtInfo ? clientExtInfo.id : undefined,
        profile: clientExtInfo ? clientExtInfo.profile : undefined
      }));
    } catch (e) {}
  };

  if (isAuthenticated) {
    handleAuthenticatedClient();
  } else {
    // 3 second auth timeout
    authTimeout = setTimeout(() => {
      console.warn(`[Bridge Daemon] Disconnecting unauthenticated ${isMcp ? 'MCP' : 'Extension'} client (timeout)`);
      try {
        ws.send(JSON.stringify({ action: 'auth_error', error: 'Authentication timeout: Valid token required' }));
      } catch (e) {}
      ws.close(4001, 'Unauthorized');
    }, 3000);

    const initialMessageHandler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === 'auth' && validateToken(msg.token)) {
          clearTimeout(authTimeout);
          isAuthenticated = true;
          ws.removeListener('message', initialMessageHandler);
          handleAuthenticatedClient(msg);
          return;
        }
      } catch (e) {}

      clearTimeout(authTimeout);
      console.warn(`[Bridge Daemon] Authentication failed for ${isMcp ? 'MCP' : 'Extension'} client`);
      try {
        ws.send(JSON.stringify({ action: 'auth_error', error: 'Invalid authentication token' }));
      } catch (e) {}
      ws.close(4001, 'Unauthorized');
    };

    ws.on('message', initialMessageHandler);
    ws.on('close', () => clearTimeout(authTimeout));
  }
});

// Periodic heartbeat to keep Chrome Extension service workers alive
setInterval(() => {
  for (const client of extensionClients.values()) {
    if (client.ws.readyState === 1) {
      try {
        client.ws.send(JSON.stringify({ action: 'heartbeat' }));
      } catch (e) {}
    }
  }
}, 10000);

console.log(`[Bridge Daemon] Multi-Profile WebSocket Router running on ws://127.0.0.1:${WS_PORT}`);
console.log(`[Bridge Daemon] Security Token: ${activeToken}`);
console.log(`[Bridge Daemon] Token file: ${TOKEN_FILE}`);

