/**
 * SafeSpace AI — Content Script
 * Scans visible text on web pages, sends to background for analysis,
 * and blurs/masks detected harmful content.
 */

(function () {
  "use strict";

  // ─── Guard: prevent double-injection ────────────────────────────────────────
  if (window.__safespaceInitialized) return;
  window.__safespaceInitialized = true;

  // ─── State ───────────────────────────────────────────────────────────────────
  let settings = {
    enabled: true,
    sensitivityThreshold: 0.7,
    filters: {},
    blurStrength: "medium",
    evidenceMode: false,
    notificationsEnabled: true,
  };

  // FIX: Use a regular Set (clearable) keyed by a stable node identifier
  // We mark processed nodes with a data attribute so we can reset easily.
  const PROCESSED_ATTR = "data-ss-processed";

  const pendingQueue  = [];
  let debounceTimer   = null;
  let notificationCooldown = false;

  // ─── Selectors: meaningful content containers ────────────────────────────────
  const CONTENT_SELECTORS = [
    "[class*='comment']", "[class*='reply']", "[class*='post']",
    "[class*='tweet']", "[class*='message']", "[class*='review']",
    "[class*='feedback']", "[class*='discussion']",
    "p", "li", "blockquote", "article",
    "[data-testid*='tweet']", "[data-testid*='comment']",
    ".comment-body", ".message-text", ".post-content",
    "[class*='bubble']", "[class*='chat']",
  ].join(",");

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE"]);

  const BLUR_MAP = { light: "4px", medium: "8px", heavy: "14px" };

  // ─── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    settings = await sendMessage({ type: "GET_SETTINGS" });
    if (!settings.enabled) return;
    scanPage();
    setupMutationObserver();
    setupMessageListener();
  }

  // ─── DOM Scanning ─────────────────────────────────────────────────────────────

  function scanPage() {
    const nodes = document.querySelectorAll(CONTENT_SELECTORS);
    nodes.forEach(queueNode);
    flushQueue();
  }

  function queueNode(node) {
    if (!node) return;
    if (SKIP_TAGS.has(node.tagName)) return;
    if (node.hasAttribute(PROCESSED_ATTR)) return;      // FIX: attr-based check, clearable
    if (node.hasAttribute("data-safespace")) return;    // already wrapped

    const text = extractText(node);
    if (!text || text.length < 15) return;

    node.setAttribute(PROCESSED_ATTR, "1");             // mark immediately to avoid dups
    pendingQueue.push({ node, text });
  }

  function extractText(node) {
    return node.innerText?.trim().replace(/\s+/g, " ") || "";
  }

  // ─── Debounced Queue Flush ────────────────────────────────────────────────────

  function scheduleFlush() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushQueue, 500);
  }

  async function flushQueue() {
    if (!settings.enabled || pendingQueue.length === 0) return;

    const batch = pendingQueue.splice(0, 10);
    const texts = batch.map((item) => item.text);

    // FIX: Report scanned count to background so stats are accurate
    sendMessage({ type: "RECORD_SCANNED", payload: { count: texts.length } });

    try {
      const results = await sendMessage({
        type: "ANALYZE_TEXT",
        payload: { texts },
      });

      if (results?.error === "NO_API_KEY") {
        showFloatingAlert("⚙️ Add your Perspective API key in SafeSpace settings.", "info");
        return;
      }

      if (results?.skipped) return;

      if (Array.isArray(results)) {
        results.forEach((result, i) => {
          if (result && !result.error && !result.skipped) {
            handleAnalysisResult(batch[i].node, batch[i].text, result);
          }
        });
      }
    } catch (err) {
      console.warn("[SafeSpace AI] Analysis error:", err);
    }

    if (pendingQueue.length > 0) {
      setTimeout(flushQueue, 1000);
    }
  }

  // ─── Result Handling ──────────────────────────────────────────────────────────

  function handleAnalysisResult(node, text, result) {
    const { maxScore, dominantCategory, scores } = result;
    if (typeof maxScore !== "number") return;

    if (maxScore >= settings.sensitivityThreshold) {
      applyBlur(node, maxScore, dominantCategory, scores, text);

      sendMessage({
        type: "RECORD_DETECTION",
        payload: { category: dominantCategory, score: maxScore, url: window.location.href },
      });

      if (settings.notificationsEnabled && !notificationCooldown) {
        showFloatingAlert(
          `🛡️ Harmful content detected (${Math.round(maxScore * 100)}% confidence)`,
          "warning"
        );
        notificationCooldown = true;
        setTimeout(() => (notificationCooldown = false), 5000);
      }
    }
  }

  // ─── Blur / Mask ──────────────────────────────────────────────────────────────

  function applyBlur(node, score, category, scores, originalText) {
    if (node.dataset.safespaceBlurred) return;

    const blurAmount   = BLUR_MAP[settings.blurStrength] || BLUR_MAP.medium;
    const severityLabel = getSeverityLabel(score);
    const categoryLabel = getCategoryLabel(category);
    const severityClass = getSeverityClass(score);

    node.dataset.safespaceBlurred = "true";
    node.dataset.safespaceScore   = score;

    // Wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "safespace-blur-wrapper";
    wrapper.setAttribute("data-safespace", "true");

    // Blur layer
    const blurLayer = document.createElement("div");
    blurLayer.className = "safespace-blur-layer";
    blurLayer.style.setProperty("--ss-blur", blurAmount);

    // Warning badge
    const badge = document.createElement("div");
    badge.className = `safespace-badge safespace-badge--${severityClass}`;
    badge.setAttribute("role", "alert");
    badge.setAttribute("aria-label", `${categoryLabel} detected — ${severityLabel} severity at ${Math.round(score * 100)}%`);

    // Reveal button — keyboard accessible
    const revealBtn = document.createElement("button");
    revealBtn.className = "safespace-reveal-btn";
    revealBtn.type = "button";
    revealBtn.textContent = "Show";
    revealBtn.title = "Click to reveal hidden content";
    revealBtn.setAttribute("aria-expanded", "false");

    const badgeIcon = document.createElement("span");
    badgeIcon.className = "safespace-badge-icon";
    badgeIcon.setAttribute("aria-hidden", "true");
    badgeIcon.textContent = getSeverityIcon(score);

    const badgeText = document.createElement("span");
    badgeText.className = "safespace-badge-text";
    badgeText.innerHTML = `<strong>${categoryLabel}</strong><small>${severityLabel} · ${Math.round(score * 100)}%</small>`;

    badge.appendChild(badgeIcon);
    badge.appendChild(badgeText);
    badge.appendChild(revealBtn);

    // Inject into DOM
    node.parentNode?.insertBefore(wrapper, node);
    wrapper.appendChild(blurLayer);
    blurLayer.appendChild(node);
    wrapper.appendChild(badge);

    // Reveal interactions — both click on wrapper and explicit button
    revealBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleReveal(wrapper, blurLayer, badge, revealBtn);
    });

    // Clicking the blurred area also reveals
    wrapper.addEventListener("click", () => {
      if (wrapper.dataset.revealed !== "true") {
        toggleReveal(wrapper, blurLayer, badge, revealBtn);
      }
    });

    // Evidence capture
    if (settings.evidenceMode) {
      addEvidenceButton(wrapper, originalText, scores);
    }
  }

  function toggleReveal(wrapper, blurLayer, badge, revealBtn) {
    const isRevealed = wrapper.dataset.revealed === "true";
    wrapper.dataset.revealed = String(!isRevealed);
    blurLayer.classList.toggle("safespace-blur-layer--revealed", !isRevealed);
    badge.classList.toggle("safespace-badge--revealed", !isRevealed);
    revealBtn.textContent = isRevealed ? "Show" : "Hide";
    revealBtn.setAttribute("aria-expanded", String(!isRevealed));
  }

  function addEvidenceButton(wrapper, text, scores) {
    const evBtn = document.createElement("button");
    evBtn.className = "safespace-evidence-btn";
    evBtn.type = "button";
    evBtn.textContent = "📋 Capture";
    evBtn.title = "Capture as evidence for reporting";
    evBtn.setAttribute("aria-label", "Capture this content as evidence for reporting");
    evBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sendMessage({
        type: "CAPTURE_EVIDENCE",
        payload: { text, scores, url: window.location.href, timestamp: Date.now() },
      });
      evBtn.textContent = "✅ Saved";
      evBtn.disabled = true;
      evBtn.setAttribute("aria-label", "Evidence captured and saved");
    });
    wrapper.appendChild(evBtn);
  }

  // ─── Mutation Observer ────────────────────────────────────────────────────────

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!settings.enabled) return;

      let hasNew = false;
      mutations.forEach(({ addedNodes }) => {
        addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          hasNew = true;
          if (node.matches?.(CONTENT_SELECTORS)) queueNode(node);
          node.querySelectorAll?.(CONTENT_SELECTORS).forEach(queueNode);
        });
      });

      if (hasNew) scheduleFlush();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Floating Notification ────────────────────────────────────────────────────

  function showFloatingAlert(message, type = "warning") {
    const existing = document.querySelector(".safespace-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `safespace-toast safespace-toast--${type}`;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");

    const msgSpan = document.createElement("span");
    msgSpan.textContent = message;

    const closeBtn = document.createElement("button");
    closeBtn.className = "safespace-toast-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Dismiss notification");
    closeBtn.addEventListener("click", () => toast.remove());

    toast.appendChild(msgSpan);
    toast.appendChild(closeBtn);
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("safespace-toast--visible"));
    setTimeout(() => {
      toast.classList.remove("safespace-toast--visible");
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  // ─── Message Listener ─────────────────────────────────────────────────────────

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "SETTINGS_UPDATED") {
        settings = message.payload;
        if (!settings.enabled) removeAllBlurs();
      }

      // FIX: RESCAN_PAGE now properly clears processed markers
      if (message.type === "RESCAN_PAGE") {
        document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
          el.removeAttribute(PROCESSED_ATTR);
        });
        removeAllBlurs();
        scanPage();
      }
    });
  }

  function removeAllBlurs() {
    document.querySelectorAll("[data-safespace='true']").forEach((wrapper) => {
      const inner = wrapper.querySelector(".safespace-blur-layer");
      if (inner?.firstChild) {
        wrapper.parentNode?.insertBefore(inner.firstChild, wrapper);
      }
      wrapper.remove();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function getSeverityLabel(score) {
    if (score >= 0.9)  return "Severe";
    if (score >= 0.75) return "High";
    if (score >= 0.5)  return "Moderate";
    return "Low";
  }

  function getSeverityClass(score) {
    if (score >= 0.9)  return "severe";
    if (score >= 0.75) return "high";
    return "moderate";
  }

  function getSeverityIcon(score) {
    if (score >= 0.9)  return "🚨";
    if (score >= 0.75) return "⚠️";
    return "🔔";
  }

  function getCategoryLabel(category) {
    const map = {
      toxicity:          "Toxic Content",
      severe_toxicity:   "Severely Toxic",
      threat:            "Threatening Language",
      insult:            "Insult Detected",
      identity_attack:   "Hate Speech",
      sexually_explicit: "Explicit Content",
    };
    return map[category] || "Harmful Content";
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  init();
})();