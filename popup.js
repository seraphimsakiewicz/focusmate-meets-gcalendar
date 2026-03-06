// popup.js — Extension popup logic

const $ = (sel) => document.querySelector(sel);

const statusDot = $('#status-dot');
const statusText = $('#status-text');
const signInArea = $('#sign-in-area');
const signedInArea = $('#signed-in-area');
const btnSignIn = $('#btn-sign-in');
const btnSignOut = $('#btn-sign-out');
const btnRefresh = $('#btn-refresh');
const toggleEnabled = $('#toggle-enabled');
const errorText = $('#error-text');
const syncInfo = $('#sync-info');
const calendarsSection = $('#calendars-section');
const calendarList = $('#calendar-list');
const btnSelectAll = $('#btn-select-all');

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  // Load toggle state
  const { enabled } = await chrome.storage.sync.get('enabled');
  toggleEnabled.checked = enabled !== false;

  // Check auth status
  checkStatus();
}

function checkStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showError('Could not connect to extension');
      return;
    }

    if (res.signedIn) {
      showSignedIn(res.lastSync);
    } else {
      showSignedOut();
    }
  });
}

// ─── UI State ────────────────────────────────────────────────────────

function showSignedIn(lastSync) {
  statusDot.className = 'status-dot connected';
  statusText.textContent = 'Connected to Google Calendar';
  signInArea.classList.add('hidden');
  signedInArea.classList.remove('hidden');
  hideError();
  loadCalendars();

  if (lastSync > 0) {
    const ago = formatTimeAgo(lastSync);
    syncInfo.textContent = `Last synced ${ago}`;
  } else {
    syncInfo.textContent = 'Not synced yet';
  }
}

function showSignedOut() {
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = 'Not connected';
  signInArea.classList.remove('hidden');
  signedInArea.classList.add('hidden');
  calendarsSection.classList.add('hidden');
  syncInfo.textContent = '—';
}

function showError(msg) {
  errorText.textContent = msg;
  errorText.classList.remove('hidden');
}

function hideError() {
  errorText.classList.add('hidden');
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// ─── Actions ─────────────────────────────────────────────────────────

btnSignIn.addEventListener('click', () => {
  btnSignIn.disabled = true;
  btnSignIn.innerHTML = '<span class="loading"></span> Connecting...';
  hideError();

  chrome.runtime.sendMessage({ type: 'SIGN_IN' }, (res) => {
    btnSignIn.disabled = false;
    btnSignIn.textContent = 'Sign in with Google';

    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }

    if (res && res.type === 'ERROR') {
      showError(res.error);
      return;
    }

    showSignedIn(0);
  });
});

btnSignOut.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, (res) => {
    if (res && res.type === 'ERROR') {
      showError(res.error);
      return;
    }
    showSignedOut();
  });
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.disabled = true;
  btnRefresh.textContent = '↻ Syncing...';

  chrome.runtime.sendMessage({ type: 'REFRESH' }, (res) => {
    btnRefresh.disabled = false;
    btnRefresh.textContent = '↻ Refresh';

    if (res && res.type === 'ERROR') {
      showError(res.error);
      return;
    }

    syncInfo.textContent = 'Last synced just now';

    // Also push events to active Focusmate tabs
    if (res && res.events) {
      chrome.tabs.query({ url: 'https://www.focusmate.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'EVENTS_UPDATED', events: res.events }).catch(() => {});
        }
      });
    }
  });
});

toggleEnabled.addEventListener('change', () => {
  const val = toggleEnabled.checked;
  chrome.storage.sync.set({ enabled: val });
});

// ─── Calendar Picker ────────────────────────────────────────────────

function loadCalendars() {
  chrome.runtime.sendMessage({ type: 'GET_CALENDARS' }, async (res) => {
    if (chrome.runtime.lastError || !res || res.type === 'ERROR') return;

    const calendars = res.calendars || [];
    if (calendars.length === 0) return;

    calendarsSection.classList.remove('hidden');

    const { selectedCalendars } = await chrome.storage.sync.get('selectedCalendars');
    const selectedIds = selectedCalendars ? selectedCalendars.map(c => c.id) : null;

    calendarList.innerHTML = '';

    calendars.forEach(cal => {
      const checked = selectedIds === null || selectedIds.includes(cal.id);

      const label = document.createElement('label');
      label.className = 'cal-item';
      label.style.setProperty('--cal-color', cal.color);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked;
      checkbox.dataset.calId = cal.id;
      checkbox.dataset.calColor = cal.color;

      const dot = document.createElement('span');
      dot.className = 'cal-dot';
      dot.style.background = cal.color;

      const name = document.createElement('span');
      name.className = 'cal-name';
      name.textContent = cal.name;

      label.appendChild(checkbox);
      label.appendChild(dot);
      label.appendChild(name);
      calendarList.appendChild(label);

      checkbox.addEventListener('change', saveCalendarSelection);
    });

    updateSelectAllBtn();
  });
}

function saveCalendarSelection() {
  const checkboxes = calendarList.querySelectorAll('input[type="checkbox"]');
  const selected = [];
  checkboxes.forEach(cb => {
    if (cb.checked) {
      selected.push({ id: cb.dataset.calId, color: cb.dataset.calColor });
    }
  });

  chrome.storage.sync.set({ selectedCalendars: selected });
  updateSelectAllBtn();

  // Trigger a refresh so overlays update
  chrome.runtime.sendMessage({ type: 'REFRESH' }, (res) => {
    if (res && res.events) {
      chrome.tabs.query({ url: ['https://www.focusmate.com/*', 'https://app.focusmate.com/*'] }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'EVENTS_UPDATED', events: res.events }).catch(() => {});
        }
      });
    }
  });
}

function updateSelectAllBtn() {
  const checkboxes = calendarList.querySelectorAll('input[type="checkbox"]');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  btnSelectAll.textContent = allChecked ? 'Deselect all' : 'Select all';
}

btnSelectAll.addEventListener('click', () => {
  const checkboxes = calendarList.querySelectorAll('input[type="checkbox"]');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  checkboxes.forEach(cb => { cb.checked = !allChecked; });
  saveCalendarSelection();
});

// ─── Start ───────────────────────────────────────────────────────────

init();
