(() => {
  'use strict';
  const Y = globalThis.YTF;
  const $ = (id) => document.getElementById(id);
  let S = Y.withState({});

  const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

  function setStatus(msg) {
    $('status').textContent = msg;
    clearTimeout(setStatus.t);
    setStatus.t = setTimeout(() => { $('status').textContent = ''; }, 3000);
  }

  function renderBatch() {
    const box = $('batch');
    box.replaceChildren();
    const lock = S.lock;
    if (!lock || !lock.videos.length) {
      box.textContent = 'No batch yet. One is picked the next time you open the YouTube home page.';
      return;
    }
    const expires = Y.lockExpiry(lock, S.settings);
    const left = expires - Date.now();
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = left > 0
      ? `Picked ${new Date(lock.pickedAt).toLocaleString()}. Next batch in ${Y.formatRemaining(left)} (at ${new Date(expires).toLocaleTimeString()}).`
      : 'Expired. A new batch is picked on the next home page visit.';
    const ol = document.createElement('ol');
    for (const v of lock.videos) {
      const li = document.createElement('li');
      li.textContent = `${v.title} — ${v.channel} `;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `[${v.bucket}]`;
      li.appendChild(tag);
      ol.appendChild(li);
    }
    box.append(p, ol);
  }

  function fill() {
    const s = S.settings;
    $('lockMinutes').value = s.lockMinutes;
    $('batchSize').value = s.batchSize;
    $('maxFun').value = s.maxFun;
    $('lectureKeywords').value = s.lectureKeywords.join('\n');
    $('musicMinMinutes').value = s.musicMinMinutes;
    $('musicKeywords').value = s.musicKeywords.join('\n');
    $('seriousKeywords').value = s.seriousKeywords.join('\n');
    $('funKeywords').value = s.funKeywords.join('\n');
    $('skipChannels').value = S.skipChannels.join('\n');
    $('channelTypes').value = Object.entries(S.channelTypes).map(([n, t]) => `${n} = ${t}`).join('\n');
    renderBatch();
    runTest();
  }

  async function load() {
    S = Y.withState(await chrome.storage.local.get(null));
    fill();
  }

  function parseTypes(text) {
    const out = {};
    const bad = [];
    for (const line of lines(text)) {
      const i = line.lastIndexOf('=');
      const name = i > 0 ? line.slice(0, i).trim() : '';
      const t = i > 0 ? line.slice(i + 1).trim().toLowerCase() : '';
      if (name && (t === 'fun' || t === 'serious')) out[name] = t;
      else bad.push(line);
    }
    return { out, bad };
  }

  function badRegexLines(list) {
    return list.filter((l) => /^\/.+\/[a-z]*$/.test(l) && !Y.compileKeyword(l));
  }

  async function save() {
    const lockMinutes = Number($('lockMinutes').value);
    const batchSize = Number($('batchSize').value);
    const maxFun = Number($('maxFun').value);
    if (!(lockMinutes > 0)) return setStatus('Lock time must be more than 0 minutes.');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) {
      return setStatus('Videos per batch must be a whole number from 1 to 10.');
    }
    if (!Number.isInteger(maxFun) || maxFun < 0 || maxFun > batchSize) {
      return setStatus('Max fun videos must be a whole number from 0 to the batch size.');
    }
    const kw = {
      lectureKeywords: lines($('lectureKeywords').value),
      seriousKeywords: lines($('seriousKeywords').value),
      funKeywords: lines($('funKeywords').value),
      musicKeywords: lines($('musicKeywords').value)
    };
    const musicMinMinutes = Number($('musicMinMinutes').value);
    if (!(musicMinMinutes >= 0)) return setStatus('Music minimum length must be 0 or more minutes.');
    const badRe = Object.values(kw).flatMap(badRegexLines);
    if (badRe.length) return setStatus('Invalid regex: ' + badRe.join(', '));
    const types = parseTypes($('channelTypes').value);
    if (types.bad.length) return setStatus('Could not read channel type line: ' + types.bad[0]);

    await chrome.storage.local.set({
      settings: Object.assign({ lockMinutes, batchSize, maxFun, musicMinMinutes }, kw),
      skipChannels: lines($('skipChannels').value),
      channelTypes: types.out
    });
    await load();
    setStatus('Saved.');
  }

  function runTest() {
    const title = $('testTitle').value.trim();
    if (!title) { $('testResult').textContent = ''; return; }
    const r = Y.explainTitle(title, $('testChannel').value.trim(), S, $('testDuration').value.trim());
    $('testResult').textContent = r.reason === 'lecture' ? 'Filtered out as a lecture.'
      : r.reason === 'music' ? 'Filtered out as long music.' : `Counts as ${r.bucket}.`;
  }

  $('save').addEventListener('click', save);
  $('resetKeywords').addEventListener('click', () => {
    $('lectureKeywords').value = Y.DEFAULTS.lectureKeywords.join('\n');
    $('seriousKeywords').value = Y.DEFAULTS.seriousKeywords.join('\n');
    $('funKeywords').value = Y.DEFAULTS.funKeywords.join('\n');
    $('musicKeywords').value = Y.DEFAULTS.musicKeywords.join('\n');
    setStatus('Defaults restored. Press Save to keep them.');
  });
  $('newBatch').addEventListener('click', async () => {
    await chrome.storage.local.remove('lock');
    await load();
    setStatus('Batch cleared. Open or refresh the YouTube home page.');
  });
  $('clearSeen').addEventListener('click', async () => {
    await chrome.storage.local.set({ seen: [] });
    setStatus('Seen history cleared.');
  });
  $('testTitle').addEventListener('input', runTest);
  $('testChannel').addEventListener('input', runTest);
  $('testDuration').addEventListener('input', runTest);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // Only refresh the read-only parts so unsaved edits are not overwritten.
    S = Y.withState(await chrome.storage.local.get(null));
    renderBatch();
  });
  setInterval(renderBatch, 1000);

  load();
})();
