/**
 * SafeSpace AI — Shared Utilities
 * Used by background.js (imported as ES module via type:module service worker).
 * Content scripts cannot use ES module imports directly, so these utilities
 * are available here for background/popup and mirrored inline in content.js.
 */

export const Utils = {
  /**
   * Debounce: delays execution until after `wait` ms of inactivity.
   */
  debounce(fn, wait = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  },

  /**
   * Throttle: ensures fn is called at most once per `limit` ms.
   */
  throttle(fn, limit = 500) {
    let lastCall = 0;
    return (...args) => {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        fn(...args);
      }
    };
  },

  /**
   * Chunk an array into sub-arrays of size `n`.
   */
  chunk(arr, n) {
    const result = [];
    for (let i = 0; i < arr.length; i += n) result.push(arr.slice(i, i + n));
    return result;
  },

  /**
   * Safely extract visible text from a DOM node.
   */
  extractText(node) {
    if (!node || !node.innerText) return "";
    return node.innerText.trim().replace(/\s+/g, " ");
  },

  /**
   * Truncate a string with ellipsis.
   */
  truncate(str, maxLen = 100) {
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen) + "…";
  },

  /**
   * Format a timestamp as a relative time string.
   */
  timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 60_000)     return "just now";
    if (diff < 3_600_000)  return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  },

  /**
   * Generate a simple unique ID.
   */
  uid() {
    return `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  },

  /**
   * Get hostname safely from a URL string.
   */
  hostname(url) {
    try { return new URL(url).hostname; } catch { return "unknown"; }
  },
};
