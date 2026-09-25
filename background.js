// ============================================================
// Video Grabber Pro — Background Service Worker (MP4 + HLS)
// ============================================================
// Detects MP4 files and HLS (m3u8) streams.
// Excludes audio files (mp3, wav, ...). HLS jobs run in offscreen.js.
// ============================================================

import { parseMasterPlaylist, parseRenditionUris } from './hls-engine.js';

const tabVideos = new Map(); // tabId → Map<url, VideoInfo>
const hlsChildren = new Map(); // tabId → Set<url> of variant/rendition playlists already covered by a master
const hlsJobs = new Map(); // jobId → { url, filename, status, percent, message, downloadId }

// MV3 service workers are stopped after ~30s idle, which wipes in-memory state.
// Mirror the state into storage.session so it survives until the browser closes.
const ready = chrome.storage.session.get(['tabVideos', 'hlsChildren', 'hlsJobs']).then(async (data) => {
  for (const [tabId, videos] of Object.entries(data.tabVideos || {})) {
    tabVideos.set(Number(tabId), new Map(videos.map((v) => [v.url.split('?')[0], v])));
  }
  for (const [tabId, urls] of Object.entries(data.hlsChildren || {})) {
    hlsChildren.set(Number(tabId), new Set(urls));
  }
  for (const [jobId, job] of Object.entries(data.hlsJobs || {})) hlsJobs.set(jobId, job);
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  nextRuleId = Math.max(0, ...rules.map((r) => r.id)) + 1;
});

// ── Referer rules ────────────────────────────────────────────
// Many video CDNs (e.g. Hotmart/Akamai) answer 403 unless the request carries the
// player page as Referer. The extension's own fetches/downloads send none, so while
// we fetch a stream we add a session rule that sets Referer/Origin on requests that
// don't belong to any tab (= ours) and go to that stream's domain.
let nextRuleId = 1;

// "vod.play.example.com" → "example.com", "a.example.co.jp" → "example.co.jp"
function baseDomain(host) {
  const p = host.split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return host;
  const n = p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? 3 : 2;
  return p.slice(-n).join('.');
}

async function addRefererRule(url, referer, { wholeSite = false } = {}) {
  if (!referer) return null;
  let host, origin;
  try {
    host = new URL(url).hostname;
    origin = new URL(referer).origin;
  } catch { return null; }
  const id = nextRuleId++;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: referer },
          { header: 'origin', operation: 'set', value: origin },
        ],
      },
      condition: {
        tabIds: [chrome.tabs.TAB_ID_NONE],
        // HLS keys/segments often live on sibling hosts (vod-akm.*, contentplayer.*)
        requestDomains: [wholeSite ? baseDomain(host) : host],
      },
    }],
  });
  return id;
}

