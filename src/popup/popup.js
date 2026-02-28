/**
 * SafeSpace AI — Popup Control Panel
 * Manages all UI interactions, settings, and stats display.
 */

// ─── Filter Definitions ──────────────────────────────────────────────────────

const FILTER_DEFS = [
  { key: "toxicity",         label: "General Toxicity",      icon: "🤬", desc: "Rude, disrespectful language" },
  { key: "severeToxicity",   label: "Severe Toxicity",       icon: "💀", desc: "Extremely harsh content" },
  { key: "threat",           label: "Threats & Violence",    icon: "⚡", desc: "Threatening or violent language" },
  { key: "insult",           label: "Insults",               icon: "👊", desc: "Personal attacks" },
  { key: "identityAttack",   label: "Hate Speech",           icon: "🎯", desc: "Attacks on identity groups" },
  { key: "sexuallyExplicit", label: "Explicit Content",      icon: "🔞", desc: "Sexually explicit material" },
];

const PROFILES = {
  gentle:   { threshold: 0.85, filters: { toxicity: true,  severeToxicity: true,  threat: true,  insult: false, identityAttack: true,  sexuallyExplicit: false } },
  balanced: { threshold: 0.70, filters: { toxicity: true,  severeToxicity: true,  threat: true,  insult: true,  identityAttack: true,  sexuallyExplicit: false } },
  strict:   { threshold: 0.50, filters: { toxicity: true,  severeToxicity: true,  threat: true,  insult: true,  identityAttack: true,  sexuallyExplicit: true  } },
};

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let stats = {};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  [settings, stats] = await Promise.all([
    sendMessage({ type: "GET_SETTINGS" }),
    sendMessage({ type: "GET_STATS" }),
  ]);

  renderAll();
  bindEvents();
});

// ─── Render ───────────────────────────────────────────────────────────────────

function renderAll() {
  renderHeader();
  renderProtectTab();
  renderStatsTab();
  renderFiltersTab();
  renderEvidenceTab();
}

function renderHeader() {
  // Toggle
  const toggle = document.getElementById("master-toggle");
  setToggle(toggle, settings.enabled);
  document.getElementById("toggle-text").textContent = settings.enabled ? "ON" : "OFF";
  document.getElementById("status-label").textContent = settings.enabled ? "Protection active" : "Protection paused";

  // Stats
  document.getElementById("hdr-blocked").textContent = stats.totalBlocked || 0;
  document.getElementById("hdr-scanned").textContent = stats.totalScanned || 0;
  document.getElementById("hdr-sessions").textContent = stats.sessionsProtected || 0;
}

function renderProtectTab() {
  // Sensitivity
  const slider = document.getElementById("sensitivity-slider");
  const val = Math.round((settings.sensitivityThreshold || 0.7) * 100);
  slider.value = val;
  slider.style.setProperty("--val", val + "%");
  document.getElementById("threshold-display").textContent = val + "%";

  // Blur pills
  document.querySelectorAll(".blur-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.blur === (settings.blurStrength || "medium"));
  });

  // Notif toggle
  setToggle(document.getElementById("notif-toggle"), settings.notificationsEnabled !== false);

  // Evidence toggle
  setToggle(document.getElementById("evidence-toggle"), !!settings.evidenceMode);

  // API key (masked)
  if (settings.apiKey) {
    const input = document.getElementById("api-key-input");
    input.value = settings.apiKey;
    input.placeholder = "Key saved ✓";
    setApiStatus("✅ API key configured", "green");
  }
}

