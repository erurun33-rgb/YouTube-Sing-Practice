// YouTube page integration: videoId parsing, <video> discovery and SPA navigation tracking.
// Kept free of UI so Phase 1 can reuse it unchanged.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Phase 0 supports regular watch pages only (Shorts / live are out of scope).
export function parseVideoId(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  if (url.pathname !== '/watch') return null;
  const v = url.searchParams.get('v');
  return v && VIDEO_ID_RE.test(v) ? v : null;
}

export const VIDEO_SELECTORS = [
  '#movie_player video.html5-main-video',
  'video.html5-main-video',
  '#movie_player video',
];

export function findVideo(root = document) {
  for (const sel of VIDEO_SELECTORS) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function isAdShowing(root = document) {
  return !!root.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing');
}

// Emits onChange({ videoId, video, reason }) whenever the (videoId, <video>) pair changes.
// Sources: YouTube's own SPA events, popstate, and a 1s poll as a safety net
// (YouTube's internal events are not a public API and may change).
export class YouTubeWatcher {
  constructor({ onChange, logger, pollMs = 1000, win = window }) {
    this.onChange = onChange;
    this.logger = logger;
    this.pollMs = pollMs;
    this.win = win;
    this.current = { videoId: null, video: null };
    this._check = this._check.bind(this);
    this._onNav = (e) => this._check(e.type);
  }

  start() {
    const doc = this.win.document;
    doc.addEventListener('yt-navigate-finish', this._onNav);
    doc.addEventListener('yt-page-data-updated', this._onNav);
    this.win.addEventListener('popstate', this._onNav);
    this.timer = this.win.setInterval(() => this._check('poll'), this.pollMs);
    this._check('start');
  }

  stop() {
    const doc = this.win.document;
    doc.removeEventListener('yt-navigate-finish', this._onNav);
    doc.removeEventListener('yt-page-data-updated', this._onNav);
    this.win.removeEventListener('popstate', this._onNav);
    this.win.clearInterval(this.timer);
  }

  _check(reason) {
    const videoId = parseVideoId(this.win.location.href);
    const video = videoId ? findVideo(this.win.document) : null;
    const prev = this.current;
    if (videoId === prev.videoId && video === prev.video) return;
    this.current = { videoId, video };
    this.logger?.info('page change', { reason, videoId, videoChanged: video !== prev.video, hasVideo: !!video });
    this.onChange({ videoId, video, prevVideoId: prev.videoId, reason });
  }
}
