// ============================================================
// Video Grabber Pro — In-Browser HLS Assembly Engine
// ============================================================
// Fetches m3u8 playlist, downloads all video segments with a bounded
// worker pool, decrypts AES-128 if needed, and merges them into a single file.
// No external companion app (CoApp/ffmpeg) or server required.
// ============================================================

const MAX_RETRIES = 3;

export class HlsDownloader {
  constructor(manifestUrl, options = {}) {
    this.manifestUrl = manifestUrl;
    this.concurrency = options.concurrency || 6; // concurrent segment downloads
    this.onProgress = options.onProgress || (() => {});
    this.abortController = new AbortController();
    this.isAborted = false;
    this.keyCache = new Map(); // key URI → Promise<CryptoKey>
  }

  abort() {
    this.isAborted = true;
    this.abortController.abort();
  }

  async start() {
    this.onProgress({ status: 'parsing', message: 'プレイリストを解析中...', percent: 0 });

    // 1. Fetch & parse manifest
    const mediaPlaylistUrl = await this.resolveMediaPlaylist(this.manifestUrl);
    const playlist = await this.fetchAndParseMediaPlaylist(mediaPlaylistUrl);

    if (playlist.segments.length === 0) {
      throw new Error('動画セグメントが見つかりませんでした。');
    }
    if (playlist.segments.some((s) => s.key && s.key.method !== 'AES-128')) {
      throw new Error('この動画は DRM（SAMPLE-AES 等）で保護されているため保存できません。');
    }

    const total = playlist.segments.length;
    const parts = new Array(total);
    let done = 0;

    // 2. Download segments with a fixed-size worker pool
    let next = 0;
    const worker = async () => {
      while (next < total && !this.isAborted) {
        const index = next++;
        const seg = playlist.segments[index];
        let data = await this.fetchBytes(seg.url);
        if (seg.key) {
          const key = await this.getKey(seg.key.uri);
          data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: seg.key.iv || this.seqToIV(seg.seq) }, key, data);
        }
        parts[index] = data;
        done++;
        this.onProgress({
          status: 'downloading',
          message: `セグメント取得中 (${done}/${total})`,
          percent: Math.floor((done / total) * 100),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, total) }, worker));

    if (this.isAborted) {
      throw new Error('ダウンロードがキャンセルされました。');
    }

    // 3. Merge all segments into a single Blob.
    // fMP4 streams (#EXT-X-MAP) need their init segment in front and are real MP4.
    this.onProgress({ status: 'merging', message: '1本の動画ファイルに結合中...', percent: 100 });
    if (playlist.initUrl) {
      parts.unshift(await this.fetchBytes(playlist.initUrl));
      return { blob: new Blob(parts, { type: 'video/mp4' }), ext: 'mp4' };
    }
    return { blob: new Blob(parts, { type: 'video/mp2t' }), ext: 'ts' };
  }

  // ── Resolve Master Playlist to Media Playlist ──────────────
  async resolveMediaPlaylist(url) {
    const text = await this.fetchText(url);

    if (!text.includes('#EXTM3U')) {
      throw new Error('有効なHLSプレイリストではありません');
    }

    const best = parseMasterPlaylist(text, url)[0];
    return best ? best.url : url; // no variants → it is already a media playlist
  }

  // ── Parse Media Playlist into segment URLs ─────────────────
  async fetchAndParseMediaPlaylist(url) {
    const text = await this.fetchText(url);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const segments = [];
    let key = null;
    let seq = 0;
    let initUrl = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uri = line.match(/URI="([^"]+)"/);
        if (uri) initUrl = new URL(uri[1], url).href;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        // Keys can rotate mid-playlist, so each segment remembers the key in effect
        const method = (line.match(/METHOD=([^,\s]+)/) || [])[1];
        const uri = line.match(/URI="([^"]+)"/);
        const iv = line.match(/IV=0x([0-9a-fA-F]+)/i);
        key = method && method !== 'NONE' ? {
          method,
          uri: uri ? new URL(uri[1], url).href : null,
          iv: iv ? this.hexToArrayBuffer(iv[1]) : null,
        } : null;
      } else if (!line.startsWith('#')) {
        segments.push({ url: new URL(line, url).href, key, seq: seq++ });
      }
    }

    return { segments, initUrl };
  }

  getKey(uri) {
    if (!this.keyCache.has(uri)) {
      this.keyCache.set(uri, this.fetchBytes(uri).then((raw) =>
        crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])));
    }
    return this.keyCache.get(uri);
  }

  async fetchText(url) {
    const res = await fetch(url, { credentials: 'include', signal: this.abortController.signal });
    if (!res.ok) throw new Error(`プレイリスト取得失敗: ${res.status}`);
    return res.text();
  }

  async fetchBytes(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { credentials: 'include', signal: this.abortController.signal });
        if (!res.ok) throw new Error(`セグメント取得失敗: ${res.status}`);
        return await res.arrayBuffer();
      } catch (err) {
        if (this.isAborted || attempt >= MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  seqToIV(seq) {
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, seq, false); // big-endian
    return iv.buffer;
  }

  hexToArrayBuffer(hexString) {
    const hex = hexString.replace(/^0x/i, '').padStart(32, '0');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes.buffer;
  }
}

// Variants of a master playlist, best quality first. Empty for a media playlist.
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    // [:,] prefix so AVERAGE-BANDWIDTH is not mistaken for BANDWIDTH
    const bw = lines[i].match(/[:,]BANDWIDTH=(\d+)/);
    const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth: bw ? parseInt(bw[1], 10) : 0,
      height: res ? parseInt(res[2], 10) : 0,
    });
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth || b.height - a.height);
}

// URIs of alternate renditions (#EXT-X-MEDIA audio/subtitles) and I-frame (thumbnail)
// playlists in a master playlist
export function parseRenditionUris(text, baseUrl) {
  return [...text.matchAll(/#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):[^\n]*URI="([^"]+)"/g)].map((m) => new URL(m[1], baseUrl).href);
}
