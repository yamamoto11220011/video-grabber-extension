// ============================================================
// Video Grabber Pro — Content Script (MP4 + HLS)
// ============================================================

(function () {
  'use strict';

  if (window.__videoGrabberInjected) return;
  window.__videoGrabberInjected = true;

  const DETECTED = new Set();
  const VIDEO_REGEX = /\.(mp4|m4v|m3u8)(\?|#|$)/i; // MP4 files and HLS playlists
  const AUDIO_EXCLUDE = /\.(mp3|wav|ogg|aac|m4a|flac|wma)(\?|#|$)/i;

  function reportVideo(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
    if (AUDIO_EXCLUDE.test(url)) return;
    if (!VIDEO_REGEX.test(url)) return;
    if (DETECTED.has(url)) return;
    DETECTED.add(url);

    chrome.runtime.sendMessage({
      action: 'addVideo',
      video: {
        url,
        type: /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : 'video/mp4',
        title: document.title || '',
      },
    });
  }

  // ── DOM Scan: <video> tags only (no <audio>) ───────────────
  function scanDOM(root = document) {
    root.querySelectorAll('video').forEach((el) => {
      if (el.src) reportVideo(el.src);
      if (el.currentSrc) reportVideo(el.currentSrc);
      el.querySelectorAll('source').forEach((s) => {
        if (s.src) reportVideo(s.src);
      });
    });

    root.querySelectorAll('source').forEach((s) => {
      if (s.type === 'video/mp4' || VIDEO_REGEX.test(s.src || '')) {
        reportVideo(s.src);
      }
    });

    // og:video
    root.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').forEach((m) => {
      if (m.content) reportVideo(m.content);
    });
  }

  // ── Force Detection ────────────────────────────────────────
  function runForceDetection() {
    window.postMessage({ type: 'FORCE_PROVOKE_DETECTION' }, '*');

    // Search inside <script> tags for mp4 URLs
    const scripts = document.querySelectorAll('script');
    const regex = /(https?:\/\/[^\s"'<>\\]+?\.(mp4|m4v|m3u8)(\?[^\s"'<>\\]*)?)/gi;
    scripts.forEach((s) => {
      const text = s.textContent;
      if (!text || text.length > 2000000) return;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const cleanUrl = match[1].replace(/\\\//g, '/');
        reportVideo(cleanUrl);
      }
    });

    scanDOM();
  }

  // ── MutationObserver ───────────────────────────────────────
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Players often reuse one <video> and just swap its src
      if (m.type === 'attributes') {
        if (m.target.src) reportVideo(m.target.src);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO') {
          if (node.src) reportVideo(node.src);
          if (node.currentSrc) reportVideo(node.currentSrc);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('video').forEach((el) => {
            const src = el.src || el.currentSrc;
            if (src) reportVideo(src);
          });
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // inject.js runs in the page's MAIN world at document_start (see manifest)
  // and reports what it hooks via postMessage.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'VIDEO_GRABBER_DETECTED') {
      reportVideo(event.data.url);
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'forceDetect') {
      runForceDetection();
      sendResponse({ ok: true });
      return true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scanDOM());
  } else {
    scanDOM();
  }

  setInterval(scanDOM, 3000);
})();