function removeRule(id) {
  if (id) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

// Referer a browser would send for a request made by this origin/frame URL
// (cross-origin requests only carry the origin by default).
function refererFrom(originOrUrl) {
  try { return new URL(originOrUrl).origin + '/'; } catch { return ''; }
}

function findVideo(url) {
  for (const map of tabVideos.values()) {
    for (const v of map.values()) if (v.url === url) return v;
  }
  return null;
}

function persist() {
  const videos = {};
  for (const [tabId, map] of tabVideos) videos[tabId] = Array.from(map.values());
  const children = {};
  for (const [tabId, set] of hlsChildren) children[tabId] = Array.from(set);
  chrome.storage.session.set({ tabVideos: videos, hlsChildren: children, hlsJobs: Object.fromEntries(hlsJobs) });
}

// Only true MP4 files
const MP4_EXTENSION = /\.(mp4|m4v)(\?|#|$)/i;
const MP4_CONTENT_TYPE = /^video\/mp4/i;
const HLS_EXTENSION = /\.m3u8(\?|#|$)/i;
const HLS_CONTENT_TYPE = /mpegurl/i;

// Exclude audio extensions explicitly
const AUDIO_EXCLUDE = /\.(mp3|wav|ogg|aac|m4a|flac|wma)(\?|#|$)/i;

function updateBadge(tabId) {
  const videos = tabVideos.get(tabId);
  const count = videos ? videos.size : 0;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#6C5CE7' : '#999', tabId }).catch(() => {});
}

function clearTab(tabId) {
  tabVideos.delete(tabId);
  hlsChildren.delete(tabId);
  persist();
}

function safeName(name) {
  return (name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function addVideo(tabId, info) {
  await ready;
  if (!info.url) return;
  // Ignore audio files
  if (AUDIO_EXCLUDE.test(info.url)) return;
  if (HLS_EXTENSION.test(info.url) || HLS_CONTENT_TYPE.test(info.type || '')) {
    return addHls(tabId, info.url, info.referer);
  }
  // Must be MP4
  if (!MP4_EXTENSION.test(info.url) && !MP4_CONTENT_TYPE.test(info.type || '')) return;

  if (!tabVideos.has(tabId)) tabVideos.set(tabId, new Map());
  const map = tabVideos.get(tabId);

  const key = info.url.split('?')[0];
  const existing = map.get(key);
  if (existing) {
    // A later request (e.g. from webRequest) may know the size the DOM scan didn't
    if ((!existing.size && info.size) || (!existing.referer && info.referer)) {
      existing.size ||= info.size || null;
      existing.referer ||= info.referer || '';
      persist();
    }
    return;
  }

  let filename = 'video.mp4';
  try {
    const u = new URL(info.url);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1];
    if (last && last.toLowerCase().includes('.mp4')) {
      filename = decodeURIComponent(last);
    } else {
      filename = `video_${Date.now()}.mp4`;
    }
  } catch {
    filename = `video_${Date.now()}.mp4`;
  }

  // Ensure .mp4 extension
  if (!filename.toLowerCase().endsWith('.mp4')) {
    filename += '.mp4';
  }

  map.set(key, {
    url: info.url,
    type: 'video/mp4',
    size: info.size || null,
    filename,
    timestamp: Date.now(),
    tabUrl: info.tabUrl || '',
    title: info.title || '',
    referer: info.referer || '',
  });

  persist();
  updateBadge(tabId);
}

// ── HLS detection ────────────────────────────────────────────
// A player loads the master playlist, then one or more variant playlists
// (plus audio/subtitle renditions). Only the master is listed; the rest are
// remembered in hlsChildren so they don't show up as separate videos.
const hlsPending = new Set();

async function addHls(tabId, url, referer = '') {
  await ready;
  const key = url.split('?')[0];
  const pendingKey = `${tabId}|${key}`;
  if (hlsPending.has(pendingKey)) return;
  if (tabVideos.get(tabId)?.has(key) || hlsChildren.get(tabId)?.has(key)) return;

  hlsPending.add(pendingKey);
  const ruleId = await addRefererRule(url, referer);
  try {
    // Fetch the playlist to tell master from variant and read the quality.
    // If that fails (403, network), still list it: detection must not depend on it.
    let text = null;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) text = await res.text();
    } catch { /* keep text = null */ }
    if (text !== null && !text.includes('#EXTM3U')) return; // reachable but not a playlist

    let title = '';
    try { title = (await chrome.tabs.get(tabId)).title || ''; } catch { /* tab closed */ }

    // No awaits from here on: the master/variant check and the insert must be atomic,
    // or a master and its variant arriving together both get listed.
    const variants = text ? parseMasterPlaylist(text, url) : [];
    if (!hlsChildren.has(tabId)) hlsChildren.set(tabId, new Set());
    const children = hlsChildren.get(tabId);
    if (!tabVideos.has(tabId)) tabVideos.set(tabId, new Map());
    const map = tabVideos.get(tabId);

    if (variants.length > 0) {
      for (const u of [...variants.map((v) => v.url), ...parseRenditionUris(text, url)]) {
        const k = u.split('?')[0];
        children.add(k);
        map.delete(k); // a variant may have been listed before its master arrived
      }
    } else if (children.has(key)) {
      return; // variant of a master we already listed
    }

    const best = variants[0];
    map.set(key, {
      url,
      type: 'hls',
      size: null,
      quality: best && best.height ? `${best.height}p` : '',
      live: text !== null && variants.length === 0 && !text.includes('#EXT-X-ENDLIST'),
      filename: safeName(title) || `hls_${Date.now()}`,
      timestamp: Date.now(),
      title,
      referer,
    });
    persist();
    updateBadge(tabId);
  } finally {
    removeRule(ruleId);
    hlsPending.delete(pendingKey);
  }
}

// ── HLS download jobs (run in the offscreen document) ────────
// Memoized so parallel jobs (downloadAll) don't try to create two documents
let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenCreating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Assemble HLS segments into a single file for download',
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function startHlsJob(url, filename, saveAs = true) {
  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ruleId = await addRefererRule(url, findVideo(url)?.referer, { wholeSite: true });
  hlsJobs.set(jobId, { url, filename, saveAs, ruleId, status: 'queued', percent: 0, message: '待機中...' });
  persist();
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'hlsStart', jobId, url });
  return jobId;
}

async function onHlsReady(msg) {
  const job = hlsJobs.get(msg.jobId);
  if (!job) return;
  try {
    job.downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: `VideoGrabber/${safeName(job.filename) || 'video'}.${msg.ext}`,
      saveAs: job.saveAs,
    });
    Object.assign(job, { status: 'saving', percent: 100, message: '保存中...' });
    persist();
    // A small file can finish before downloadId was recorded, so check once here too
    const [item] = await chrome.downloads.search({ id: job.downloadId });
    if (item && item.state !== 'in_progress') finishJob(msg.jobId, item.state === 'complete');
  } catch (err) {
    Object.assign(job, { status: 'error', message: err.message });
    persist();
    removeRule(job.ruleId);
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'hlsRevoke', jobId: msg.jobId }).catch(() => {});
    maybeCloseOffscreen();
  }
}

