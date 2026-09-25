// ============================================================
// Video Grabber Pro — Popup Script (MP4 + HLS)
// ============================================================

(function () {
  'use strict';

  let allVideos = [];
  let hlsJobs = {}; // jobId → job, mirrored from storage.session by background.js

  const videoList = document.getElementById('videoList');
  const emptyState = document.getElementById('emptyState');
  const videoCount = document.getElementById('videoCount');
  const pageTitle = document.getElementById('pageTitle');
  const refreshBtn = document.getElementById('refreshBtn');
  const clearBtn = document.getElementById('clearBtn');
  const reloadCacheBtn = document.getElementById('reloadCacheBtn');
  const superReloadBtn = document.getElementById('superReloadBtn');
  const downloadAllBtn = document.getElementById('downloadAllBtn');

  const MP4_REGEX = /\.(mp4|m4v)(\?|#|$)/i;
  const AUDIO_EXCLUDE = /\.(mp3|wav|ogg|aac|m4a|flac|wma)(\?|#|$)/i;

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    pageTitle.textContent = tab.title || tab.url || '—';
    hlsJobs = (await chrome.storage.session.get('hlsJobs')).hlsJobs || {};
    loadVideos(tab.id);
  }

  // Live progress for HLS jobs running in the offscreen document
  chrome.storage.session.onChanged.addListener((changes) => {
    if (!changes.hlsJobs) return;
    hlsJobs = changes.hlsJobs.newValue || {};
    videoList.querySelectorAll('.hls-progress').forEach((el) => {
      el.outerHTML = createHlsProgress(el.dataset.url);
    });
  });

  // The most recent job for this playlist URL
  function latestJob(url) {
    const jobs = Object.entries(hlsJobs).filter(([, j]) => j.url === url);
    return jobs.length ? jobs[jobs.length - 1][1] : null;
  }

  function createHlsProgress(url) {
    const job = latestJob(url);
    const active = job && !['done', 'error'].includes(job.status);
    const cls = !job ? 'idle' : job.status === 'error' ? 'error' : job.status === 'done' ? 'done' : 'active';
    return `
      <div class="hls-progress ${cls}" data-url="${escapeHtml(url)}">
        ${job ? `
          <div class="hls-bar"><div class="hls-bar-fill" style="width:${active || job.status === 'done' ? job.percent : 0}%"></div></div>
          <span class="hls-message">${escapeHtml(job.message || '')}</span>
        ` : ''}
      </div>
    `;
  }

  function loadVideos(tabId) {
    chrome.runtime.sendMessage({ action: 'getVideos', tabId }, (response) => {
      if (response && response.videos) {
        // MP4 and HLS only, definitely no mp3/audio
        allVideos = response.videos.filter(v => {
          if (v.type === 'hls') return true;
          if (AUDIO_EXCLUDE.test(v.url) || AUDIO_EXCLUDE.test(v.filename || '')) return false;
          return MP4_REGEX.test(v.url) || v.type === 'video/mp4';
        });
        renderVideos();
      }
    });
  }

  function renderVideos() {
    if (allVideos.length === 0) {
      videoList.innerHTML = '';
      videoList.appendChild(emptyState);
      emptyState.style.display = 'flex';
      videoCount.textContent = '0 件の動画を検出';
      return;
    }

    emptyState.style.display = 'none';
    videoCount.textContent = `${allVideos.length} 件の動画を検出`;

    videoList.innerHTML = allVideos.map((v) => createVideoCard(v)).join('');

    videoList.querySelectorAll('.btn-download').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.dataset.url;
        const filename = e.currentTarget.dataset.filename;
        const action = e.currentTarget.dataset.kind === 'hls' ? 'downloadHls' : 'download';
        chrome.runtime.sendMessage({ action, url, filename });
        showDownloadFeedback(e.currentTarget);
      });
    });

    videoList.querySelectorAll('.btn-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.dataset.url;
        navigator.clipboard.writeText(url);
        e.currentTarget.classList.add('copied');
        setTimeout(() => e.currentTarget.classList.remove('copied'), 1500);
      });
    });
  }

  function formatSize(bytes) {
    if (!bytes) return null;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  function createVideoCard(v) {
    const isHls = v.type === 'hls';
    const filename = v.filename || 'video.mp4';
    const size = formatSize(v.size);

    return `
      <div class="video-card">
        <div class="video-card-header">
          <span class="video-type-badge ${isHls ? 'hls' : ''}">${isHls ? 'HLS' : 'MP4'}</span>
          <span class="video-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
        </div>
        <div class="video-card-meta">
          ${isHls && v.quality ? `<span class="meta-item">最高 ${escapeHtml(v.quality)}</span>` : ''}
          ${isHls && v.live ? `<span class="meta-item">ライブ（今ある分だけ）</span>` : ''}
          ${size ? `
            <span class="meta-item">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              ${size}
            </span>
          ` : ''}
          <span class="meta-item">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            ${new Date(v.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div class="video-card-actions">
          <button class="btn-download" data-kind="${isHls ? 'hls' : 'mp4'}" data-url="${escapeHtml(v.url)}" data-filename="${escapeHtml(filename)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            ダウンロード
          </button>
          <button class="btn-copy" data-url="${escapeHtml(v.url)}" title="URLをコピー">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
        ${isHls ? createHlsProgress(v.url) : ''}
      </div>
    `;
  }

  function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML.replace(/"/g, '&quot;');
  }

  function showDownloadFeedback(btn) {
    const originalText = btn.innerHTML;
    btn.innerHTML = `<span>開始しました</span>`;
    setTimeout(() => { btn.innerHTML = originalText; }, 2000);
  }

  // ── 1. Cache-Bypass Reload (ログイン維持) ──────────────────
  reloadCacheBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      reloadCacheBtn.innerHTML = '<span>再読み込み中...</span>';
      chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        window.close();
      });
    }
  });

  // ── 2. Super Reload (Cookie削除＋キャッシュ無視) ───────────
  superReloadBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const confirmed = confirm(
      '【ご注意】\n本家VDHの「強制検出」と同じ処理を行います。\nこのサイトのCookieが削除されるため、ログイン中の場合はログアウトされます。\n\n実行してよろしいですか？'
    );
    if (!confirmed) return;

    superReloadBtn.innerHTML = '<span>Cookie削除中...</span>';

    try {
      const u = new URL(tab.url);

      // getAll({ domain }) only returns that host and its subdomains, so it misses
      // parent-domain cookies (".example.com") where logins usually live.
      // getAll({ url }) adds every cookie the page actually receives.
      const found = [
        ...await chrome.cookies.getAll({ domain: u.hostname }),
        ...await chrome.cookies.getAll({ url: tab.url }),
      ];
      const cookies = [...new Map(found.map((c) => [`${c.domain}|${c.path}|${c.name}`, c])).values()];
      for (const c of cookies) {
        const cookieUrl = `http${c.secure ? 's' : ''}://${c.domain.startsWith('.') ? c.domain.slice(1) : c.domain}${c.path}`;
        await chrome.cookies.remove({ url: cookieUrl, name: c.name }).catch(() => {});
      }

      chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        window.close();
      });
    } catch (e) {
      console.error('Super reload error:', e);
      chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        window.close();
      });
    }
  });

  // ── Refresh & Clear ──────────────────────────────────────
  // Rescan the page (DOM + <script> text + muted play) before reloading the list
  refreshBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'forceDetect' });
    } catch { /* no content script on this page (e.g. chrome://) */ }
    setTimeout(() => loadVideos(tab.id), 600);
  });

  clearBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.runtime.sendMessage({ action: 'clearVideos', tabId: tab.id }, () => {
        allVideos = [];
        renderVideos();
      });
    }
  });

  downloadAllBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.runtime.sendMessage({ action: 'downloadAll', tabId: tab.id });
    }
  });

  init();
})();
