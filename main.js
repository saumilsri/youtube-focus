// Runs in the page's MAIN world so it can read YouTube's own data objects
// (ytInitialData and the navigation responses). Read-only: it never clicks
// anything or sends anything to YouTube.
(() => {
  'use strict';
  const TIME = /^\d{1,2}(:\d{2}){1,2}$/;
  const initialPath = location.pathname;
  let navHomeData = null;
  // Feed items YouTube loads after the page (the home grid often arrives this way).
  let lateHomeData = [];

  // In-page (SPA) navigation hands us the fresh response for the new page.
  window.addEventListener('yt-navigate-finish', (e) => {
    if (location.pathname === '/' && e.detail) {
      navHomeData = e.detail.response || e.detail;
      lateHomeData = [];
    }
  });

  // Watch YouTube's own feed responses as they arrive. This only reads a copy
  // of the response; the request itself is untouched.
  // Save requests we are waiting to see go out (Watch later).
  const saveWatchers = [];
  function noteSaveRequest(url, p) {
    for (const w of saveWatchers.slice()) {
      if (!w.pattern.test(url)) continue;
      saveWatchers.splice(saveWatchers.indexOf(w), 1);
      p.then((res) => w.done({ sent: true, status: res.status }), () => w.done({ sent: true, status: 0 }));
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (saveWatchers.length) noteSaveRequest(url, p);
        if (url.includes('/youtubei/v1/browse') && location.pathname === '/') {
          p.then((res) => res.clone().json()).then((json) => {
            if (location.pathname === '/') lateHomeData.push(json);
          }).catch(() => {});
        }
      } catch (_) { /* never break YouTube */ }
      return p;
    };
  }

  function txt(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (typeof o.simpleText === 'string') return o.simpleText;
    if (Array.isArray(o.runs)) return o.runs.map((r) => r.text || '').join('');
    if (typeof o.content === 'string') return o.content;
    return '';
  }

  function findKey(obj, key, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 30 || seen.has(obj)) return null;
    seen.add(obj);
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = findKey(v, key, depth + 1, seen);
        if (r) return r;
      }
    }
    return null;
  }

  function findAll(obj, key, out, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 30 || seen.has(obj)) return out;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === key) out.push(v);
      if (v && typeof v === 'object') findAll(v, key, out, depth + 1, seen);
    }
    return out;
  }

  // YouTube's silent animated hover preview (a short .webp on i.ytimg.com).
  const PREVIEW = /https:\/\/i\.ytimg\.com\/an_webp\/[^"\\\s]+/;
  function previewUrl(obj) {
    try { const m = JSON.stringify(obj).match(PREVIEW); return m ? m[0] : ''; } catch (_) { return ''; }
  }

  function hasShortsUrl(obj) {
    return JSON.stringify(obj).includes('"/shorts/');
  }

  function fromVideoRenderer(r) {
    const overlays = r.thumbnailOverlays || [];
    let duration = txt(r.lengthText);
    let live = false;
    let short = false;
    for (const o of overlays) {
      const t = o.thumbnailOverlayTimeStatusRenderer;
      if (!t) continue;
      if (!duration) duration = txt(t.text);
      if (t.style === 'LIVE' || t.style === 'UPCOMING') live = true;
      if (t.style === 'SHORTS') short = true;
    }
    for (const b of r.badges || []) {
      const s = b.metadataBadgeRenderer && b.metadataBadgeRenderer.style || '';
      if (s.includes('LIVE')) live = true;
    }
    if (r.upcomingEventData) live = true;
    const url = r.navigationEndpoint && r.navigationEndpoint.commandMetadata &&
      r.navigationEndpoint.commandMetadata.webCommandMetadata &&
      r.navigationEndpoint.commandMetadata.webCommandMetadata.url || '';
    if (url.startsWith('/shorts/')) short = true;
    if (!TIME.test(duration.trim())) { duration = ''; live = true; }
    return {
      id: r.videoId,
      title: txt(r.title),
      channel: txt(r.ownerText) || txt(r.shortBylineText) || txt(r.longBylineText),
      duration: duration.trim(),
      live,
      short,
      preview: previewUrl(r.richThumbnail || r)
    };
  }

  function fromLockup(l) {
    if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const meta = l.metadata && l.metadata.lockupMetadataViewModel || {};
    let channel = '';
    const rows = meta.metadata && meta.metadata.contentMetadataViewModel &&
      meta.metadata.contentMetadataViewModel.metadataRows || [];
    for (const row of rows) {
      const part = row.metadataParts && row.metadataParts[0];
      const t = part ? txt(part.text).trim() : '';
      // Skip view counts / dates ("1.9M views", "3 days ago") that sit in the same rows.
      if (t && !/\bviews?\b|\bago$|^\d[\d.,]*\s*[KMB]?$/i.test(t)) { channel = t; break; }
    }
    let duration = '';
    let live = false;
    for (const b of findAll(l.contentImage || {}, 'thumbnailBadgeViewModel', [], 0, new WeakSet())) {
      const t = (txt(b.text) || '').trim();
      const style = String(b.badgeStyle || '');
      if (TIME.test(t)) duration = t;
      if (style.includes('LIVE') || /^(live|upcoming|premiere)/i.test(t)) live = true;
    }
    if (!duration) live = true;
    return {
      id: l.contentId,
      title: txt(meta.title),
      channel,
      duration,
      live,
      short: hasShortsUrl(l),
      preview: previewUrl(l.contentImage || l)
    };
  }

  // Collect every richItemRenderer (the home grid's own cards) in a response.
  // Items inside shelves (richSectionRenderer: Shorts, news, etc.) are skipped.
  function collectItems(obj, out, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 40 || seen.has(obj)) return;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v || typeof v !== 'object') continue;
      if (k === 'richSectionRenderer' || k === 'richShelfRenderer' || k === 'reelShelfRenderer') continue;
      if (k === 'richItemRenderer') { if (v.content) out.push(v.content); continue; }
      collectItems(v, out, depth + 1, seen);
    }
  }

  function extract(data) {
    if (!data) return [];
    const contents = [];
    try { collectItems(data, contents, 0, new WeakSet()); } catch (_) { return []; }
    const out = [];
    for (const content of contents) {
      try {
        let v = null;
        if (content.videoRenderer) v = fromVideoRenderer(content.videoRenderer);
        else if (content.lockupViewModel) v = fromLockup(content.lockupViewModel);
        if (v && v.id && v.title) out.push(v);
      } catch (_) { /* skip malformed item */ }
    }
    return out;
  }

  function hasNudge(data) {
    try { return !!(data && JSON.stringify(data).includes('feedNudgeRenderer')); } catch (_) { return false; }
  }

  function elementData(el) {
    if (!el) return [];
    return [el.data, el.__data && el.__data.data, el.polymerController && el.polymerController.data];
  }

  function candidates() {
    const info = { items: [], nudge: false, sources: {} };
    if (location.pathname !== '/') return info;
    const browse = document.querySelector('ytd-browse[page-subtype="home"]');
    const grid = browse && browse.querySelector('ytd-rich-grid-renderer');
    const sources = {
      navigation: [navHomeData],
      grid: elementData(grid),
      page: elementData(browse),
      initial: initialPath === '/' ? [window.ytInitialData] : [],
      later: lateHomeData
    };
    const seenIds = new Set();
    for (const [name, list] of Object.entries(sources)) {
      let n = 0;
      for (const s of list) {
        if (!s) continue;
        if (hasNudge(s)) info.nudge = true;
        for (const v of extract(s)) {
          n++;
          if (!seenIds.has(v.id)) { seenIds.add(v.id); info.items.push(v); }
        }
      }
      info.sources[name] = n;
    }
    return info;
  }

  // Runs one of YouTube's own commands the way its buttons do, so YouTube
  // handles sign-in, the request and its own "Saved" toast / dialog.
  function runYouTubeCommand(command) {
    const app = document.querySelector('ytd-app');
    if (!app) return false;
    app.dispatchEvent(new CustomEvent('yt-action', {
      bubbles: true,
      composed: true,
      detail: { actionName: 'yt-service-request', args: [{ data: {} }, command], optionalAction: false, returnValue: [] }
    }));
    return true;
  }

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const SAVE_ACTIONS = {
    'watch-later': {
      pattern: /\/youtubei\/v1\/browse\/edit_playlist/,
      command: (id) => ({
        commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } },
        playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: id, action: 'ACTION_ADD_VIDEO' }] }
      })
    }
  };

  function save(kind, id) {
    return new Promise((resolve) => {
      const a = SAVE_ACTIONS[kind];
      if (!a || !VIDEO_ID.test(id)) return resolve({ sent: false, status: 0 });
      const w = { pattern: a.pattern, done: (r) => { clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        const i = saveWatchers.indexOf(w);
        if (i >= 0) saveWatchers.splice(i, 1);
        resolve({ sent: false, status: 0 });
      }, 4000);
      saveWatchers.push(w);
      if (!runYouTubeCommand(a.command(id))) w.done({ sent: false, status: 0 });
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ytfocus-iso') return;
    if (e.data.type === 'save') {
      const reqId = e.data.id;
      save(String(e.data.kind || ''), String(e.data.videoId || '')).then((r) => {
        window.postMessage({ source: 'ytfocus-main', type: 'save-result', id: reqId, sent: r.sent, status: r.status }, location.origin);
      });
      return;
    }
    if (e.data.type !== 'get-candidates') return;
    let info = { items: [], nudge: false, sources: {} };
    try { info = candidates(); } catch (err) { info.error = String(err && err.message || err); }
    window.postMessage({ source: 'ytfocus-main', type: 'candidates', id: e.data.id,
      items: info.items, nudge: info.nudge, sources: info.sources, error: info.error || '' }, location.origin);
  });
})();
