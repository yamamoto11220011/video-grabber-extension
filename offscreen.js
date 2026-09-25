// ============================================================
// Video Grabber Pro — Offscreen HLS Worker
// ============================================================
// Runs HLS jobs outside the popup (which dies when closed) and outside the
// service worker (which cannot create Blob URLs for chrome.downloads).
// Jobs run one at a time; progress is reported back to background.js.
// ============================================================

import { HlsDownloader } from './hls-engine.js';

const queue = [];
const blobUrls = new Map(); // jobId → blob URL
let current = null; // { jobId, downloader }

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function runNext() {
  if (current || queue.length === 0) return;
  const { jobId, url } = queue.shift();
  const downloader = new HlsDownloader(url, {
    onProgress: (p) => send({ action: 'hlsProgress', jobId, status: p.status, percent: p.percent, message: p.message }),
  });
  current = { jobId, downloader };
  try {
    const { blob, ext } = await downloader.start();
    const blobUrl = URL.createObjectURL(blob);
    blobUrls.set(jobId, blobUrl);
    send({ action: 'hlsReady', jobId, blobUrl, ext, size: blob.size });
  } catch (err) {
    send({ action: 'hlsProgress', jobId, status: 'error', percent: 0, message: err.message });
  } finally {
    current = null;
    runNext();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'hlsStart') {
    queue.push({ jobId: msg.jobId, url: msg.url });
    runNext();
  }

  if (msg.action === 'hlsCancel') {
    const i = queue.findIndex((j) => j.jobId === msg.jobId);
    if (i >= 0) queue.splice(i, 1);
    if (current && current.jobId === msg.jobId) current.downloader.abort();
  }

  if (msg.action === 'hlsRevoke') {
    const blobUrl = blobUrls.get(msg.jobId);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrls.delete(msg.jobId);
  }
});
