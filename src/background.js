/**
 * SafeSpace AI — Background Service Worker
 * Handles API calls to Perspective AI, message routing,
 * statistics aggregation, and extension lifecycle.
 */

import { Utils } from "./helpers.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PERSPECTIVE_API_URL =
  "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze";

const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivityThreshold: 0.7,      // 0.0 – 1.0
  apiKey: "",                      // User-supplied Perspective API key
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
  blurStrength: "medium",          // "light" | "medium" | "heavy"
  parentalLock: false,
};

const STATS_KEY = "safespace_stats";
const SETTINGS_KEY = "safespace_settings";

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

// Track active tabs for session counting
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

      case "RECORD_SCANNED":
        await recordScanned(message.payload.count || 0);
        sendResponse({ success: true });
        break;

      case "RECORD_DETECTION":
        await recordDetection(message.payload);
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

      case "PARENTAL_SET_PIN":
        sendResponse(await setParentalPin(message.payload.pin));
        break;

      case "PARENTAL_VERIFY_PIN":
        sendResponse(await verifyParentalPin(message.payload.pin));
        break;

      case "PARENTAL_GET_STATUS":
        sendResponse(await getParentalStatus());
        break;

      case "PARENTAL_CLEAR_PIN":
        await clearParentalPin();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true; // Keep message channel open for async response
});

// ─── Perspective API Integration ─────────────────────────────────────────────

/**
 * Analyzes a batch of text snippets using the Perspective API.
 * @param {Object} payload - { texts: string[], requestedAttributes: string[] }
 * @returns {Promise<Object[]>} Array of analysis results
 */
async function analyzeText({ texts, requestedAttributes }) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    return { error: "NO_API_KEY", message: "Please add your Perspective API key in settings." };
  }

  if (!settings.enabled) {
    return { skipped: true };
  }

  // Build requested attributes from enabled filters
  const attributes = {};
  const filterMap = {
    toxicity: "TOXICITY",
    severeToxicity: "SEVERE_TOXICITY",
    threat: "THREAT",
    insult: "INSULT",
    identityAttack: "IDENTITY_ATTACK",
    sexuallyExplicit: "SEXUALLY_EXPLICIT",
  };

  const activeFilters = requestedAttributes ||
    Object.entries(settings.filters)
      .filter(([, enabled]) => enabled)
      .map(([key]) => filterMap[key])
      .filter(Boolean);

  activeFilters.forEach((attr) => (attributes[attr] = {}));

  // Batch process texts — Perspective API handles one text per request
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
    doNotStore: true, // Privacy: Perspective should not store the text
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

  // Extract scores
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

  return {
    scores,
    maxScore,
    dominantCategory,
    isToxic: maxScore >= 0, // Caller decides based on threshold
  };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

async function recordDetection({ category, score, url }) {
  const stats = await getStats();
  stats.totalBlocked += 1;

  if (category) {
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }

  // Keep last 50 events (no text content stored — privacy)
  stats.recentEvents.unshift({
    timestamp: Date.now(),
    category,
    score: Math.round(score * 100),
    domain: url ? new URL(url).hostname : "unknown",
  });
  if (stats.recentEvents.length > 50) stats.recentEvents.pop();

  await saveStats(stats);

  // Badge
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

async function recordScanned(count) {
  const stats = await getStats();
  stats.totalScanned = (stats.totalScanned || 0) + count;
  await saveStats(stats);
}

// ─── Evidence Capture ─────────────────────────────────────────────────────────

async function captureEvidence({ text, scores, url, timestamp }, tab) {
  const evidence = {
    id: `ev_${Date.now()}`,
    text: text.substring(0, 500), // Limit stored text
    scores,
    url,
    timestamp,
    tabTitle: tab?.title || "",
  };

  const existing = (await chrome.storage.local.get("safespace_evidence"))
    .safespace_evidence || [];
  existing.unshift(evidence);
  if (existing.length > 20) existing.pop(); // Keep last 20 captures

  await chrome.storage.local.set({ safespace_evidence: existing });
}

// ─── Parental Lock ────────────────────────────────────────────────────────────

async function hashPin(pin) {
  const data = new TextEncoder().encode("safespace_pin_v1:" + String(pin));
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function setParentalPin(pin) {
  await chrome.storage.local.set({
    safespace_parental: { pinHash: await hashPin(pin), setAt: Date.now() },
  });
  return { success: true };
}

async function verifyParentalPin(pin) {
  const { safespace_parental: p } = await chrome.storage.local.get("safespace_parental");
  if (!p?.pinHash) return { success: false, error: "no_pin_set" };
  return { success: (await hashPin(String(pin))) === p.pinHash };
}

async function getParentalStatus() {
  const { safespace_parental: p } = await chrome.storage.local.get("safespace_parental");
  return { hasPIN: !!(p?.pinHash) };
}

async function clearParentalPin() {
  await chrome.storage.local.remove("safespace_parental");
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Deep-merge filters so new keys added to DEFAULT_SETTINGS always get their default value
    filters: { ...DEFAULT_SETTINGS.filters, ...(stored.filters || {}) },
  };
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