// background.js — Service Worker
// Handles Google OAuth, Calendar API calls, caching, and message passing

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_INTERVAL_MIN = 5;
const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3';

// ─── Token Management ───────────────────────────────────────────────

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

// ─── Google Calendar API ─────────────────────────────────────────────

async function gcalFetch(endpoint, token) {
  const res = await fetch(`${GCAL_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) {
    // Token expired — remove and retry once
    await removeCachedToken(token);
    const newToken = await getAuthToken(false);
    const retry = await fetch(`${GCAL_API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${newToken}` }
    });
    if (!retry.ok) throw new Error(`GCal API error: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`GCal API error: ${res.status}`);
  return res.json();
}

async function fetchCalendarList(token) {
  const data = await gcalFetch('/users/me/calendarList?minAccessRole=reader', token);
  return (data.items || []).map(cal => ({
    id: cal.id,
    name: cal.summary,
    color: cal.backgroundColor,
    primary: cal.primary || false
  }));
}

async function fetchEvents(token, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  });

  const encodedCalId = encodeURIComponent(calendarId);
  const data = await gcalFetch(`/calendars/${encodedCalId}/events?${params}`, token);

  return (data.items || [])
    .filter(evt => evt.start && (evt.start.dateTime || evt.start.date))
    .map(evt => {
      const isAllDay = !evt.start.dateTime;
      const startDt = new Date(evt.start.dateTime || evt.start.date);
      const endDt = new Date(evt.end.dateTime || evt.end.date);

      return {
        id: evt.id,
        title: evt.summary || '(No title)',
        date: `${startDt.getFullYear()}-${String(startDt.getMonth() + 1).padStart(2, '0')}-${String(startDt.getDate()).padStart(2, '0')}`,
        start: isAllDay ? null : `${String(startDt.getHours()).padStart(2, '0')}:${String(startDt.getMinutes()).padStart(2, '0')}`,
        end: isAllDay ? null : `${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}`,
        isAllDay,
        calendarId,
        color: evt.colorId || null // Per-event color override
      };
    });
}

async function fetchAllEvents(dateRange) {
  const token = await getAuthToken(false);

  // Get user's selected calendars (or default to primary)
  const { selectedCalendars } = await chrome.storage.sync.get('selectedCalendars');

  let calendars;
  if (selectedCalendars && selectedCalendars.length > 0) {
    calendars = selectedCalendars;
  } else {
    // Default: all calendars
    const calList = await fetchCalendarList(token);
    calendars = calList.map(c => ({ id: c.id, color: c.color }));
  }

  // Fetch events from all selected calendars in parallel
  const results = await Promise.allSettled(
    calendars.map(cal =>
      fetchEvents(token, cal.id, dateRange.start, dateRange.end)
        .then(events => events.map(evt => ({ ...evt, calColor: cal.color })))
    )
  );

  const events = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  return events;
}

// ─── Cache ───────────────────────────────────────────────────────────

const cache = {
  events: null,
  dateRange: null,
  timestamp: 0
};

function cacheIsValid(dateRange) {
  return (
    cache.events &&
    cache.dateRange &&
    cache.dateRange.start === dateRange.start &&
    cache.dateRange.end === dateRange.end &&
    Date.now() - cache.timestamp < CACHE_TTL_MS
  );
}

async function getEvents(dateRange, forceRefresh = false) {
  if (!forceRefresh && cacheIsValid(dateRange)) {
    return cache.events;
  }

  const events = await fetchAllEvents(dateRange);
  cache.events = events;
  cache.dateRange = { ...dateRange };
  cache.timestamp = Date.now();

  return events;
}

// ─── Message Handling ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_EVENTS') {
    getEvents(msg.dateRange, msg.forceRefresh)
      .then(events => sendResponse({ type: 'EVENTS_DATA', events }))
      .catch(err => sendResponse({ type: 'ERROR', error: err.message }));
    return true; // async response
  }

  if (msg.type === 'GET_CALENDARS') {
    getAuthToken(false)
      .then(token => fetchCalendarList(token))
      .then(calendars => sendResponse({ type: 'CALENDARS_DATA', calendars }))
      .catch(err => sendResponse({ type: 'ERROR', error: err.message }));
    return true;
  }

  if (msg.type === 'SIGN_IN') {
    getAuthToken(true)
      .then(token => {
        sendResponse({ type: 'SIGNED_IN', success: true });
      })
      .catch(err => sendResponse({ type: 'ERROR', error: err.message }));
    return true;
  }

  if (msg.type === 'SIGN_OUT') {
    getAuthToken(false)
      .then(token => {
        // Revoke the token
        return fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .then(() => removeCachedToken(token));
      })
      .then(() => {
        cache.events = null;
        cache.dateRange = null;
        cache.timestamp = 0;
        sendResponse({ type: 'SIGNED_OUT', success: true });
      })
      .catch(err => sendResponse({ type: 'ERROR', error: err.message }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    getAuthToken(false)
      .then(() => sendResponse({ type: 'STATUS', signedIn: true, lastSync: cache.timestamp }))
      .catch(() => sendResponse({ type: 'STATUS', signedIn: false, lastSync: 0 }));
    return true;
  }

  if (msg.type === 'REFRESH') {
    if (cache.dateRange) {
      getEvents(cache.dateRange, true)
        .then(events => sendResponse({ type: 'EVENTS_DATA', events }))
        .catch(err => sendResponse({ type: 'ERROR', error: err.message }));
    } else {
      sendResponse({ type: 'ERROR', error: 'No date range cached. Navigate Focusmate first.' });
    }
    return true;
  }
});

// ─── Periodic Sync ──────────────────────────────────────────────────

chrome.alarms.create('gcal-sync', { periodInMinutes: SYNC_INTERVAL_MIN });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'gcal-sync') return;
  if (!cache.dateRange) return;

  try {
    await getEvents(cache.dateRange, true);
    // Notify any active Focusmate tabs
    const tabs = await chrome.tabs.query({ url: 'https://www.focusmate.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'EVENTS_UPDATED', events: cache.events }).catch(() => {});
    }
  } catch (err) {
    console.error('[GCal Overlay] Sync failed:', err.message);
  }
});

console.log('[GCal Overlay] Background service worker loaded');
