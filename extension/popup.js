// Popup script
document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const agentStatus = document.getElementById('agentStatus');
  const activeTabTitle = document.getElementById('activeTabTitle');
  const reconnectBtn = document.getElementById('reconnectBtn');

  function updateStatus(isConnected) {
    if (isConnected) {
      statusBadge.className = 'badge connected';
      statusText.innerText = 'Connected';
      agentStatus.innerText = 'Active & Ready';
      agentStatus.style.color = '#3fb950';
    } else {
      statusBadge.className = 'badge disconnected';
      statusText.innerText = 'Disconnected';
      agentStatus.innerText = 'Waiting for Bridge...';
      agentStatus.style.color = '#f85149';
    }
  }

  // Request status from background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) {
      updateStatus(response.isConnected);
    }
  });

  // Get active tab info
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      activeTabTitle.innerText = tabs[0].title || tabs[0].url;
      activeTabTitle.title = tabs[0].url;
    }
  });

  // Listen for real-time status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_CHANGE') {
      updateStatus(message.connected);
    }
  });

  reconnectBtn.addEventListener('click', () => {
    reconnectBtn.innerText = 'Connecting...';
    reconnectBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'RECONNECT' }, () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
          if (res) updateStatus(res.isConnected);
          reconnectBtn.innerText = 'Reconnect';
          reconnectBtn.disabled = false;
        });
      }, 1000);
    });
  });
});
