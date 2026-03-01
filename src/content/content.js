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
    parentalLock: false, 
  };

  // FIX: Use a regular Set (clearable) keyed by a stable node identifier
  // We mark processed nodes with a data attribute so we can reset easily.
  const PROCESSED_ATTR = "data-ss-processed";

  const pendingQueue  = [];
  let debounceTimer   = null;
  let notificationCooldown = false;

  // ─── Parental Lock State ──────────────────────────────────────────────────────
  let pinDialog       = null;
  let pinCallback     = null;
  let pinCurrentInput = "";
  let pinAttempts     = 0;
  let pinLockoutEnd   = 0;

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

    // ── Inline PIN area (shown only when parental lock is on) ──────────────────
    const pinArea = document.createElement("div");
    pinArea.className = "safespace-pin-area";

    const pinInput = document.createElement("input");
    pinInput.className = "safespace-pin-input";
    pinInput.type = "password";
    pinInput.inputMode = "numeric";
    pinInput.maxLength = 4;
    pinInput.placeholder = "PIN";
    pinInput.autocomplete = "off";
    pinInput.setAttribute("aria-label", "Enter 4-digit parental PIN");

    const pinError = document.createElement("span");
    pinError.className = "safespace-pin-error";
    pinError.setAttribute("aria-live", "polite");

    pinArea.appendChild(pinInput);
    pinArea.appendChild(pinError);

    // Show/hide the PIN area based on current parental lock state
    pinArea.style.display = settings.parentalLock ? "flex" : "none";

    badge.appendChild(badgeIcon);
    badge.appendChild(badgeText);
    badge.appendChild(pinArea);
    badge.appendChild(revealBtn);

    // Inject into DOM
    node.parentNode?.insertBefore(wrapper, node);
    wrapper.appendChild(blurLayer);
    blurLayer.appendChild(node);
    wrapper.appendChild(badge);

    // Enforce digits-only in the PIN input
    pinInput.addEventListener("input", () => {
      pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
      pinError.textContent = "";
    });

    // Allow submitting PIN by pressing Enter in the input
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        revealBtn.click();
      }
    });

    // Prevent wrapper click from firing when interacting with the badge
    badge.addEventListener("click", (e) => e.stopPropagation());

    // Reveal button click
    revealBtn.addEventListener("click", async (e) => {
      e.stopPropagation();

      if (settings.parentalLock && wrapper.dataset.revealed !== "true") {
        // Validate inline PIN
        const enteredPin = pinInput.value.trim();
        if (enteredPin.length < 4) {
          pinError.textContent = "Enter 4-digit PIN";
          pinInput.focus();
          return;
        }
        const result = await sendMessage({
          type: "PARENTAL_VERIFY_PIN",
          payload: { pin: enteredPin },
        });
        if (result?.success) {
          pinInput.value = "";
          pinError.textContent = "";
          toggleReveal(wrapper, blurLayer, badge, revealBtn);
        } else {
          pinInput.value = "";
          pinError.textContent = "Incorrect PIN";
          pinInput.focus();
          // Shake the input to give visual feedback
          pinInput.classList.remove("safespace-pin-input--shake");
          void pinInput.offsetWidth; // force reflow
          pinInput.classList.add("safespace-pin-input--shake");
          setTimeout(() => pinInput.classList.remove("safespace-pin-input--shake"), 500);
        }
        return;
      }

      // No parental lock (or toggling back to hidden)
      toggleReveal(wrapper, blurLayer, badge, revealBtn);
    });

    // Clicking the blurred area only works when parental lock is OFF
    wrapper.addEventListener("click", () => {
      if (wrapper.dataset.revealed !== "true" && !settings.parentalLock) {
        toggleReveal(wrapper, blurLayer, badge, revealBtn);
      }
    });

    // Keep PIN area visibility in sync if settings change at runtime
    wrapper._updatePinVisibility = () => {
      pinArea.style.display = settings.parentalLock ? "flex" : "none";
      if (!settings.parentalLock) {
        pinInput.value = "";
        pinError.textContent = "";
      }
    };

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

  // ─── Parental Lock — Reveal Gate ──────────────────────────────────────────────

  /**
   * Gate for the reveal action. If parental lock is on, show PIN dialog first.
   * Otherwise reveal directly.
   */
  function handleRevealRequest(wrapper, blurLayer, badge, revealBtn) {
    if (settings.parentalLock) {
      showPinDialog((unlocked) => {
        if (unlocked) toggleReveal(wrapper, blurLayer, badge, revealBtn);
      });
    } else {
      toggleReveal(wrapper, blurLayer, badge, revealBtn);
    }
  }

  // ─── PIN Dialog ───────────────────────────────────────────────────────────────

  function buildPinDialog() {
    const overlay = document.createElement("div");
    overlay.id = "safespace-pin-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Parent PIN required");
    overlay.setAttribute("aria-hidden", "true");

    overlay.innerHTML = `
      <div id="ss-pin-card">
        <div id="ss-pin-icon">🔒</div>
        <h2 id="ss-pin-title">Parent Lock</h2>
        <p id="ss-pin-subtitle">Enter the parent PIN to reveal this content</p>
        <div id="ss-pin-dots" aria-label="PIN digits entered" role="status">
          <span class="ss-dot" data-index="0"></span>
          <span class="ss-dot" data-index="1"></span>
          <span class="ss-dot" data-index="2"></span>
          <span class="ss-dot" data-index="3"></span>
        </div>
        <p id="ss-pin-error" aria-live="assertive"></p>
        <div id="ss-pin-keypad" role="group" aria-label="PIN keypad">
          ${[1,2,3,4,5,6,7,8,9].map((n) =>
            `<button class="ss-key" data-key="${n}" type="button" aria-label="${n}">${n}</button>`
          ).join("")}
          <div class="ss-key-spacer"></div>
          <button class="ss-key" data-key="0" type="button" aria-label="0">0</button>
          <button class="ss-key ss-key-del" id="ss-key-del" type="button" aria-label="Delete last digit">⌫</button>
        </div>
        <button id="ss-pin-cancel" type="button">Cancel</button>
      </div>
    `;

    // Number key clicks
    overlay.querySelectorAll(".ss-key[data-key]").forEach((btn) => {
      if (btn.id !== "ss-key-del") {
        btn.addEventListener("click", () => handlePinKey(btn.dataset.key));
      }
    });
    overlay.querySelector("#ss-key-del").addEventListener("click", () => handlePinKey("del"));
    overlay.querySelector("#ss-pin-cancel").addEventListener("click", () => hidePinDialog(false));

    // Click backdrop to cancel
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hidePinDialog(false);
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function showPinDialog(callback) {
    if (!pinDialog) pinDialog = buildPinDialog();

    pinCallback     = callback;
    pinCurrentInput = "";
    updatePinDots();
    setPinError("");

    // If still in lockout period, show remaining time and disable keypad
    if (Date.now() < pinLockoutEnd) {
      disablePinKeypad(true);
      startLockoutCountdown();
    } else {
      disablePinKeypad(false);
    }

    pinDialog.setAttribute("aria-hidden", "false");
    pinDialog.style.display = "flex";
    requestAnimationFrame(() => pinDialog.classList.add("ss-visible"));
  }

  function hidePinDialog(success) {
    if (!pinDialog) return;
    pinDialog.classList.remove("ss-visible");
    setTimeout(() => {
      if (pinDialog) {
        pinDialog.style.display = "none";
        pinDialog.setAttribute("aria-hidden", "true");
      }
    }, 300);
    if (pinCallback) {
      const cb = pinCallback;
      pinCallback = null;
      cb(!!success);
    }
  }

  function handlePinKey(key) {
    if (Date.now() < pinLockoutEnd) return;

    if (key === "del") {
      pinCurrentInput = pinCurrentInput.slice(0, -1);
      updatePinDots();
      return;
    }

    if (pinCurrentInput.length >= 4) return;
    pinCurrentInput += key;
    updatePinDots();

    // Auto-submit when 4 digits are entered
    if (pinCurrentInput.length === 4) {
      setTimeout(submitPin, 150); // small delay so the last dot is visible
    }
  }

  async function submitPin() {
    const result = await sendMessage({
      type: "PARENTAL_VERIFY_PIN",
      payload: { pin: pinCurrentInput },
    });

    if (result?.success) {
      // Correct — reset attempts and reveal
      pinAttempts = 0;
      pinLockoutEnd = 0;
      hidePinDialog(true);
    } else {
      // Wrong PIN
      pinAttempts++;
      pinCurrentInput = "";
      updatePinDots();
      shakeDots();

      if (pinAttempts >= 3) {
        pinLockoutEnd = Date.now() + 30_000;
        pinAttempts   = 0;
        disablePinKeypad(true);
        startLockoutCountdown();
      } else {
        const left = 3 - pinAttempts;
        setPinError(`Incorrect PIN — ${left} attempt${left !== 1 ? "s" : ""} left`);
      }
    }
  }

  function updatePinDots() {
    if (!pinDialog) return;
    pinDialog.querySelectorAll(".ss-dot").forEach((dot, i) => {
      dot.classList.toggle("ss-dot-filled", i < pinCurrentInput.length);
    });
  }

  function setPinError(msg) {
    if (!pinDialog) return;
    const el = pinDialog.querySelector("#ss-pin-error");
    el.textContent = msg;
    el.style.opacity = msg ? "1" : "0";
  }

  function shakeDots() {
    if (!pinDialog) return;
    const dots = pinDialog.querySelector("#ss-pin-dots");
    dots.classList.remove("ss-shake");
    // Force reflow so the animation restarts if it's already running
    void dots.offsetWidth;
    dots.classList.add("ss-shake");
    setTimeout(() => dots.classList.remove("ss-shake"), 500);
  }

  function disablePinKeypad(disabled) {
    if (!pinDialog) return;
    pinDialog.querySelectorAll(".ss-key").forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  function startLockoutCountdown() {
    const tick = () => {
      const remaining = Math.ceil((pinLockoutEnd - Date.now()) / 1000);
      if (remaining <= 0) {
        setPinError("");
        disablePinKeypad(false);
        return;
      }
      setPinError(`Too many attempts — try again in ${remaining}s`);
      setTimeout(tick, 1000);
    };
    tick();
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
        if (!settings.enabled) {
          removeAllBlurs();
        } else {
          // Sync inline PIN area visibility on all existing blurred wrappers
          document.querySelectorAll("[data-safespace='true']").forEach((w) => {
            if (typeof w._updatePinVisibility === "function") w._updatePinVisibility();
          });
        }
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
    if (score >= 0.3)  return "Moderate";
    return "Low";
  }

  function getSeverityClass(score) {
    if (score >= 0.9)  return "severe";
    if (score >= 0.75) return "high";
    return "moderate";
  }

  function getSeverityIcon(score) {
    if (score >= 0.9)  return "🚨";
    if (score >= 0.25) return "⚠️";
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