# HackHer-2026
# SafeSpace — Chrome Extension

> Real-time AI powered protection from online harassment, abusive language, and threats.

## Setup

### 1. Prerequisites
- Google Chrome (v109+)
- A [Perspective API key](https://perspectiveapi.com/) (free)

### 2. Install the Extension
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load Unpacked** and select this folder (`safespace-ai/`)
4. The SafeSpace AI icon will appear in your toolbar

### 3. Configure Your API Key
1. Click the SafeSpace AI icon in the toolbar
2. Go to the **🔒 Protect** tab
3. Paste your Perspective API key and click **Save Key**
4. Click **Test** to verify it's working

---

## Project Structure

```
safespace-ai/
├── manifest.json                  # Extension manifest (MV3)
├── icons/                         # Extension icons (16, 32, 48, 128px)
├── src/
│   ├── background/
│   │   └── background.js          # Service worker: API calls, message routing
│   ├── content/
│   │   ├── content.js             # DOM scanning, mutation observer, blur logic
│   │   └── content.css            # Injected styles for blur/badge UI
│   ├── popup/
│   │   ├── popup.html             # Control panel UI
│   │   └── popup.js               # Popup logic, settings, stats
│   └── utils/
│       └── helpers.js             # Shared utilities
```

---

## Architecture

### Manifest V3
- Uses `service_worker` instead of background pages
- Content scripts injected at `document_idle` on all URLs
- Permissions: `storage`, `activeTab`, `scripting`, `notifications`

### Content Script Logic
1. **Initial Scan** — `querySelectorAll` on meaningful content selectors
2. **MutationObserver** — monitors dynamically loaded content (infinite scroll, DMs)
3. **Debounced Queue** — batches up to 10 texts per 500ms to avoid rate limits
4. **Analysis** — sends to background.js → Perspective API
5. **Blur/Badge** — injects overlay on detected harmful content

### Privacy
- `doNotStore: true` in all Perspective API requests
- No browsing history or text stored permanently
- Evidence captured only on explicit user action
- Session stats stored locally only

---

## Features

| Feature | Description |
|---------|-------------|
| Real-time scanning | Analyzes visible text as pages load |
| Dynamic content | MutationObserver catches infinite scroll, AJAX |
| Blur & reveal | Harmful content blurred with click-to-reveal |
| Sensitivity control | Slider from 0–100% threshold |
| Category filters | 6 content categories individually toggleable |
| Protection profiles | Gentle / Balanced / Strict presets |
| Statistics dashboard | Blocks, sessions, category breakdown, recent events |
| Evidence mode | Capture flagged content for reporting |
| Evidence export | Download evidence as JSON |
| Floating toasts | Dismissible real-time alerts |
| Privacy-first | No permanent data storage |

---

## Rate Limits

Perspective API free tier: 1 QPS. The content script implements:
- Debounced queue flushes (500ms)
- Batch size limit (10 texts/batch)
- Inter-batch delay (1000ms)
- Minimum text length (15 chars) to skip trivial nodes

---

## Demo Tips

1. Test on **Twitter/X**, **Reddit**, **YouTube comments**, or **Discord**
2. Enable **Evidence Mode** to showcase capture flow
3. Use **Strict** profile for dramatic live demos
4. The **Stats** tab updates in real-time as detections occur

---

*Built with ❤️ for safety. Powered by [Perspective API](https://perspectiveapi.com/).*
