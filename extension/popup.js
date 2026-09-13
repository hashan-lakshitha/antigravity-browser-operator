// Antigravity Browser Operator - Popup Controller
document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const agentStatus = document.getElementById('agentStatus');
  const activeTabTitle = document.getElementById('activeTabTitle');
  const reconnectBtn = document.getElementById('reconnectBtn');

  const authStatusBadge = document.getElementById('authStatusBadge');
  const tokenInput = document.getElementById('tokenInput');
  const toggleTokenBtn = document.getElementById('toggleTokenBtn');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const reloadExtBtn = document.getElementById('reloadExtBtn');

  function updateStatus(state = {}) {
    const { isConnected = false, authRequired = false, authError = null, hasToken = !!tokenInput.value } = state;

    if (isConnected) {
      statusBadge.className = 'badge connected';
      statusText.innerText = 'Connected';
      agentStatus.innerText = 'Active & Secure';
      agentStatus.style.color = '#3fb950';
      authStatusBadge.className = 'auth-pill verified';
      authStatusBadge.innerText = 'Authenticated';
    } else if (authRequired) {
      statusBadge.className = 'badge auth_required';
      statusText.innerText = 'Auth Required';
      agentStatus.innerText = authError || 'Token Required';
      agentStatus.style.color = '#e3b341';
      authStatusBadge.className = 'auth-pill unverified';
      authStatusBadge.innerText = hasToken ? 'Invalid Token' : 'Not Configured';
    } else {
      statusBadge.className = 'badge disconnected';
      statusText.innerText = 'Disconnected';
      agentStatus.innerText = 'Waiting for Bridge...';
      agentStatus.style.color = '#f85149';
      authStatusBadge.className = 'auth-pill ' + (hasToken ? 'verified' : 'unverified');
      authStatusBadge.innerText = hasToken ? 'Token Ready' : 'Not Configured';
    }
  }

  // Load stored token directly from chrome.storage
  chrome.storage.local.get(['antigravity_token'], (res) => {
    if (res && res.antigravity_token) {
      tokenInput.value = res.antigravity_token;
    }
    // Query background status
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (statusRes) => {
      if (statusRes) {
        updateStatus(statusRes);
      }
    });
  });

  // Get active tab info
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      activeTabTitle.innerText = tabs[0].title || tabs[0].url;
      activeTabTitle.title = tabs[0].url;
    }
  });

  // Toggle token visibility
  toggleTokenBtn.addEventListener('click', () => {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      toggleTokenBtn.innerText = '🙈';
    } else {
      tokenInput.type = 'password';
      toggleTokenBtn.innerText = '👁️';
    }
  });

  // Save token handler: writes directly to storage and signals background
  saveTokenBtn.addEventListener('click', async () => {
    const rawVal = tokenInput.value.trim();
    saveTokenBtn.innerText = 'Saving...';
    saveTokenBtn.disabled = true;

    try {
      await chrome.storage.local.set({ antigravity_token: rawVal });
      chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: rawVal }, () => {});

      saveTokenBtn.innerText = 'Saved!';
      setTimeout(() => {
        saveTokenBtn.innerText = 'Save Token';
        saveTokenBtn.disabled = false;
      }, 1000);

      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
          if (res) updateStatus(res);
        });
      }, 500);
    } catch (e) {
      saveTokenBtn.innerText = 'Save Token';
      saveTokenBtn.disabled = false;
    }
  });

  // Reconnect button handler
  reconnectBtn.addEventListener('click', () => {
    reconnectBtn.innerText = 'Connecting...';
    reconnectBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'RECONNECT' }, () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
          if (res) updateStatus(res);
          reconnectBtn.innerText = 'Reconnect';
          reconnectBtn.disabled = false;
        });
      }, 1000);
    });
  });

  // Reload extension handler
  if (reloadExtBtn) {
    reloadExtBtn.addEventListener('click', () => {
      reloadExtBtn.innerText = 'Reloading...';
      chrome.runtime.reload();
    });
  }

  // Real-time status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_CHANGE') {
      updateStatus({
        isConnected: message.connected,
        authRequired: message.authRequired,
        authError: message.authError,
        hasToken: !!tokenInput.value
      });
    }
  });
});
