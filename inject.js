// ============================================================
// Video Grabber Pro — Injected Page Script (MP4 + HLS)
// ============================================================

(function () {
  'use strict';

  if (window.__videoGrabberPageInjected) return;
  window.__videoGrabberPageInjected = true;

  const REPORTED = new Set();
  const VIDEO_REGEX = /\.(mp4|m4v|m3u8)(\?|#|$)/i; // MP4 files and HLS playlists
  const AUDIO_EXCLUDE = /\.(mp3|wav|ogg|aac|m4a|flac|wma)(\?|#|$)/i;

  function report(url) {
    if (!url || REPORTED.has(url)) return;
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (AUDIO_EXCLUDE.test(url)) return;
    if (!VIDEO_REGEX.test(url)) return;

    REPORTED.add(url);
    window.postMessage({
      type: 'VIDEO_GRABBER_DETECTED',
      url: url,
    }, '*');
  }

  // ── Hook XMLHttpRequest ────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vgUrl = url;
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      const url = this.__vgUrl;
      if (typeof url === 'string') {
        checkUrl(url);
      }
    });
    return origSend.apply(this, arguments);
  };

  // ── Hook fetch ─────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function () {
    const input = arguments[0];
    let url;
    if (typeof input === 'string') url = input;
    else if (input instanceof Request) url = input.url;
    else if (input instanceof URL) url = input.href;

    if (url) checkUrl(url);
    return origFetch.apply(this, arguments);
  };

  function checkUrl(url) {
    if (typeof url !== 'string') return;
    try {
      const absUrl = new URL(url, window.location.href).href;
      if (VIDEO_REGEX.test(absUrl) && !AUDIO_EXCLUDE.test(absUrl)) {
        report(absUrl);
      }
    } catch { /* skip */ }
  }

  // ── Hook HTMLMediaElement src ──────────────────────────────
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDescriptor && srcDescriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set(val) {
        if (val) {
          try {
            const abs = new URL(val, window.location.href).href;
            if (VIDEO_REGEX.test(abs) && !AUDIO_EXCLUDE.test(abs)) {
              report(abs);
            }
          } catch { /* skip */ }
        }
        return srcDescriptor.set.call(this, val);
      },
      get() {
        return srcDescriptor.get.call(this);
      },
      configurable: true,
    });
  }

  // ── FORCE PROVOKE (動画の通信を誘発) ─────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'FORCE_PROVOKE_DETECTION') {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        const origMuted = v.muted;
        v.muted = true;
        const p = v.play();
        if (p !== undefined) {
          p.then(() => setTimeout(() => { v.pause(); v.muted = origMuted; }, 100))
           .catch(() => { v.muted = origMuted; });
        }
      });
    }
  });

})();
