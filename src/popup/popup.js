/**
 * SafeSpace AI — Popup Control Panel
 * Manages all UI interactions, settings, and stats display.
 */

// ─── Filter Definitions ──────────────────────────────────────────────────────

const FILTER_DEFS = [
  { key: "toxicity",         label: "General Toxicity",   icon: "", desc: "Rude, disrespectful language" },
  { key: "severeToxicity",   label: "Severe Toxicity",    icon: "", desc: "Extremely harsh content" },
  { key: "threat",           label: "Threats & Violence", icon: "", desc: "Threatening or violent language" },
  { key: "insult",           label: "Insults",            icon: "", desc: "Personal attacks and put-downs" },
  { key: "identityAttack",   label: "Hate Speech",        icon: "", desc: "Attacks on identity groups" },
  { key: "sexuallyExplicit", label: "Explicit Content",   icon: "", desc: "Sexually explicit material" },
];

const PROFILES = {
  gentle:   { threshold: 0.85, filters: { toxicity: false,  severeToxicity: true,  threat: true,  insult: false, identityAttack: false,  sexuallyExplicit: false } },
  balanced: { threshold: 0.70, filters: { toxicity: false,  severeToxicity: true,  threat: true,  insult: false,  identityAttack: true,  sexuallyExplicit: true } },
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
  const toggle = document.getElementById("master-toggle");
  setToggle(toggle, settings.enabled);
  document.getElementById("toggle-text").textContent = settings.enabled ? "ON" : "OFF";
  document.getElementById("status-label").textContent = settings.enabled ? "Protection active" : "Protection paused";

  document.getElementById("hdr-blocked").textContent = stats.totalBlocked || 0;
  document.getElementById("hdr-scanned").textContent = stats.totalScanned || 0;
  document.getElementById("hdr-sessions").textContent = stats.sessionsProtected || 0;
}

function renderProtectTab() {
  const slider = document.getElementById("sensitivity-slider");
  const val = Math.round((settings.sensitivityThreshold || 0.7) * 100);
  slider.value = val;
  slider.style.setProperty("--val", val + "%");
  slider.setAttribute("aria-valuenow", val);
  document.getElementById("threshold-display").textContent = val + "%";

  // Blur pills
  document.querySelectorAll(".blur-pill").forEach((pill) => {
    const active = pill.dataset.blur === (settings.blurStrength || "medium");
    pill.classList.toggle("active", active);
    pill.setAttribute("aria-pressed", String(active));
  });

  setToggle(document.getElementById("notif-toggle"), settings.notificationsEnabled !== false);
  setToggle(document.getElementById("evidence-toggle"), !!settings.evidenceMode);

  if (settings.apiKey) {
    document.getElementById("api-key-input").value = settings.apiKey;
    setApiStatus("✅ API key configured", "green");
  }
}

