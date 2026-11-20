// Isolated-world content script: home page picks, lock, countdown, and the
// clean-up rules for the rest of YouTube. It never clicks "Not interested"
// or anything that feeds YouTube's recommendation algorithm.
(() => {
  'use strict';
  const Y = globalThis.YTF;
  const html = document.documentElement;
  let S = Y.withState({});
  const ready = chrome.storage.local.get(null).then((d) => { S = Y.withState(d); });

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isHome = () => location.pathname === '/';
  const isWatch = () => location.pathname === '/watch';

  // Build DOM without innerHTML (YouTube enforces Trusted Types).
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  function whenBody() {
    if (document.body) return Promise.resolve();
    return new Promise((res) => {
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); res(); } });
      mo.observe(html, { childList: true });
    });
  }

  // ---------- reading the home feed ----------
  function requestFromPage() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (info) => { clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(info); };
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.source !== 'ytfocus-main' || e.data.id !== id) return;
        const d = e.data;
        done({ replied: true, items: Array.isArray(d.items) ? d.items : [], nudge: !!d.nudge,
          sources: d.sources || {}, error: d.error || '' });
      };
      const timer = setTimeout(() => done({ replied: false, items: [], nudge: false, sources: {}, error: '' }), 800);
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'ytfocus-iso', type: 'get-candidates', id }, location.origin);
    });
  }

  const TIME = /^\d{1,2}(:\d{2}){1,2}$/;

  // Fallback: read the rendered (hidden) grid.
  function readDom() {
    const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
    if (!grid) return [];
    const out = [];
    for (const item of grid.querySelectorAll('ytd-rich-item-renderer')) {
      if (item.closest('ytd-rich-section-renderer')) continue;
      const a = item.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
      if (!a) continue;
      const href = a.getAttribute('href') || '';
      const short = href.startsWith('/shorts/') || !!item.querySelector('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2');
      let id = '';
      try { id = short ? href.split('/')[2].split('?')[0] : new URL(href, location.origin).searchParams.get('v'); } catch (_) { continue; }
      const titleEl = item.querySelector('#video-title, h3 a[title], h3[title], [class*="lockup-metadata-view-model"][class*="title"]');
      const title = ((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '').trim();
      const chEl = item.querySelector('ytd-channel-name #text, ytd-channel-name a, [class*="metadata-row"] a, [class*="metadata-row"] span');
      const channel = ((chEl && chEl.textContent) || '').trim();
      const badges = [...item.querySelectorAll('badge-shape, ytd-thumbnail-overlay-time-status-renderer, [class*="badge-shape"][class*="text"]')]
        .map((e) => (e.textContent || '').trim());
      const duration = badges.find((t) => TIME.test(t)) || '';
      const live = badges.some((t) => /^(live|upcoming|premiere)/i.test(t)) ||
        !!item.querySelector('[overlay-style="LIVE"], [overlay-style="UPCOMING"], .badge-style-type-live-now, [class*="thumbnail-live"]');
      if (id && title) out.push({ id, title, channel, duration, live, short });
    }
    return out;
  }

  // Returns { items, diag } where diag explains what was found if items is empty.
  async function getCandidates() {
    let last = null;
    let domCount = 0;
    for (let i = 0; i < 16; i++) {
      if (!isHome()) return { items: [], diag: null };
      const info = await requestFromPage();
      let items = info.items;
      const dom = readDom();
      domCount = dom.length;
      if (dom.length > items.length) items = dom;
      last = info;
      if (items.length >= 3 || (i >= 6 && items.length)) return { items, diag: null };
      // YouTube is showing "Try searching to get started": there is no feed to read.
      if (info.nudge && i >= 3) break;
      await sleep(500);
    }
    const src = last && Object.entries(last.sources).map(([k, n]) => `${k} ${n}`).join(', ');
    const diag = {
      nudge: !!(last && last.nudge),
      detail: [
        last && last.replied ? `page data: ${src || 'none'}` : 'page reader: no reply',
        `rendered cards: ${domCount}`,
        last && last.error ? `error: ${last.error}` : ''
      ].filter(Boolean).join(' · ')
    };
    return { items: [], diag };
  }

  // ---------- home UI ----------
  let root = null;
  let countdownEl = null;
  let picking = null;

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById('ytf-root') || h('div', { id: 'ytf-root' });
    if (!root.isConnected) document.body.appendChild(root);
    return root;
  }

  function drawStatus(msg, detail) {
    ensureRoot();
    countdownEl = null;
    lastStatus = { msg, detail };
    root.replaceChildren(h('div', { class: 'ytf-wrap' },
      shelfSection(),
      h('p', { class: 'ytf-status', text: msg }),
      detail ? h('p', { class: 'ytf-detail', text: detail }) : null));
  }

  async function saveTypes(types) { S.channelTypes = types; await chrome.storage.local.set({ channelTypes: types }); }
  async function saveSkips(list) { S.skipChannels = list; await chrome.storage.local.set({ skipChannels: list }); }

  async function toggleSkip(v) {
    const n = Y.normChannel(v.channel);
    const list = S.skipChannels.filter((c) => Y.normChannel(c) !== n);
    if (list.length === S.skipChannels.length) list.push(v.channel);
    await saveSkips(list);
    drawBatch(S.lock);
  }

  async function flipType(v) {
    const current = Y.typeOverride(v.channel, S.channelTypes) || v.bucket;
    const next = current === 'fun' ? 'serious' : 'fun';
    const n = Y.normChannel(v.channel);
    const types = {};
    for (const [name, t] of Object.entries(S.channelTypes)) if (Y.normChannel(name) !== n) types[name] = t;
    types[v.channel] = next;
    await saveTypes(types);
    drawBatch(S.lock);
  }

  const label = (b) => (b === 'fun' ? 'Fun' : 'Serious');

  // Ask the page script to run YouTube's own Watch later / Save command.
  function requestSave(kind, videoId) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.source !== 'ytfocus-main' || e.data.type !== 'save-result' || e.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve({ sent: !!e.data.sent, status: Number(e.data.status) || 0 });
      };
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ sent: false, status: 0 }); }, 6000);
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'ytfocus-iso', type: 'save', kind, videoId, id }, location.origin);
    });
  }

  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.ytf-more')) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  async function doSave(kind, v, statusEl) {
    closeMenu();
    statusEl.textContent = 'Saving to Watch later…';
    const r = await requestSave(kind, v.id);
    if (r.sent && r.status >= 200 && r.status < 300) {
      statusEl.textContent = 'Saved to Watch later.';
    } else if (r.sent && (r.status === 401 || r.status === 403)) {
      statusEl.textContent = 'Sign in to YouTube to save videos.';
    } else {
      statusEl.textContent = "Couldn't save from here. Open the video and use Save there.";
    }
  }

  function moreButton(v, statusEl) {
    const btn = h('button', { type: 'button', class: 'ytf-more', 'aria-label': 'More actions', title: 'More actions', text: '⋮' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu && openMenu.dataset.vid === v.id) { closeMenu(); return; }
      closeMenu();
      const menu = h('div', { class: 'ytf-menu', role: 'menu' },
        h('button', { type: 'button', role: 'menuitem', text: 'Save to YouTube Watch later', onclick: () => doSave('watch-later', v, statusEl) }));
      menu.dataset.vid = v.id;
      btn.parentElement.appendChild(menu);
      openMenu = menu;
    });
    return btn;
  }

  // ---------- hover preview (YouTube's own silent animated thumbnail) ----------
  function withPreview(thumbLink, previewUrl) {
    const url = Y.cleanPreview(previewUrl);
    if (!url) return thumbLink;
    let timer = null;
    let img = null;
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      if (img) { img.remove(); img = null; }
    };
    thumbLink.addEventListener('mouseenter', () => {
      stop();
      timer = setTimeout(() => {
        img = h('img', { class: 'ytf-preview', src: url, alt: '' });
        img.addEventListener('load', () => img && img.classList.add('ytf-in'));
        img.addEventListener('error', stop);
        thumbLink.insertBefore(img, thumbLink.querySelector('.ytf-dur'));
      }, 350);
    });
    thumbLink.addEventListener('mouseleave', stop);
    return thumbLink;
  }

  // ---------- shelf: the extension's own 5-video watch-later list ----------
  async function saveShelf(list) {
    S.shelf = list;
    await chrome.storage.local.set({ shelf: list });
  }

  async function addToShelf(v, statusEl) {
    const fresh = Y.withState(await chrome.storage.local.get(null)).shelf;
    if (fresh.some((x) => x.id === v.id)) return;
    if (fresh.length >= Y.SHELF_LIMIT) {
      if (statusEl) statusEl.textContent = `Your shelf is full (${Y.SHELF_LIMIT}). Remove something first.`;
      return;
    }
    await saveShelf(fresh.concat([{ id: v.id, title: v.title, channel: v.channel, duration: v.duration,
      preview: v.preview || '', addedAt: Date.now() }]));
    drawCurrent();
  }

  async function removeFromShelf(id) {
    const fresh = Y.withState(await chrome.storage.local.get(null)).shelf;
    await saveShelf(fresh.filter((x) => x.id !== id));
    drawCurrent();
  }

  function shelfSection() {
    const items = S.shelf;
    return h('section', { class: 'ytf-shelf', 'aria-label': 'Shelf' },
      h('div', { class: 'ytf-shelf-head' },
        h('span', { class: 'ytf-shelf-title' }, h('span', { class: 'ytf-shelf-icon', 'aria-hidden': 'true', text: '❏' }), 'Shelf'),
        h('span', { class: 'ytf-shelf-count', text: `${items.length} / ${Y.SHELF_LIMIT}` })),
      items.length
        ? h('div', { class: 'ytf-shelf-row' }, items.map((v) => {
          const href = '/watch?v=' + encodeURIComponent(v.id);
          return h('div', { class: 'ytf-shelf-item' },
            withPreview(h('a', { class: 'ytf-thumb', href },
              h('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: '', loading: 'lazy' }),
              v.duration ? h('span', { class: 'ytf-dur', text: v.duration }) : null), v.preview),
            h('div', { class: 'ytf-titlerow' },
              h('a', { class: 'ytf-shelf-vtitle', href, text: v.title, title: v.title }),
              h('button', { type: 'button', class: 'ytf-shelf-remove', 'aria-label': 'Remove from shelf',
                title: 'Remove from shelf', text: '✕', onclick: () => removeFromShelf(v.id) })),
            h('div', { class: 'ytf-channel', text: v.channel || '' }));
        }).concat(Array.from({ length: Math.max(0, Y.SHELF_LIMIT - items.length) },
          () => h('div', { class: 'ytf-shelf-slot', 'aria-hidden': 'true' }))))
        : h('p', { class: 'ytf-shelf-empty',
          text: 'Your shelf is empty. Press + Add to shelf on a pick below to keep it here. Videos stay until you remove them or watch them to the end.' }));
  }

  // Redraw whatever the home panel is currently showing.
  let lastStatus = null;
  function drawCurrent() {
    if (!isHome()) return;
    if (Y.isLockValid(S.lock, S.settings, Date.now())) drawBatch(S.lock);
    else if (lastStatus) drawStatus(lastStatus.msg, lastStatus.detail);
  }

  function card(v) {
    const skipped = Y.isSkipped(v.channel, S.skipChannels);
    const override = Y.typeOverride(v.channel, S.channelTypes);
    const href = '/watch?v=' + encodeURIComponent(v.id);
    let note = '';
    if (skipped) note = 'Channel hidden from future picks.';
    else if (override && override !== v.bucket) note = `Future picks from this channel: ${label(override)}.`;
    const saveStatus = h('div', { class: 'ytf-note ytf-save-status', 'aria-live': 'polite' });
    const onShelf = S.shelf.some((x) => x.id === v.id);
    return h('div', { class: 'ytf-card' + (skipped ? ' ytf-skipped' : '') },
      withPreview(h('a', { class: 'ytf-thumb', href },
        h('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`, alt: '', loading: 'lazy' }),
        v.duration ? h('span', { class: 'ytf-dur', text: v.duration }) : null), v.preview),
      h('div', { class: 'ytf-meta' },
        h('div', { class: 'ytf-titlerow' },
          h('a', { class: 'ytf-vtitle', href, text: v.title, title: v.title }),
          moreButton(v, saveStatus)),
        h('div', { class: 'ytf-channel' },
          h('span', { text: v.channel || 'Unknown channel' })),
        h('div', { class: 'ytf-actions' },
          h('button', { type: 'button', class: onShelf ? 'ytf-shelf-btn ytf-on' : 'ytf-shelf-btn',
            onclick: () => (onShelf ? removeFromShelf(v.id) : addToShelf(v, saveStatus)),
            text: onShelf ? '✓ On shelf' : '+ Add to shelf',
            title: onShelf ? 'Remove from your shelf' : 'Keep this on your shelf for later' }),
          h('button', { type: 'button', onclick: () => toggleSkip(v), text: skipped ? 'Undo skip' : 'Skip channel',
            title: 'Hide this channel from future picks' }),
          h('button', { type: 'button', onclick: () => flipType(v), text: 'Wrong type',
            title: 'Flip this channel between serious and fun for future picks' })),
        note ? h('div', { class: 'ytf-note', text: note }) : null,
        saveStatus));
  }

  function drawBatch(lock) {
    if (!lock || !isHome()) return;
    ensureRoot();
    lastStatus = null;
    countdownEl = h('span', { class: 'ytf-countdown' });
    const total = S.settings.batchSize;
    root.replaceChildren(h('div', { class: 'ytf-wrap' },
      shelfSection(),
      h('div', { class: 'ytf-head' },
        h('span', { class: 'ytf-heading', text: 'Your picks' }),
        countdownEl),
      h('div', { class: 'ytf-grid' }, lock.videos.map(card)),
      lock.videos.length < total
        ? h('p', { class: 'ytf-status', text: `Only ${lock.videos.length} videos passed the filters this time.` })
        : null));
    tick();
  }

  function tick() {
    if (!isHome() || !S.lock) return;
    const left = Y.lockExpiry(S.lock, S.settings) - Date.now();
    if (left <= 0 || !Y.isLockValid(S.lock, S.settings, Date.now())) { renderHome(); return; }
    if (countdownEl) countdownEl.textContent = 'Next batch in ' + Y.formatRemaining(left);
  }

  async function renderHome() {
    if (!isHome()) return;
    await ready;
    await whenBody();
    if (!isHome()) return;
    ensureRoot();
    if (Y.isLockValid(S.lock, S.settings, Date.now())) { drawBatch(S.lock); return; }
    if (picking) return picking;
    drawStatus('Picking your videos…');
    picking = (async () => {
      const { items, diag } = await getCandidates();
      // Another tab may have picked while we waited.
      S = Y.withState(await chrome.storage.local.get(null));
      if (!isHome()) return;
      if (Y.isLockValid(S.lock, S.settings, Date.now())) { drawBatch(S.lock); return; }
      if (!items.length) {
        if (diag && diag.nudge) {
          drawStatus('YouTube has no recommendations to show on this account (it says "Try searching to get started"). ' +
            'This happens when you are signed out or watch history is off. Turn watch history on, watch a few videos, then refresh.',
            diag.detail);
        } else {
          drawStatus("Couldn't read YouTube's recommendations. Refresh the page to try again.", diag && diag.detail);
        }
        return;
      }
      const videos = Y.pickVideos(items, S);
      if (!videos.length) { drawStatus('Nothing in the feed passed your filters. Refresh to try again.'); return; }
      const lock = { pickedAt: Date.now(), videos };
      const seen = [...new Set(videos.map((v) => v.id).concat(S.seen))].slice(0, Y.SEEN_LIMIT);
      S.lock = lock;
      S.seen = seen;
      await chrome.storage.local.set({ lock, seen });
      drawBatch(lock);
    })().finally(() => { picking = null; });
    return picking;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    chrome.storage.local.get(null).then((d) => {
      S = Y.withState(d);
      if (isHome() && !picking) renderHome();
    });
  });

  // ---------- everywhere else ----------
  const hide = (el) => el && el.classList.add('ytf-hidden');
  const textOf = (el) => (el.textContent || '').trim();

  function hideByText() {
    // Shorts tabs, filter chips and guide links.
    for (const el of document.querySelectorAll(
      'yt-chip-cloud-chip-renderer, chip-view-model, yt-chip-view-model, tp-yt-paper-tab, yt-tab-shape, ' +
      'ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer')) {
      if (textOf(el) === 'Shorts') hide(el);
    }
  }

  // Watch page sidebar: keep only the first 5 videos (no mixes, playlists or extra loading).
  const SIDEBAR_LIMIT = 5;
  const SIDEBAR_ITEMS = 'ytd-compact-video-renderer, yt-lockup-view-model, ytd-compact-radio-renderer, ' +
    'ytd-compact-playlist-renderer, ytd-compact-movie-renderer, ytd-reel-shelf-renderer, ytd-ad-slot-renderer';

  function isPlainVideo(el) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'ytd-compact-video-renderer' && tag !== 'yt-lockup-view-model') return false;
    const a = el.querySelector('a[href*="/watch?v="]');
    if (!a) return false;
    const href = a.getAttribute('href') || '';
    return !href.includes('list=');
  }

  function limitSidebar() {
    for (const box of document.querySelectorAll('ytd-watch-next-secondary-results-renderer')) {
      let count = 0;
      for (const el of box.querySelectorAll(SIDEBAR_ITEMS)) {
        const parentItem = el.parentElement && el.parentElement.closest(SIDEBAR_ITEMS);
        if (parentItem && box.contains(parentItem)) continue; // nested inside another item
        const keep = count < SIDEBAR_LIMIT && isPlainVideo(el);
        if (keep) count++;
        el.classList.toggle('ytf-hidden', !keep);
      }
    }
  }

  let lastAutoplayClick = 0;
  function autoplayOff() {
    const t = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (t && Date.now() - lastAutoplayClick > 2000) {
      lastAutoplayClick = Date.now();
      (t.closest('button') || t).click();
    }
    const cancel = document.querySelector('.ytp-autonav-endscreen-upnext-cancel-button');
    if (cancel) cancel.click();
  }

  // ---------- top-left brand: click = home, hold 5s = options gear ----------
  const HOLD_MS = 5000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids) el.appendChild(kid);
    return el;
  }
  const GEAR_PATH = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32' +
    'c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41' +
    'l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58' +
    'c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96' +
    'c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94' +
    'l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6' +
    's1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

  function buildBrand() {
    const ringRect = svg('rect', { class: 'ytf-ring-bar', pathLength: '100', rx: '12', ry: '12' });
    const ringTrack = svg('rect', { class: 'ytf-ring-track', rx: '12', ry: '12' });
    const ring = svg('svg', { class: 'ytf-ring', 'aria-hidden': 'true' }, ringTrack, ringRect);
    const logo = h('a', { id: 'ytf-logo', href: '/', title: 'YouTube Focus', 'aria-label': 'YouTube Focus home' },
      h('span', { class: 'ytf-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'ytf-word' }, 'YouTube', h('span', { class: 'ytf-word-focus', text: 'Focus' })),
      ring);
    const gear = h('button', { id: 'ytf-gear', type: 'button', title: 'YouTube Focus options',
      'aria-label': 'YouTube Focus options', tabindex: '-1' });
    gear.appendChild(svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: GEAR_PATH })));
    const brand = h('div', { id: 'ytf-brand' }, logo, gear);

    let holdTimer = null;
    let hideTimer = null;
    const sizeRing = () => {
      const r = logo.getBoundingClientRect();
      const w = Math.max(0, r.width + 8);
      const ht = Math.max(0, r.height + 8);
      ring.setAttribute('width', w);
      ring.setAttribute('height', ht);
      for (const rect of [ringRect, ringTrack]) {
        rect.setAttribute('x', '1.5'); rect.setAttribute('y', '1.5');
        rect.setAttribute('width', Math.max(0, w - 3)); rect.setAttribute('height', Math.max(0, ht - 3));
      }
    };
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      brand.classList.remove('ytf-charging');
    };
    const reveal = () => {
      holdTimer = null;
      brand.classList.remove('ytf-charging');
      brand.classList.add('ytf-revealed');
      gear.tabIndex = 0;
    };
    const conceal = () => {
      brand.classList.remove('ytf-revealed');
      gear.tabIndex = -1;
    };

    logo.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      if (brand.classList.contains('ytf-revealed') || holdTimer) return;
      sizeRing();
      void ring.getBoundingClientRect(); // start the transition from empty
      brand.classList.add('ytf-charging');
      holdTimer = setTimeout(reveal, HOLD_MS);
    });
    logo.addEventListener('mouseleave', () => { if (holdTimer) cancelHold(); });
    brand.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    brand.addEventListener('mouseleave', () => {
      if (!brand.classList.contains('ytf-revealed')) return;
      hideTimer = setTimeout(conceal, 900);
    });

    // Like YouTube's own logo: go home with a fresh page load.
    logo.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // allow new-tab clicks
      e.preventDefault();
      e.stopPropagation();
      location.assign(location.origin + '/');
    });
    gear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      conceal();
      chrome.runtime.sendMessage({ type: 'open-options' });
    });
    return brand;
  }

  function ensureBrand() {
    const start = document.querySelector('ytd-masthead #start');
    if (!start) return;
    const existing = document.getElementById('ytf-brand');
    if (existing && start.contains(existing)) return;
    if (existing) existing.remove();
    start.appendChild(buildBrand());
  }

  function sweep() {
    if (!document.body) return;
    ensureBrand();
    hideByText();
    if (isWatch()) { autoplayOff(); limitSidebar(); trackPlayer(); }
  }

  let sweepQueued = false;
  function scheduleSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => { sweepQueued = false; sweep(); }, 120);
  }

  // ---------- shelf: drop a video once it is watched to the end ----------
  const trackedVideos = new WeakSet();
  let shelfRemoving = false;

  function currentVideoId() {
    try { return new URL(location.href).searchParams.get('v') || ''; } catch (_) { return ''; }
  }

  async function checkFinished(video, ended) {
    if (shelfRemoving || !isWatch()) return;
    const id = currentVideoId();
    const item = S.shelf.find((x) => x.id === id);
    if (!item) return;
    const player = document.getElementById('movie_player');
    if (player && player.classList.contains('ad-showing')) return; // an ad, not the video
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const expected = Y.parseDuration(item.duration);
    if (expected != null && Math.abs(expected - dur) > 5) return; // some other media is playing
    if (!ended && video.currentTime < dur * 0.97) return;
    shelfRemoving = true;
    try {
      const fresh = Y.withState(await chrome.storage.local.get(null)).shelf;
      await saveShelf(fresh.filter((x) => x.id !== id));
    } finally { shelfRemoving = false; }
  }

  function trackPlayer() {
    const video = document.querySelector('#movie_player video.html5-main-video, #movie_player video');
    if (!video || trackedVideos.has(video)) return;
    trackedVideos.add(video);
    video.addEventListener('timeupdate', () => checkFinished(video, false));
    video.addEventListener('ended', () => checkFinished(video, true));
  }

  // ---------- layout + theme ----------
  // Place the panel right under YouTube's real top bar (its height varies).
  function syncTop() {
    let bottom = 0;
    for (const sel of ['#masthead-container', 'ytd-masthead', '#masthead']) {
      const el = document.querySelector(sel);
      if (el) bottom = Math.max(bottom, Math.round(el.getBoundingClientRect().bottom));
    }
    const top = bottom > 0 && bottom < 200 ? bottom : 56;
    if (html.style.getPropertyValue('--ytf-top') !== top + 'px') html.style.setProperty('--ytf-top', top + 'px');
  }

  // Follow YouTube's own theme setting (Appearance: light / dark / device).
  function syncTheme() {
    let dark = html.hasAttribute('dark');
    if (!dark) {
      const app = document.querySelector('ytd-app');
      const bg = app && getComputedStyle(app).backgroundColor;
      const m = bg && bg.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) > 0)) {
        const [r, g, b] = m.map(Number);
        dark = (0.299 * r + 0.587 * g + 0.114 * b) < 128;
      }
    }
    html.classList.toggle('ytf-dark', dark);
  }

  function syncLook() { syncTop(); syncTheme(); }
  new MutationObserver(syncTheme).observe(html, { attributes: true, attributeFilter: ['dark'] });
  window.addEventListener('resize', syncTop);

  // ---------- routing (YouTube is a single page app) ----------
  function route() {
    html.classList.toggle('ytf-home', isHome());
    html.classList.toggle('ytf-watch', isWatch());
    if (isHome()) { syncLook(); renderHome(); }
    scheduleSweep();
  }

  route(); // run at document_start so the feed never flashes
  window.addEventListener('yt-navigate-finish', route);
  window.addEventListener('yt-page-data-updated', route);
  window.addEventListener('popstate', route);

  whenBody().then(() => {
    new MutationObserver(scheduleSweep).observe(document.body, { childList: true, subtree: true });
    route();
  });

  setInterval(() => {
    // Catches URL changes we missed, keeps the countdown moving, re-checks autoplay.
    const want = isHome();
    if (want !== html.classList.contains('ytf-home')) route();
    if (want) { tick(); syncLook(); }
    if (isWatch()) autoplayOff();
  }, 1000);
})();
