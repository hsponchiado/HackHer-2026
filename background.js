/**
 * SafeSpace AI — Background Service Worker
 * Handles API calls to Perspective AI, message routing,
 * statistics aggregation, and extension lifecycle.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const PERSPECTIVE_API_URL =
  "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze";

const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivityThreshold: 0.7,
  apiKey: "",
  filters: {
    toxicity: true,
    severeToxicity: true,
    threat: true,
    insult: true,
    identityAttack: true,
    sexuallyExplicit: false,
  },
  evidenceMode: false,
  notificationsEnabled: true,
  blurStrength: "medium",
};

const STATS_KEY     = "safespace_stats";
const SETTINGS_KEY  = "safespace_settings";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    await chrome.storage.local.set({
      [STATS_KEY]: {
        totalScanned: 0,
        totalBlocked: 0,
        sessionsProtected: 0,
        byCategory: {},
        recentEvents: [],
      },
    });
    console.log("[SafeSpace AI] Installed & initialized.");
  }
});

// Count unique tab activations as "sessions"
chrome.tabs.onActivated.addListener(async () => {
  const stats = await getStats();
  stats.sessionsProtected += 1;
  await saveStats(stats);
});

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "ANALYZE_TEXT":
        sendResponse(await analyzeText(message.payload));
        break;

      case "GET_SETTINGS":
        sendResponse(await getSettings());
        break;

      case "SAVE_SETTINGS":
        await saveSettings(message.payload);
        sendResponse({ success: true });
        break;

      case "GET_STATS":
        sendResponse(await getStats());
        break;

      case "RECORD_DETECTION":
        await recordDetection(message.payload);
        sendResponse({ success: true });
        break;

      // FIX: handle scanned-item accounting sent from content script
      case "RECORD_SCANNED":
        await recordScanned(message.payload?.count || 1);
        sendResponse({ success: true });
        break;

      case "CLEAR_STATS":
        await clearStats();
        sendResponse({ success: true });
        break;

      case "CAPTURE_EVIDENCE":
        await captureEvidence(message.payload, sender.tab);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true; // Keep channel open for async response
});

// ─── Perspective API Integration ─────────────────────────────────────────────

async function analyzeText({ texts, requestedAttributes }) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    return { error: "NO_API_KEY", message: "Please add your Perspective API key in settings." };
  }

  if (!settings.enabled) {
    return { skipped: true };
  }

  const filterMap = {
    toxicity:        "TOXICITY",
    severeToxicity:  "SEVERE_TOXICITY",
    threat:          "THREAT",
    insult:          "INSULT",
    identityAttack:  "IDENTITY_ATTACK",
    sexuallyExplicit:"SEXUALLY_EXPLICIT",
  };

  const attributes = {};
  const activeFilters = requestedAttributes ||
    Object.entries(settings.filters)
      .filter(([, enabled]) => enabled)
      .map(([key]) => filterMap[key])
      .filter(Boolean);

  activeFilters.forEach((attr) => (attributes[attr] = {}));

  const results = await Promise.allSettled(
    texts.map((text) => callPerspectiveAPI(text, attributes, settings.apiKey))
  );

  return results.map((result, i) => ({
    text: texts[i],
    ...(result.status === "fulfilled" ? result.value : { error: result.reason?.message }),
  }));
}

async function callPerspectiveAPI(text, requestedAttributes, apiKey) {
  if (!text || text.trim().length < 10) {
    return { skipped: true, reason: "too_short" };
  }

  const body = {
    comment: { text },
    requestedAttributes,
    languages: ["en"],
    doNotStore: true, // Privacy: Perspective must not store submitted text
  };

  const response = await fetch(`${PERSPECTIVE_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();

  const scores = {};
  let maxScore = 0;
  let dominantCategory = null;

  Object.entries(data.attributeScores || {}).forEach(([attr, val]) => {
    const score = val.summaryScore?.value ?? 0;
    scores[attr.toLowerCase()] = score;
    if (score > maxScore) {
      maxScore = score;
      dominantCategory = attr.toLowerCase();
    }
  });

  return { scores, maxScore, dominantCategory };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

// FIX: properly increment totalScanned
async function recordScanned(count = 1) {
  const stats = await getStats();
  stats.totalScanned = (stats.totalScanned || 0) + count;
  await saveStats(stats);
}

async function recordDetection({ category, score, url }) {
  const stats = await getStats();
  stats.totalBlocked = (stats.totalBlocked || 0) + 1;

  if (category) {
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }

  // Keep last 50 events — no text stored (privacy)
  stats.recentEvents.unshift({
    timestamp: Date.now(),
    category,
    score: Math.round(score * 100),
    domain: url ? new URL(url).hostname : "unknown",
  });
  if (stats.recentEvents.length > 50) stats.recentEvents.pop();

  await saveStats(stats);

  chrome.action.setBadgeText({ text: String(stats.totalBlocked) });
  chrome.action.setBadgeBackgroundColor({ color: "#e05c7a" });
}

async function clearStats() {
  await chrome.storage.local.set({
    [STATS_KEY]: {
      totalScanned: 0,
      totalBlocked: 0,
      sessionsProtected: 0,
      byCategory: {},
      recentEvents: [],
    },
  });
  chrome.action.setBadgeText({ text: "" });
}

// ─── Evidence Capture ─────────────────────────────────────────────────────────

async function captureEvidence({ text, scores, url, timestamp }, tab) {
  const evidence = {
    id: `ev_${Date.now()}`,
    text: text.substring(0, 500),
    scores,
    url,
    timestamp,
    tabTitle: tab?.title || "",
  };

  const existing = (await chrome.storage.local.get("safespace_evidence"))
    .safespace_evidence || [];
  existing.unshift(evidence);
  if (existing.length > 20) existing.pop();

  await chrome.storage.local.set({ safespace_evidence: existing });
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...settings } });
}

async function getStats() {
  const data = await chrome.storage.local.get(STATS_KEY);
  return data[STATS_KEY] || {
    totalScanned: 0,
    totalBlocked: 0,
    sessionsProtected: 0,
    byCategory: {},
    recentEvents: [],
  };
}

async function saveStats(stats) {
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}