function renderStatsTab() {
  document.getElementById("stat-blocked-big").textContent = stats.totalBlocked || 0;
  document.getElementById("stat-sessions-big").textContent = stats.sessionsProtected || 0;

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
          <div role="listitem">
            <div class="flex justify-between mb-1" style="font-size:11px">
              <span style="color:var(--text)">${catLabels[cat] || cat}</span>
              <span style="color:var(--muted)">${count} (${pct}%)</span>
            </div>
            <div style="height:6px;background:#f0e4f0;border-radius:3px;overflow:hidden"
                 role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
                 aria-label="${catLabels[cat] || cat}: ${pct}%">
              <div class="cat-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>`;
      }).join("");
  }

  const evContainer = document.getElementById("recent-events");
  const events = (stats.recentEvents || []).slice(0, 8);
  if (events.length === 0) {
    evContainer.innerHTML = `<p style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0">No events yet</p>`;
  } else {
    evContainer.innerHTML = events.map((ev) => `
      <div role="listitem" style="display:flex;align-items:center;justify-content:space-between;
           padding:6px 0;border-bottom:1px solid #f5eef5;font-size:11px">
        <div style="display:flex;align-items:center;gap:6px">
          <span aria-hidden="true">${ev.score >= 90 ? "🚨" : ev.score >= 75 ? "⚠️" : "🔔"}</span>
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
      <input type="checkbox" data-filter="${key}" ${settings.filters?.[key] ? "checked" : ""}
             aria-label="${label}: ${desc}" />
      <span style="font-size:16px" aria-hidden="true">${icon}</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${label}</div>
        <div style="font-size:11px;color:var(--muted)">${desc}</div>
      </div>
    </label>
  `).join("");

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
    <div class="evidence-item" role="listitem">
      <p>${ev.text.substring(0, 120)}${ev.text.length > 120 ? "…" : ""}</p>
      <div style="display:flex;justify-content:space-between;margin-top:4px">
        <small>${new URL(ev.url).hostname}</small>
        <small><time datetime="${new Date(ev.timestamp).toISOString()}">${new Date(ev.timestamp).toLocaleDateString()}</time></small>
      </div>
    </div>
  `).join("");
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // ── Tabs ──────────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", switchTab);
    // Keyboard: arrow keys for tab navigation
    btn.addEventListener("keydown", (e) => {
      const tabs = [...document.querySelectorAll(".tab-btn")];
      const idx = tabs.indexOf(btn);
      if (e.key === "ArrowRight") { e.preventDefault(); tabs[(idx + 1) % tabs.length].focus(); tabs[(idx + 1) % tabs.length].click(); }
      if (e.key === "ArrowLeft")  { e.preventDefault(); tabs[(idx - 1 + tabs.length) % tabs.length].focus(); tabs[(idx - 1 + tabs.length) % tabs.length].click(); }
    });
  });

  function switchTab(e) {
    const btn = e.currentTarget;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add("active");
    if (btn.dataset.tab === "evidence") renderEvidenceTab();
    if (btn.dataset.tab === "stats") {
      sendMessage({ type: "GET_STATS" }).then((s) => { stats = s; renderStatsTab(); });
    }
  }

  // ── Master toggle ──────────────────────────────────────────────────────────
  const masterToggle = document.getElementById("master-toggle");
  masterToggle.addEventListener("click", toggleMaster);
  masterToggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleMaster(); }
  });

  async function toggleMaster() {
    settings.enabled = !settings.enabled;
    setToggle(masterToggle, settings.enabled);
    document.getElementById("toggle-text").textContent = settings.enabled ? "ON" : "OFF";
    document.getElementById("status-label").textContent = settings.enabled ? "Protection active" : "Protection paused";
    await saveSettings();
    broadcastSettings();
  }

  // ── Sensitivity slider ─────────────────────────────────────────────────────
  const slider = document.getElementById("sensitivity-slider");
  slider.addEventListener("input", () => {
    const val = slider.value;
    slider.style.setProperty("--val", val + "%");
    slider.setAttribute("aria-valuenow", val);
    document.getElementById("threshold-display").textContent = val + "%";
    settings.sensitivityThreshold = val / 100;
    debounceSave();
  });

  // ── Blur pills ─────────────────────────────────────────────────────────────
  document.querySelectorAll(".blur-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".blur-pill").forEach((p) => {
        p.classList.remove("active");
        p.setAttribute("aria-pressed", "false");
      });
      pill.classList.add("active");
      pill.setAttribute("aria-pressed", "true");
      settings.blurStrength = pill.dataset.blur;
      saveSettings();
    });
  });

  // ── Notif toggle ───────────────────────────────────────────────────────────
  const notifToggle = document.getElementById("notif-toggle");
  notifToggle.addEventListener("click", () => toggleSwitch(notifToggle, (v) => { settings.notificationsEnabled = v; saveSettings(); }));
  notifToggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSwitch(notifToggle, (v) => { settings.notificationsEnabled = v; saveSettings(); }); }
  });

  // ── Evidence toggle ────────────────────────────────────────────────────────
  const evidenceToggle = document.getElementById("evidence-toggle");
  evidenceToggle.addEventListener("click", () => toggleSwitch(evidenceToggle, (v) => { settings.evidenceMode = v; saveSettings(); broadcastSettings(); }));
  evidenceToggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSwitch(evidenceToggle, (v) => { settings.evidenceMode = v; saveSettings(); broadcastSettings(); }); }
  });

  // ── API Key ────────────────────────────────────────────────────────────────
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
      setApiStatus(`✅ API working!`, "green");
    } else if (result?.[0]?.error) {
      setApiStatus(`❌ Error: ${result[0].error}`, "red");
    } else {
      setApiStatus("❌ Connection failed", "red");
    }
  });

  // ── Profile buttons ────────────────────────────────────────────────────────
  document.querySelectorAll("[data-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const profile = PROFILES[btn.dataset.profile];
      if (!profile) return;
      settings.sensitivityThreshold = profile.threshold;
      settings.filters = { ...profile.filters };
      saveSettings().then(() => { renderAll(); broadcastSettings(); });
    });
  });

  // ── Clear stats ────────────────────────────────────────────────────────────
  document.getElementById("clear-stats-btn").addEventListener("click", async () => {
    await sendMessage({ type: "CLEAR_STATS" });
    stats = { totalBlocked: 0, totalScanned: 0, sessionsProtected: 0, byCategory: {}, recentEvents: [] };
    renderHeader();
    renderStatsTab();
  });

  // ── Export evidence ────────────────────────────────────────────────────────
  document.getElementById("export-evidence-btn").addEventListener("click", async () => {
    const data = await chrome.storage.local.get("safespace_evidence");
    const evidence = data.safespace_evidence || [];
    if (evidence.length === 0) { alert("No evidence to export."); return; }
    const json = JSON.stringify(evidence, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `safespace-evidence-${Date.now()}.json`;
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

/**
 * Toggle a switch element and call the callback with the new boolean value.
 */
function toggleSwitch(el, callback) {
  const newVal = !el.classList.contains("on");
  setToggle(el, newVal);
  callback(newVal);
}

/**
 * Set the visual + ARIA state of a toggle switch element.
 */
function setToggle(el, on) {
  if (!el) return;
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", String(on));
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
  if (diff < 60000)    return "just now";
  if (diff < 3600000)  return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}