function renderStatsTab() {
  document.getElementById("stat-blocked-big").textContent = stats.totalBlocked || 0;
  document.getElementById("stat-sessions-big").textContent = stats.sessionsProtected || 0;

  // Category bars
  const container = document.getElementById("category-bars");
  const byCategory = stats.byCategory || {};
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);

  if (total === 0) {
    container.innerHTML = `<p style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0">No detections yet</p>`;
  } else {
    const catLabels = {
      toxicity: "Toxicity", severe_toxicity: "Severe", threat: "Threats",
      insult: "Insults", identity_attack: "Hate Speech", sexually_explicit: "Explicit",
    };
    container.innerHTML = Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .map(([cat, count]) => {
        const pct = Math.round((count / total) * 100);
        return `
          <div>
            <div class="flex justify-between mb-1" style="font-size:11px">
              <span style="color:var(--text)">${catLabels[cat] || cat}</span>
              <span style="color:var(--muted)">${count} (${pct}%)</span>
            </div>
            <div style="height:6px;background:#f0e4f0;border-radius:3px;overflow:hidden">
              <div class="cat-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>`;
      }).join("");
  }

  // Recent events
  const evContainer = document.getElementById("recent-events");
  const events = (stats.recentEvents || []).slice(0, 8);
  if (events.length === 0) {
    evContainer.innerHTML = `<p style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0">No events yet</p>`;
  } else {
    evContainer.innerHTML = events.map((ev) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f5eef5;font-size:11px">
        <div style="display:flex;align-items:center;gap:6px">
          <span>${ev.score >= 90 ? "🚨" : ev.score >= 75 ? "⚠️" : "🔔"}</span>
          <span style="color:var(--text);font-weight:500">${ev.domain}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--rose);font-weight:600">${ev.score}%</span>
          <span style="color:var(--muted)">${timeAgo(ev.timestamp)}</span>
        </div>
      </div>
    `).join("");
  }
}

function renderFiltersTab() {
  const container = document.getElementById("filter-list");
  container.innerHTML = FILTER_DEFS.map(({ key, label, icon, desc }) => `
    <label class="filter-check" style="display:flex;align-items:center;gap:10px;cursor:pointer">
      <input type="checkbox" data-filter="${key}" ${settings.filters?.[key] ? "checked" : ""} />
      <span style="font-size:16px">${icon}</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${label}</div>
        <div style="font-size:11px;color:var(--muted)">${desc}</div>
      </div>
    </label>
  `).join("");

  // Bind filter checkboxes
  container.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      settings.filters[cb.dataset.filter] = cb.checked;
      saveSettings();
    });
  });
}

async function renderEvidenceTab() {
  const data = await chrome.storage.local.get("safespace_evidence");
  const evidence = data.safespace_evidence || [];
  const container = document.getElementById("evidence-list");

  if (evidence.length === 0) {
    container.innerHTML = `<p style="font-size:12px;color:var(--muted);text-align:center;padding:16px 0">No evidence captured yet</p>`;
    return;
  }

  container.innerHTML = evidence.slice(0, 10).map((ev) => `
    <div class="evidence-item">
      <p>${ev.text.substring(0, 120)}${ev.text.length > 120 ? "…" : ""}</p>
      <div style="display:flex;justify-content:space-between;margin-top:4px">
        <small>${new URL(ev.url).hostname}</small>
        <small>${new Date(ev.timestamp).toLocaleDateString()}</small>
      </div>
    </div>
  `).join("");
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add("active");

      if (btn.dataset.tab === "evidence") renderEvidenceTab();
      if (btn.dataset.tab === "stats") {
        sendMessage({ type: "GET_STATS" }).then((s) => { stats = s; renderStatsTab(); });
      }
    });
  });

  // Master toggle
  document.getElementById("master-toggle").addEventListener("click", async () => {
    settings.enabled = !settings.enabled;
    setToggle(document.getElementById("master-toggle"), settings.enabled);
    document.getElementById("toggle-text").textContent = settings.enabled ? "ON" : "OFF";
    document.getElementById("status-label").textContent = settings.enabled ? "Protection active" : "Protection paused";
    await saveSettings();
    broadcastSettings();
  });

  // Sensitivity slider
  const slider = document.getElementById("sensitivity-slider");
  slider.addEventListener("input", () => {
    const val = slider.value;
    slider.style.setProperty("--val", val + "%");
    document.getElementById("threshold-display").textContent = val + "%";
    settings.sensitivityThreshold = val / 100;
    debounceSave();
  });

  // Blur pills
  document.querySelectorAll(".blur-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".blur-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      settings.blurStrength = pill.dataset.blur;
      saveSettings();
    });
  });

  // Notif toggle
  document.getElementById("notif-toggle").addEventListener("click", () => {
    settings.notificationsEnabled = !settings.notificationsEnabled;
    setToggle(document.getElementById("notif-toggle"), settings.notificationsEnabled);
    saveSettings();
  });

  // Evidence toggle
  document.getElementById("evidence-toggle").addEventListener("click", () => {
    settings.evidenceMode = !settings.evidenceMode;
    setToggle(document.getElementById("evidence-toggle"), settings.evidenceMode);
    saveSettings();
    broadcastSettings();
  });

  // API key
  document.getElementById("save-api-key").addEventListener("click", () => {
    const key = document.getElementById("api-key-input").value.trim();
    if (!key) { setApiStatus("⚠️ Please enter a key", "orange"); return; }
    settings.apiKey = key;
    saveSettings().then(() => setApiStatus("✅ Key saved successfully!", "green"));
  });

  document.getElementById("test-api-key").addEventListener("click", async () => {
    setApiStatus("Testing…", "gray");
    const result = await sendMessage({
      type: "ANALYZE_TEXT",
      payload: { texts: ["You are absolutely terrible and I hate you."] },
    });
    if (result?.error === "NO_API_KEY") {
      setApiStatus("⚠️ No API key — save one first", "orange");
    } else if (Array.isArray(result) && result[0]?.maxScore !== undefined) {
      setApiStatus(`✅ API working! Score: ${Math.round(result[0].maxScore * 100)}%`, "green");
    } else if (result?.[0]?.error) {
      setApiStatus(`❌ Error: ${result[0].error}`, "red");
    } else {
      setApiStatus("❌ Connection failed", "red");
    }
  });

  // Profile buttons
  document.querySelectorAll("[data-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const profile = PROFILES[btn.dataset.profile];
      if (!profile) return;
      settings.sensitivityThreshold = profile.threshold;
      settings.filters = { ...profile.filters };
      saveSettings().then(() => { renderAll(); broadcastSettings(); });
    });
  });

  // Clear stats
  document.getElementById("clear-stats-btn").addEventListener("click", async () => {
    await sendMessage({ type: "CLEAR_STATS" });
    stats = { totalBlocked: 0, totalScanned: 0, sessionsProtected: 0, byCategory: {}, recentEvents: [] };
    renderHeader();
    renderStatsTab();
  });

  // Export evidence
  document.getElementById("export-evidence-btn").addEventListener("click", async () => {
    const data = await chrome.storage.local.get("safespace_evidence");
    const evidence = data.safespace_evidence || [];
    if (evidence.length === 0) { alert("No evidence to export."); return; }

    const json = JSON.stringify(evidence, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `safespace-evidence-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let saveTimer;
function debounceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 500);
}

async function saveSettings() {
  await sendMessage({ type: "SAVE_SETTINGS", payload: settings });
}

async function broadcastSettings() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", payload: settings }).catch(() => {});
  }
}

function setToggle(el, on) {
  if (!el) return;
  el.classList.toggle("on", on);
}

function setApiStatus(msg, color) {
  const el = document.getElementById("api-status");
  el.textContent = msg;
  const colors = { green: "#22a86a", orange: "#f59e0b", red: "#e05c7a", gray: "#9a7fa0" };
  el.style.color = colors[color] || colors.gray;
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}
