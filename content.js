// content.js — Injected into Focusmate pages
// Detects calendar grid, maps columns to dates, renders GCal event overlays

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────

  let enabled = true;
  let currentEvents = [];
  let currentColumns = {};
  let gridParams = null; // { pxPerHour, midnightPx }
  let scrollArea = null;
  let contentDiv = null;
  let renderDebounceTimer = null;
  let lastDateRangeKey = '';
  let isRendering = false;

  const RENDER_DEBOUNCE_MS = 250;
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ─── Initialization ────────────────────────────────────────────────

  function init() {
    // Check if extension is enabled
    chrome.storage.sync.get('enabled', (data) => {
      enabled = data.enabled !== false; // default on
      if (enabled) waitForCalendar();
    });

    // Listen for toggle changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.enabled) {
        enabled = changes.enabled.newValue;
        if (enabled) {
          waitForCalendar();
        } else {
          removeOverlays();
        }
      }
    });

    // Listen for background push updates (periodic sync)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'EVENTS_UPDATED' && enabled) {
        currentEvents = msg.events;
        renderOverlays();
      }
    });
  }

  function waitForCalendar() {
    const fmCal = document.querySelector('fm-calendar-days');
    if (fmCal) {
      onCalendarReady(fmCal);
      return;
    }

    // Watch for fm-calendar-days to appear
    const bodyObserver = new MutationObserver(() => {
      const cal = document.querySelector('fm-calendar-days');
      if (cal) {
        bodyObserver.disconnect();
        onCalendarReady(cal);
      }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function onCalendarReady(fmCal) {
    scrollArea = fmCal.querySelector('[class*="overflow-y-auto"]');
    if (!scrollArea) {
      console.warn('[GCal Overlay] Could not find scroll area inside fm-calendar-days');
      return;
    }

    // Find the content container for absolute positioning
    contentDiv = scrollArea.querySelector('[class*="relative"]') || scrollArea;

    // Initial render
    detectAndRender(fmCal);

    // Watch for DOM changes (view switch, date navigation)
    const calObserver = new MutationObserver((mutations) => {
      if (!enabled || isRendering) return;
      // Ignore mutations caused by our own overlays
      const isOwnMutation = mutations.every(m =>
        [...m.addedNodes, ...m.removedNodes].every(n =>
          n.classList && n.classList.contains('gcal-overlay')
        )
      );
      if (isOwnMutation) return;
      debouncedRender(fmCal);
    });

    calObserver.observe(fmCal, { childList: true, subtree: true });

    console.log('[GCal Overlay] Calendar detected, observer attached');
  }

  // ─── Grid Detection ────────────────────────────────────────────────

  function detectGrid() {
    if (!scrollArea) return null;

    // Find all :15 quarter-hour markers with top positioning
    const q15Tops = [];

    scrollArea.querySelectorAll('*').forEach(el => {
      const style = el.getAttribute('style') || '';
      const topMatch = style.match(/top:\s*([\d.]+)px/);
      if (topMatch && el.textContent.trim() === ':15') {
        q15Tops.push(parseFloat(topMatch[1]));
      }
    });

    q15Tops.sort((a, b) => a - b);

    if (q15Tops.length < 2) {
      console.warn('[GCal Overlay] Not enough :15 markers to detect grid');
      return null;
    }

    // Calculate pixels per hour from consecutive :15 markers
    // Each :15 marker is 1 hour apart
    const pxPerHour = q15Tops[1] - q15Tops[0];

    // Midnight = first :15 marker's position minus 15 minutes worth of pixels
    // First :15 marker is at some hour + 15min, so midnight is (hourValue + 0.25) hours above it
    // But we don't know the hour — we can derive it:
    // midnightPx = first_q15_top - (hourOfFirst * pxPerHour) - (15/60 * pxPerHour)
    // However, simpler: midnight = first_q15_top - (pxPerHour / 4) - (N * pxPerHour)
    // where N is the hour of the first :15 marker
    // Since the first :15 is likely at some early hour, we can compute from the known offset:
    // We know first :15 is at 44px (from data), and midnight is at -4px
    // More robustly: midnightPx = q15Tops[0] - (pxPerHour * 0.25) - (Math.round((q15Tops[0]) / pxPerHour) * pxPerHour)
    // Simplest reliable method: the first :15 in the data divided by pxPerHour gives us the hour
    const firstQ15Px = q15Tops[0];
    const midnightPx = firstQ15Px - Math.round(firstQ15Px / pxPerHour) * pxPerHour - pxPerHour / 4;

    return { pxPerHour, midnightPx };
  }

  // ─── Column Detection ──────────────────────────────────────────────

  function detectColumns(fmCal) {
    const columns = {};

    // Parse month/year from the page header ("Feb 2026", "Mar 2026")
    const pageText = document.body.innerText;
    const monthYearMatch = pageText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/i);
    const year = monthYearMatch ? parseInt(monthYearMatch[2]) : new Date().getFullYear();
    const monthIdx = monthYearMatch
      ? MONTH_NAMES.findIndex(m => monthYearMatch[1].toLowerCase().startsWith(m.toLowerCase()))
      : new Date().getMonth();

    // Find day header spans ("Tue 24", "Wed 25", etc.)
    const dayHeaders = [];
    fmCal.querySelectorAll('span').forEach(span => {
      const txt = span.textContent.trim();
      const dm = txt.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+)$/);
      if (dm) {
        dayHeaders.push({
          span,
          dayName: dm[1],
          dayNum: parseInt(dm[2]),
          text: txt
        });
      }
    });

    if (dayHeaders.length === 0) {
      console.warn('[GCal Overlay] No day headers found');
      return columns;
    }

    // Walk up from each header span to find the flex-1 column container
    const scrollRect = scrollArea.getBoundingClientRect();

    dayHeaders.forEach(dh => {
      let el = dh.span;
      let found = false;

      while (el && el !== fmCal) {
        const cls = el.className || '';
        if (cls.includes('flex-1')) {
          const r = el.getBoundingClientRect();

          // Handle month boundary: if dayNum < 5 and monthIdx header says e.g. "Feb",
          // the day might actually be in the next month
          let resolvedMonth = monthIdx;
          let resolvedYear = year;

          // If this day number is much smaller than the first header's day number,
          // it's likely next month
          if (dayHeaders.length > 1) {
            const firstDayNum = dayHeaders[0].dayNum;
            if (dh.dayNum < firstDayNum && dh.dayNum < 7) {
              resolvedMonth = monthIdx + 1;
              if (resolvedMonth > 11) {
                resolvedMonth = 0;
                resolvedYear++;
              }
            }
          }

          const dateStr = `${resolvedYear}-${String(resolvedMonth + 1).padStart(2, '0')}-${String(dh.dayNum).padStart(2, '0')}`;
          columns[dateStr] = {
            label: dh.text,
            left: r.left - scrollRect.left + scrollArea.scrollLeft,
            width: r.width
          };
          found = true;
          break;
        }
        el = el.parentElement;
      }

      // Fallback: if flex-1 walk failed, use header position heuristic
      if (!found) {
        const r = dh.span.getBoundingClientRect();
        let resolvedMonth = monthIdx;
        let resolvedYear = year;
        if (dayHeaders.length > 1 && dh.dayNum < dayHeaders[0].dayNum && dh.dayNum < 7) {
          resolvedMonth = monthIdx + 1;
          if (resolvedMonth > 11) { resolvedMonth = 0; resolvedYear++; }
        }
        const dateStr = `${resolvedYear}-${String(resolvedMonth + 1).padStart(2, '0')}-${String(dh.dayNum).padStart(2, '0')}`;
        columns[dateStr] = {
          label: dh.text,
          left: r.left - scrollRect.left + scrollArea.scrollLeft - 10,
          width: scrollRect.width / dayHeaders.length
        };
      }
    });

    return columns;
  }

  // ─── Event Fetching ────────────────────────────────────────────────

  function getVisibleDateRange(columns) {
    const dates = Object.keys(columns).sort();
    if (dates.length === 0) return null;

    // Start of first visible day
    const start = dates[0] + 'T00:00:00';
    // End of last visible day (next day midnight)
    const lastDate = new Date(dates[dates.length - 1]);
    lastDate.setDate(lastDate.getDate() + 1);
    const end = lastDate.toISOString().slice(0, 10) + 'T00:00:00';

    return { start, end };
  }

  function fetchEvents(dateRange) {
    chrome.runtime.sendMessage(
      { type: 'GET_EVENTS', dateRange },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[GCal Overlay] Message error:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.type === 'EVENTS_DATA') {
          currentEvents = response.events;
          renderOverlays();
        } else if (response && response.type === 'ERROR') {
          console.warn('[GCal Overlay] Error fetching events:', response.error);
        }
      }
    );
  }

  // ─── Overlay Rendering ─────────────────────────────────────────────

  function timeToPx(timeStr) {
    if (!gridParams) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return gridParams.midnightPx + ((h * 60 + m) / 60) * gridParams.pxPerHour;
  }

  function removeOverlays() {
    if (scrollArea) {
      scrollArea.querySelectorAll('.gcal-overlay').forEach(el => el.remove());
    }
  }

  function renderOverlays() {
    isRendering = true;
    removeOverlays();

    if (!enabled || !gridParams || !contentDiv) {
      isRendering = false;
      return;
    }

    let rendered = 0;

    currentEvents.forEach(evt => {
      // Skip all-day events for now (Phase 2 feature)
      if (evt.isAllDay || !evt.start || !evt.end) return;

      const col = currentColumns[evt.date];
      if (!col) return;

      const top = timeToPx(evt.start);
      const height = timeToPx(evt.end) - top;

      if (height <= 0) return;

      // Determine color
      const color = evt.calColor || '#4285f4';
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);

      const div = document.createElement('div');
      div.className = 'gcal-overlay';
      div.style.cssText = `
        top: ${top}px;
        left: ${col.left}px;
        width: ${col.width}px;
        height: ${height}px;
        background: rgba(${r}, ${g}, ${b}, 0.18);
        border-color: rgba(${r}, ${g}, ${b}, 0.7);
      `;

      div.innerHTML = `
        <span class="gcal-title">${escapeHtml(evt.title)}</span>
        <span class="gcal-time">${evt.start} – ${evt.end}</span>
      `;

      contentDiv.appendChild(div);
      rendered++;
    });

    isRendering = false;
    console.log(`[GCal Overlay] Rendered ${rendered} overlays`);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Main Detection + Render Flow ──────────────────────────────────

  function detectAndRender(fmCal) {
    gridParams = detectGrid();
    if (!gridParams) return;

    currentColumns = detectColumns(fmCal);
    console.log('[GCal Overlay] Columns:', JSON.stringify(currentColumns));
    console.log('[GCal Overlay] Events:', currentEvents.map(e => `${e.date} ${e.start}-${e.end} ${e.title}`));
    const dateRange = getVisibleDateRange(currentColumns);
    if (!dateRange) return;

    const dateRangeKey = `${dateRange.start}|${dateRange.end}`;

    // Only re-fetch if the date range changed
    if (dateRangeKey !== lastDateRangeKey) {
      lastDateRangeKey = dateRangeKey;
      fetchEvents(dateRange);
    } else {
      // Same dates, just re-render (view rebuilt but dates same)
      renderOverlays();
    }
  }

  function debouncedRender(fmCal) {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => detectAndRender(fmCal), RENDER_DEBOUNCE_MS);
  }

  // ─── Start ─────────────────────────────────────────────────────────

  init();
  console.log('[GCal Overlay] Content script loaded');

})();
