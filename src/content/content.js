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

  const processedNodes = new WeakSet();
  const pendingQueue = [];
  let debounceTimer = null;
  let notificationCooldown = false;
  let totalScannedThisPage = 0;

  // ─── Selectors: Target meaningful content containers ────────────────────────
  const CONTENT_SELECTORS = [
    // Comments & posts
    "[class*='comment']", "[class*='reply']", "[class*='post']",
    "[class*='tweet']", "[class*='message']", "[class*='review']",
    "[class*='feedback']", "[class*='discussion']",
    // Generic text containers
    "p", "li", "blockquote", "article",
    // Social-specific
    "[data-testid*='tweet']", "[data-testid*='comment']",
    ".comment-body", ".message-text", ".post-content",
    // DMs
    "[class*='bubble']", "[class*='chat']",
  ].join(",");

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE"]);

  // Blur strength map
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
    if (!node || processedNodes.has(node)) return;
    if (SKIP_TAGS.has(node.tagName)) return;

    const text = extractText(node);
    if (!text || text.length < 15) return;

    processedNodes.add(node);
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

    // Take up to 10 items per batch to avoid rate limits
    const batch = pendingQueue.splice(0, 10);
    const texts = batch.map((item) => item.text);

    totalScannedThisPage += texts.length;

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

    // Continue flushing if more items
    if (pendingQueue.length > 0) {
      setTimeout(flushQueue, 1000); // Rate-limit batches
    }
  }

  // ─── Result Handling ──────────────────────────────────────────────────────────

  function handleAnalysisResult(node, text, result) {
    const { maxScore, dominantCategory, scores } = result;
    if (typeof maxScore !== "number") return;

    if (maxScore >= settings.sensitivityThreshold) {
      applyBlur(node, maxScore, dominantCategory, scores, text);

      // Record detection
      sendMessage({
        type: "RECORD_DETECTION",
        payload: {
          category: dominantCategory,
          score: maxScore,
          url: window.location.href,
        },
      });

      // Notification throttle
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

    const blurAmount = BLUR_MAP[settings.blurStrength] || BLUR_MAP.medium;
    const severityLabel = getSeverityLabel(score);
    const categoryLabel = getCategoryLabel(category);

    // Wrap node content
    node.dataset.safespaceBlurred = "true";
    node.dataset.safespaceScore = score;

    // Create overlay wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "safespace-blur-wrapper";
    wrapper.setAttribute("data-safespace", "true");

    // Blur overlay
    const blurLayer = document.createElement("div");
    blurLayer.className = "safespace-blur-layer";
    blurLayer.style.setProperty("--ss-blur", blurAmount);

    // Warning badge
    const badge = document.createElement("div");
    badge.className = `safespace-badge safespace-badge--${getSeverityClass(score)}`;
    badge.innerHTML = `
      <span class="safespace-badge-icon">${getSeverityIcon(score)}</span>
      <span class="safespace-badge-text">
        <strong>${categoryLabel}</strong>
        <small>${severityLabel} · ${Math.round(score * 100)}%</small>
      </span>
      <button class="safespace-reveal-btn" title="Click to reveal content">
        Show
      </button>
    `;

    // Inject
    node.parentNode?.insertBefore(wrapper, node);
    wrapper.appendChild(blurLayer);
    blurLayer.appendChild(node);
    wrapper.appendChild(badge);

    // Reveal on click
    badge.querySelector(".safespace-reveal-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      revealContent(wrapper, blurLayer, badge);
    });

    wrapper.addEventListener("click", () => {
      if (wrapper.dataset.revealed !== "true") {
        revealContent(wrapper, blurLayer, badge);
      }
    });

    // Evidence capture
    if (settings.evidenceMode) {
      addEvidenceButton(wrapper, originalText, scores);
    }
  }

  function revealContent(wrapper, blurLayer, badge) {
    wrapper.dataset.revealed = "true";
    blurLayer.classList.add("safespace-blur-layer--revealed");
    badge.classList.add("safespace-badge--revealed");
    badge.querySelector(".safespace-reveal-btn").textContent = "Hide";

    badge.querySelector(".safespace-reveal-btn").onclick = (e) => {
      e.stopPropagation();
      wrapper.dataset.revealed = "false";
      blurLayer.classList.remove("safespace-blur-layer--revealed");
      badge.classList.remove("safespace-badge--revealed");
      badge.querySelector(".safespace-reveal-btn").textContent = "Show";
    };
  }

  function addEvidenceButton(wrapper, text, scores) {
    const evBtn = document.createElement("button");
    evBtn.className = "safespace-evidence-btn";
    evBtn.textContent = "📋 Capture";
    evBtn.title = "Capture as evidence for reporting";
    evBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sendMessage({
        type: "CAPTURE_EVIDENCE",
        payload: {
          text,
          scores,
          url: window.location.href,
          timestamp: Date.now(),
        },
      });
      evBtn.textContent = "✅ Saved";
      evBtn.disabled = true;
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

          // Check the node itself
          if (node.matches?.(CONTENT_SELECTORS)) queueNode(node);

          // Check descendants
          node.querySelectorAll?.(CONTENT_SELECTORS).forEach(queueNode);
        });
      });

      if (hasNew) scheduleFlush();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ─── Floating Notification ────────────────────────────────────────────────────

  function showFloatingAlert(message, type = "warning") {
    const existing = document.querySelector(".safespace-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `safespace-toast safespace-toast--${type}`;
    toast.innerHTML = `
      <span>${message}</span>
      <button class="safespace-toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add("safespace-toast--visible"));

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.remove("safespace-toast--visible");
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  // ─── Message Listener (from popup/background) ─────────────────────────────────

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "SETTINGS_UPDATED") {
        settings = message.payload;
        if (!settings.enabled) {
          removeAllBlurs();
        }
      }
      if (message.type === "RESCAN_PAGE") {
        processedNodes.forEach?.(() => {}); // Can't really clear WeakSet
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
    if (score >= 0.9) return "Severe";
    if (score >= 0.75) return "High";
    if (score >= 0.5) return "Moderate";
    return "Low";
  }

  function getSeverityClass(score) {
    if (score >= 0.9) return "severe";
    if (score >= 0.75) return "high";
    return "moderate";
  }

  function getSeverityIcon(score) {
    if (score >= 0.9) return "🚨";
    if (score >= 0.75) return "⚠️";
    return "🔔";
  }

  function getCategoryLabel(category) {
    const map = {
      toxicity: "Toxic Content",
      severe_toxicity: "Severely Toxic",
      threat: "Threatening Language",
      insult: "Insult Detected",
      identity_attack: "Hate Speech",
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
