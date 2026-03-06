# Focusmate Calendar Overlay

Chrome extension that overlays your Google Calendar events onto the Focusmate calendar, so you can see your full schedule in one place.

## Setup (Personal Use — Load Unpacked)

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (e.g. "Focusmate GCal Overlay")
3. Go to **APIs & Services → Library** → search for **Google Calendar API** → Enable it
4. Go to **APIs & Services → Credentials** → **Create Credentials → OAuth Client ID**
   - Application type: **Chrome Extension**
   - You'll need the extension ID first — do step 2 below, then come back and add it
5. Go to **APIs & Services → OAuth consent screen**
   - User type: External
   - Add scope: `https://www.googleapis.com/auth/calendar.readonly`
   - Add your Google account as a test user

### 2. Load the Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select this folder
4. Copy the **Extension ID** shown on the card (a long string like `abcdef...`)
5. Go back to Google Cloud Console → edit your OAuth Client ID → paste the Extension ID

### 3. Configure

1. Open `manifest.json`
2. Replace `YOUR_CLIENT_ID.apps.googleusercontent.com` with your actual OAuth Client ID
3. Go to `chrome://extensions` → click the reload button on the extension

### 4. Use It

1. Click the extension icon in the toolbar
2. Click **Sign in with Google** — authorize calendar read access
3. Go to [focusmate.com](https://www.focusmate.com) → your Google Calendar events appear as blue overlays

## How It Works

- **Content script** detects Focusmate's calendar grid by reading the `:15`/`:30`/`:45` time markers and computing pixels-per-hour
- **Background worker** fetches your Google Calendar events via the official API
- Events are rendered as semi-transparent overlays positioned using the detected grid math
- A MutationObserver watches for view changes (1-day, 2-day, week) and re-renders automatically
- Events sync every 5 minutes in the background

## Files

```
manifest.json      — Extension config (Manifest V3)
background.js      — Service worker: OAuth, GCal API, caching
content.js         — Grid detection, overlay rendering, DOM observation
overlay.css        — Overlay styling
popup.html/js      — Extension popup: auth, toggle, refresh
icons/             — Extension icons
```
