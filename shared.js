// Shared logic used by the content script, the options page and the Node tests.
// Pure functions only: no DOM, no chrome.* calls.
(function (root) {
  'use strict';

  const DEFAULTS = {
    lockMinutes: 120,
    batchSize: 3,
    // Fun is optional: never required, at most this many per batch.
    maxFun: 1,
    // Plain lines match as whole words/phrases (case-insensitive).
    // Lines written as /pattern/flags are regular expressions.
    lectureKeywords: [
      'lecture',
      '/\\blec(ture)?\\.?\\s*#?\\d+/i',
      'full course',
      'class',
      '/\\bweek\\s*#?\\d+/i',
      'midterm',
      'final review',
      '/\\b[A-Z]{2,5}\\s?-?\\d{3}[A-Z]?\\b/'
    ],
    seriousKeywords: [
      'explained', 'explainer', 'why', 'how', 'history', 'science', 'analysis',
      'documentary', 'essay', 'interview', 'podcast', 'deep dive', 'investigation',
      'conversation', 'debate', 'story of'
    ],
    funKeywords: [
      'funny', 'prank', 'pranks', 'meme', 'memes', 'reacts', 'reaction', 'reacting',
      'compilation', 'challenge', 'skit', 'fails', 'bloopers', 'parody', 'try not to laugh'
    ],
    // Videos at least this long whose title matches a music keyword are filtered out.
    musicMinMinutes: 60,
    musicKeywords: [
      'music', 'instrumental', 'lofi', 'lo-fi', 'beats', 'playlist', 'mix', 'songs',
      'soundtrack', 'ost', 'piano', 'jazz', 'ambient', 'chill', 'relaxing', 'study music',
      'work music', 'focus music', 'sleep music', 'radio'
    ]
  };

  const SEEN_LIMIT = 200;
  const SHELF_LIMIT = 5;

  function cleanPreview(u) {
    const s = String(u || '');
    return /^https:\/\/i\.ytimg\.com\/an_webp\/[A-Za-z0-9_-]{11}\//.test(s) ? s : '';
  }

  function normChannel(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Turn one keyword line into a RegExp (or null if blank/invalid).
  function compileKeyword(line) {
    const k = String(line || '').trim();
    if (!k) return null;
    const m = k.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try {
        return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      } catch (_) {
        return null;
      }
    }
    const body = escapeRe(k).replace(/\s+/g, '\\s+');
    return new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'iu');
  }

  function compileList(list) {
    return (list || []).map(compileKeyword).filter(Boolean);
  }

  function countMatches(title, regs) {
    let n = 0;
    for (const r of regs) if (r.test(title)) n++;
    return n;
  }

  function cleanList(list) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(list) ? list : []) {
      const s = String(v || '').trim();
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  // Merge stored data with defaults so every field is always present and sane.
  function withState(stored) {
    const d = stored || {};
    const raw = Object.assign({}, d.settings || {});
    // Older versions stored a fixed serious/fun split.
    if (raw.batchSize == null && raw.seriousCount != null) raw.batchSize = Number(raw.seriousCount) + Number(raw.funCount || 0);
    if (raw.maxFun == null && raw.funCount != null) raw.maxFun = raw.funCount;
    delete raw.seriousCount;
    delete raw.funCount;
    const s = Object.assign({}, DEFAULTS, raw);
    const lock = Number(s.lockMinutes);
    s.lockMinutes = Number.isFinite(lock) && lock > 0 ? lock : DEFAULTS.lockMinutes;
    s.batchSize = clampInt(s.batchSize, 1, 10, DEFAULTS.batchSize);
    s.maxFun = clampInt(s.maxFun, 0, s.batchSize, Math.min(DEFAULTS.maxFun, s.batchSize));
    const mm = Number(s.musicMinMinutes);
    s.musicMinMinutes = Number.isFinite(mm) && mm >= 0 ? mm : DEFAULTS.musicMinMinutes;
    for (const k of ['lectureKeywords', 'seriousKeywords', 'funKeywords', 'musicKeywords']) {
      s[k] = Array.isArray(s[k]) ? cleanList(s[k]) : DEFAULTS[k].slice();
    }
    const types = {};
    if (d.channelTypes && typeof d.channelTypes === 'object') {
      for (const [name, t] of Object.entries(d.channelTypes)) {
        if (name.trim() && (t === 'serious' || t === 'fun')) types[name.trim()] = t;
      }
    }
    const shelf = [];
    const shelfIds = new Set();
    for (const v of Array.isArray(d.shelf) ? d.shelf : []) {
      if (!v || typeof v.id !== 'string' || !v.id || shelfIds.has(v.id) || shelf.length >= SHELF_LIMIT) continue;
      shelfIds.add(v.id);
      shelf.push({ id: v.id, title: String(v.title || ''), channel: String(v.channel || ''),
        duration: String(v.duration || ''), preview: cleanPreview(v.preview), addedAt: Number(v.addedAt) || 0 });
    }
    return {
      settings: s,
      shelf,
      skipChannels: cleanList(d.skipChannels),
      channelTypes: types,
      lock: d.lock && Array.isArray(d.lock.videos) ? d.lock : null,
      seen: cleanList(d.seen).slice(0, SEEN_LIMIT)
    };
  }

  function typeOverride(channel, channelTypes) {
    const n = normChannel(channel);
    for (const [name, t] of Object.entries(channelTypes || {})) {
      if (normChannel(name) === n) return t;
    }
    return null;
  }

  function isSkipped(channel, skipChannels) {
    const n = normChannel(channel);
    return (skipChannels || []).some((c) => normChannel(c) === n);
  }

  function makeMatchers(settings) {
    return {
      lecture: compileList(settings.lectureKeywords),
      music: compileList(settings.musicKeywords),
      serious: compileList(settings.seriousKeywords),
      fun: compileList(settings.funKeywords)
    };
  }

  function isLecture(title, matchers) {
    return matchers.lecture.some((r) => r.test(title));
  }

  // Keyword-only classification (no channel overrides).
  // More fun matches than serious matches => fun. Everything else, including unknown => serious.
  function keywordBucket(title, matchers) {
    const fun = countMatches(title, matchers.fun);
    const serious = countMatches(title, matchers.serious);
    return fun > serious ? 'fun' : 'serious';
  }

  function classify(video, state, matchers) {
    return typeOverride(video.channel, state.channelTypes) || keywordBucket(video.title, matchers);
  }

  // "1:02:03" / "45:10" -> seconds; unknown -> null.
  function parseDuration(text) {
    const t = String(text || '').trim();
    if (!/^\d{1,3}(:\d{2}){1,2}$/.test(t)) return null;
    return t.split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
  }

  // Long background music (e.g. "3 hour instrumental for work").
  // Needs a known duration: videos with unknown length are never filtered by this.
  function isLongMusic(title, duration, matchers, settings) {
    const sec = parseDuration(duration);
    if (sec == null || sec < settings.musicMinMinutes * 60) return false;
    return matchers.music.some((r) => r.test(title));
  }

  // Explains why a title would be filtered or bucketed. Used by the options page tester.
  function explainTitle(title, channel, state, duration) {
    const m = makeMatchers(state.settings);
    if (isLecture(title, m)) return { reason: 'lecture', bucket: null };
    if (isLongMusic(title, duration, m, state.settings)) return { reason: 'music', bucket: null };
    return { reason: null, bucket: classify({ title, channel }, state, m) };
  }

  // items: [{id, title, channel, duration, live, short}] in YouTube's feed order.
  // Returns up to batchSize videos in feed order, each with a `bucket` field.
  // Fun videos are never required: one is included only when YouTube ranks it
  // high enough, and at most maxFun of them (unless there is nothing else to show).
  function pickVideos(items, state) {
    const settings = state.settings;
    const m = makeMatchers(settings);
    // Videos already on the shelf are never picked again.
    const byId = new Set((state.shelf || []).map((v) => v.id));
    const pool = [];
    for (const v of items || []) {
      if (!v || !v.id || !v.title || byId.has(v.id)) continue;
      byId.add(v.id);
      if (v.short || v.live) continue;
      if (isLecture(v.title, m)) continue;
      if (isLongMusic(v.title, v.duration, m, settings)) continue;
      if (isSkipped(v.channel, state.skipChannels)) continue;
      pool.push({
        id: String(v.id),
        title: String(v.title),
        channel: String(v.channel || ''),
        duration: String(v.duration || ''),
        preview: cleanPreview(v.preview),
        bucket: classify(v, state, m)
      });
    }

    // Prefer videos not shown in recent batches; fall back to seen ones if needed.
    const seen = new Set(state.seen || []);
    const ordered = pool.filter((v) => !seen.has(v.id)).concat(pool.filter((v) => seen.has(v.id)));

    const out = [];
    const usedIds = new Set();
    const usedCh = new Set();
    let funUsed = 0;
    // Passes: distinct channels + fun cap, repeats allowed + fun cap,
    // then (only if still short) any remaining video so the batch stays full.
    const passes = [
      { distinct: true, capFun: true },
      { distinct: false, capFun: true },
      { distinct: false, capFun: false }
    ];
    for (const p of passes) {
      for (const v of ordered) {
        if (out.length >= settings.batchSize) return out;
        if (usedIds.has(v.id)) continue;
        if (p.distinct && usedCh.has(normChannel(v.channel))) continue;
        if (p.capFun && v.bucket === 'fun' && funUsed >= settings.maxFun) continue;
        out.push(v);
        usedIds.add(v.id);
        usedCh.add(normChannel(v.channel));
        if (v.bucket === 'fun') funUsed++;
      }
    }
    return out;
  }

  function lockExpiry(lock, settings) {
    return Number(lock.pickedAt) + settings.lockMinutes * 60 * 1000;
  }

  function isLockValid(lock, settings, now) {
    return !!(lock && lock.videos && lock.videos.length && Number(lock.pickedAt) <= now &&
      now < lockExpiry(lock, settings));
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  const api = {
    DEFAULTS, SEEN_LIMIT, SHELF_LIMIT, cleanPreview, normChannel, compileKeyword, withState, typeOverride, isSkipped,
    makeMatchers, isLecture, isLongMusic, parseDuration, keywordBucket, classify, explainTitle, pickVideos,
    lockExpiry, isLockValid, formatRemaining
  };
  root.YTF = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