// Once the file is written (or the save is cancelled), free the Blob and,
// when nothing else is running, close the offscreen document.
function finishJob(jobId, ok) {
  const job = hlsJobs.get(jobId);
  if (!job || job.status === 'done') return;
  Object.assign(job, { status: ok ? 'done' : 'error', message: ok ? '保存完了' : '保存が中断されました' });
  persist();
  removeRule(job.ruleId);
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'hlsRevoke', jobId }).catch(() => {});
  maybeCloseOffscreen();
}

const downloadRules = new Map(); // downloadId → ruleId for direct MP4 downloads

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  await ready;
  removeRule(downloadRules.get(delta.id));
  downloadRules.delete(delta.id);
  for (const [jobId, job] of hlsJobs) {
    if (job.downloadId === delta.id) finishJob(jobId, delta.state.current === 'complete');
  }
});

async function maybeCloseOffscreen() {
  const busy = [...hlsJobs.values()].some((j) => ['queued', 'parsing', 'downloading', 'merging', 'saving'].includes(j.status));
  if (!busy && await chrome.offscreen.hasDocument()) chrome.offscreen.closeDocument();
}

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

// ── WebRequest Network Listener ──────────────────────────────
// onResponseStarted, not onCompleted: video players stream with Range requests
// and often abort them mid-way, so onCompleted never fires for long videos.
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    // Ignore audio or ads
    if (AUDIO_EXCLUDE.test(url)) return;
    if (/doubleclick|googlesyndication|googleads|adsense|analytics/i.test(url)) return;

    const contentType = getHeader(details.responseHeaders, 'content-type');

    if (HLS_EXTENSION.test(url) || HLS_CONTENT_TYPE.test(contentType)) {
      addHls(details.tabId, url, refererFrom(details.initiator));
      return;
    }

    // For 206 responses Content-Length is only the chunk; the full size is in Content-Range
    const range = getHeader(details.responseHeaders, 'content-range').match(/\/(\d+)$/);
    const cl = getHeader(details.responseHeaders, 'content-length');
    const contentLength = range ? parseInt(range[1], 10) : (cl ? parseInt(cl, 10) : null);

    // Filter out tiny files (likely UI sounds/icons masquerading) - require > 150KB
    if (contentLength && contentLength < 150000) return;

    const isMp4 = MP4_EXTENSION.test(url) || MP4_CONTENT_TYPE.test(contentType);

    if (isMp4) {
      addVideo(details.tabId, {
        url,
        type: 'video/mp4',
        size: contentLength,
        referer: refererFrom(details.initiator),
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  clearTab(tabId);
});
// Reset the list when the tab navigates. Uses the main_frame request rather than
// tabs.onUpdated('loading'), which can arrive after the page's first sub-requests
// and wipe videos that were already detected.
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    await ready;
    clearTab(details.tabId);
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

// ── Downloads Handling ───────────────────────────────────────
async function triggerDirectDownload(url, filename, saveAs = true) {
  let cleanName = (filename || `video_${Date.now()}.mp4`).replace(/[<>:"/\\|?*]/g, '_');
  if (!cleanName.toLowerCase().endsWith('.mp4')) cleanName += '.mp4';

  const ruleId = await addRefererRule(url, findVideo(url)?.referer);
  try {
    const id = await chrome.downloads.download({
      url: url,
      filename: `VideoGrabber/${cleanName}`,
      saveAs,
    });
    if (ruleId) downloadRules.set(id, ruleId);
    return id;
  } catch (err) {
    removeRule(ruleId);
    throw err;
  }
}

// ── Message Listener ─────────────────────────────────────────
async function handleMessage(msg, sender) {
  await ready;

  if (msg.action === 'getVideos') {
    const map = tabVideos.get(msg.tabId);
    return { videos: map ? Array.from(map.values()) : [] };
  }

  if (msg.action === 'download') {
    try {
      await triggerDirectDownload(msg.url, msg.filename);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (msg.action === 'downloadHls') {
    return { ok: true, jobId: await startHlsJob(msg.url, msg.filename) };
  }

  if (msg.action === 'cancelHls') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'hlsCancel', jobId: msg.jobId }).catch(() => {});
    return { ok: true };
  }

  if (msg.action === 'downloadAll') {
    const map = tabVideos.get(msg.tabId);
    if (map) {
      // One save dialog per file is unusable for bulk; save straight into VideoGrabber/
      for (const v of map.values()) {
        if (v.type === 'hls') startHlsJob(v.url, v.filename, false);
        else triggerDirectDownload(v.url, v.filename, false).catch(() => {});
      }
    }
    return { ok: true };
  }

  if (msg.action === 'addVideo') {
    if (sender.tab) {
      await addVideo(sender.tab.id, {
        ...msg.video,
        tabUrl: sender.tab.url,
        referer: refererFrom(sender.url),
      });
    }
    return { ok: true };
  }

  if (msg.action === 'clearVideos') {
    clearTab(msg.tabId);
    updateBadge(msg.tabId);
    return { ok: true };
  }

  // From offscreen.js
  if (msg.action === 'hlsProgress') {
    const job = hlsJobs.get(msg.jobId);
    // Skip writes when only the segment counter moved within the same percent
    if (job && (job.status !== msg.status || job.percent !== msg.percent)) {
      Object.assign(job, { status: msg.status, percent: msg.percent, message: msg.message });
      persist();
      if (msg.status === 'error') {
        removeRule(job.ruleId);
        maybeCloseOffscreen();
      }
    }
    return;
  }

  if (msg.action === 'hlsReady') {
    await onHlsReady(msg);
    return;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  handleMessage(msg, sender).then(sendResponse);
  return true;
});
