// Run with: node --test tests/logic.test.js
const test = require('node:test');
const assert = require('node:assert');
const Y = require('../shared.js');

const st = (extra) => Y.withState(extra || {});
const v = (id, title, channel = 'Ch' + id, more = {}) =>
  Object.assign({ id, title, channel, duration: '10:00', live: false, short: false }, more);

test('lecture detection', () => {
  const m = Y.makeMatchers(st().settings);
  for (const t of ['MIT Lecture 3: Graphs', 'Lec 12 - Recursion', 'Python Full Course for Beginners',
    'Class 10 Science', 'Week 4 recap', 'Midterm prep', 'Calculus Final Review', 'CS 101 intro', 'EECS281 Project'])
    assert.ok(Y.isLecture(t, m), t);
  for (const t of ['A masterclass in comedy', 'RTX 4090 vs 4080', 'Classic cars explained', '3 hour podcast with a chef'])
    assert.ok(!Y.isLecture(t, m), t);
});

test('serious / fun buckets, unknown is serious', () => {
  const m = Y.makeMatchers(st().settings);
  assert.equal(Y.keywordBucket('Why bridges collapse', m), 'serious');
  assert.equal(Y.keywordBucket('Funniest prank compilation', m), 'fun');
  assert.equal(Y.keywordBucket('My trip to Lisbon', m), 'serious');
});

test('filters shorts, live, lectures, skipped channels; keeps feed order with at most 1 fun', () => {
  const items = [
    v('a', 'Short thing', 'A', { short: true }),
    v('b', 'Live now', 'B', { live: true }),
    v('c', 'Lecture 5', 'C'),
    v('d', 'History of salt', 'Skipme'),
    v('e', 'Prank gone wrong', 'E'),
    v('f', 'Science of sleep', 'F'),
    v('g', 'Long interview, 3 hours', 'G', { duration: '3:12:00' }),
    v('h', 'Meme review', 'H')
  ];
  const picks = Y.pickVideos(items, st({ skipChannels: ['skipme'] }));
  assert.deepEqual(picks.map((p) => p.id), ['e', 'f', 'g']);
  assert.deepEqual(picks.map((p) => p.bucket), ['fun', 'serious', 'serious']);
});

test('fun is never required: a feed whose top is serious gives 3 serious', () => {
  const picks = Y.pickVideos([v('1', 'How X'), v('2', 'Why Y'), v('3', 'Essay Z'), v('4', 'prank')], st());
  assert.deepEqual(picks.map((p) => p.id), ['1', '2', '3']);
});

test('fun capped at max; fills with fun only when nothing else is left', () => {
  const capped = Y.pickVideos([v('1', 'prank'), v('2', 'meme'), v('3', 'How'), v('4', 'Why')], st());
  assert.deepEqual(capped.map((p) => p.id), ['1', '3', '4']);
  const none = Y.pickVideos([v('1', 'prank'), v('2', 'How'), v('3', 'Why'), v('4', 'Essay')], st({ settings: { maxFun: 0 } }));
  assert.deepEqual(none.map((p) => p.id), ['2', '3', '4']);
  const allFun = Y.pickVideos([v('1', 'prank'), v('2', 'meme'), v('3', 'skit')], st());
  assert.equal(allFun.length, 3);
});

test('long music is filtered, short music and long podcasts are kept', () => {
  const items = [
    v('1', '3 Hour Instrumental Music for Work', 'M', { duration: '3:00:12' }),
    v('2', 'Lofi beats to relax to', 'L', { duration: '1:00:00' }),
    v('3', 'New music video', 'N', { duration: '3:45' }),
    v('4', 'A 3 hour podcast with a chef', 'P', { duration: '3:02:00' }),
    v('5', 'Piano mix', 'U', { duration: '' })
  ];
  assert.deepEqual(Y.pickVideos(items, st()).map((p) => p.id), ['3', '4', '5']);
  assert.equal(Y.parseDuration('1:02:03'), 3723);
  assert.equal(Y.explainTitle('Jazz for work', '', st(), '2:00:00').reason, 'music');
});

test('shelf: capped at 5, cleaned, and its videos are never picked', () => {
  const shelf = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, title: 'T' + id, channel: 'C', duration: '10:00' }));
  const s = st({ shelf: shelf.concat([{ id: 'a', title: 'dup' }, { title: 'no id' }]) });
  assert.equal(s.shelf.length, 5);
  const picks = Y.pickVideos([v('a', 'How A'), v('x', 'How X'), v('y', 'Why Y'), v('z', 'Essay Z')], s);
  assert.deepEqual(picks.map((p) => p.id), ['x', 'y', 'z']);
});

test('preview URLs are validated and carried into picks and shelf', () => {
  const good = 'https://i.ytimg.com/an_webp/abcdefghijk/mqdefault_6s.webp?du=3000';
  const picks = Y.pickVideos([v('abcdefghijk', 'How', 'A', { preview: good }), v('b', 'Why', 'B', { preview: 'https://evil.example/x.webp' })], st());
  assert.equal(picks[0].preview, good);
  assert.equal(picks[1].preview, '');
  assert.equal(st({ shelf: [{ id: 'abcdefghijk', title: 't', preview: good }] }).shelf[0].preview, good);
});

test('old serious/fun split settings migrate', () => {
  const s = st({ settings: { seriousCount: 3, funCount: 2 } }).settings;
  assert.equal(s.batchSize, 5);
  assert.equal(s.maxFun, 2);
});

test('channel type override flips the bucket', () => {
  const s = st({ channelTypes: { 'Funny Guy': 'serious' } });
  const picks = Y.pickVideos([v('1', 'prank', 'funny guy'), v('2', 'meme', 'M')], s);
  assert.equal(picks.find((p) => p.id === '1').bucket, 'serious');
});

test('prefers unseen videos', () => {
  const items = [v('1', 'How a'), v('2', 'How b'), v('3', 'How c'), v('4', 'How d'), v('5', 'prank')];
  const picks = Y.pickVideos(items, st({ seen: ['1', '2'] }));
  assert.deepEqual(picks.map((p) => p.id), ['3', '4', '5']);
});

test('lock validity uses current lock time', () => {
  const now = Date.now();
  const lock = { pickedAt: now - 30 * 60000, videos: [{ id: 'x' }] };
  assert.ok(Y.isLockValid(lock, st().settings, now));
  assert.ok(!Y.isLockValid(lock, st({ settings: { lockMinutes: 1 } }).settings, now));
  assert.ok(!Y.isLockValid({ pickedAt: now - 121 * 60000, videos: [{ id: 'x' }] }, st().settings, now));
});

test('main.js extracts home grid items (videoRenderer + lockupViewModel), skips shelves', () => {
  const listeners = {};
  const posted = [];
  const win = {
    addEventListener: (t, f) => { listeners[t] = f; },
    postMessage: (m) => posted.push(m),
    ytInitialData: {
      contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
        { richItemRenderer: { content: { videoRenderer: { videoId: 'v1', title: { runs: [{ text: 'How tides work' }] },
          ownerText: { runs: [{ text: 'Sea' }] }, lengthText: { simpleText: '12:01' } } } } },
        { richItemRenderer: { content: { lockupViewModel: { contentId: 'v2', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          metadata: { lockupMetadataViewModel: { title: { content: 'Prank week' },
            metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Joker' } }] }] } } } },
          contentImage: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [
            { thumbnailBadgeViewModel: { text: '1:02:03' } }] } },
            { animatedThumbnailOverlayViewModel: { thumbnail: { sources: [
              { url: 'https://i.ytimg.com/an_webp/v2v2v2v2v2v/mqdefault_6s.webp?du=3000&sqp=x&rs=y' }] } } }] } } } } } },
        { richItemRenderer: { content: { videoRenderer: { videoId: 'v3', title: { runs: [{ text: 'Live!' }] },
          ownerText: { runs: [{ text: 'L' }] }, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } } } },
        { richSectionRenderer: { content: { richShelfRenderer: { contents: [] } } } }
      ] } } } }] } }
    }
  };
  const fn = new Function('window', 'location', 'document', require('fs').readFileSync(__dirname + '/../main.js', 'utf8'));
  fn(win, { pathname: '/', origin: 'https://www.youtube.com' }, { querySelector: () => null });
  listeners.message({ source: win, data: { source: 'ytfocus-iso', type: 'get-candidates', id: 'q' } });
  const items = posted[0].items;
  assert.equal(items[1].preview, 'https://i.ytimg.com/an_webp/v2v2v2v2v2v/mqdefault_6s.webp?du=3000&sqp=x&rs=y');
  assert.equal(items[0].preview, '');
  assert.deepEqual(items.map((i) => [i.id, i.title, i.channel, i.duration, i.live]), [
    ['v1', 'How tides work', 'Sea', '12:01', false],
    ['v2', 'Prank week', 'Joker', '1:02:03', false],
    ['v3', 'Live!', 'L', '', true]
  ]);
});

test('main.js reads late-loaded feed items (continuation response)', async () => {
  const listeners = {};
  const posted = [];
  let resolveFetch;
  const win = {
    addEventListener: (ty, f) => { listeners[ty] = f; },
    postMessage: (m) => posted.push(m),
    fetch: () => Promise.resolve({ clone: () => ({ json: () => Promise.resolve({
      onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
        { richItemRenderer: { content: { videoRenderer: { videoId: 'late1', title: { runs: [{ text: 'Why cats purr' }] },
          ownerText: { runs: [{ text: 'Cat' }] }, lengthText: { simpleText: '8:00' } } } } },
        { richSectionRenderer: { content: { richShelfRenderer: { contents: [
          { richItemRenderer: { content: { videoRenderer: { videoId: 'shelf', title: { runs: [{ text: 'x' }] }, lengthText: { simpleText: '1:00' } } } } }] } } } }
      ] } }]
    }) }) })
  };
  const fn = new Function('window', 'location', 'document', require('fs').readFileSync(__dirname + '/../main.js', 'utf8'));
  fn(win, { pathname: '/', origin: 'https://www.youtube.com' }, { querySelector: () => null });
  await win.fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false');
  await new Promise((r) => setTimeout(r, 10));
  listeners.message({ source: win, data: { source: 'ytfocus-iso', type: 'get-candidates', id: 'q' } });
  assert.deepEqual(posted[0].items.map((i) => i.id), ['late1']);
  assert.equal(posted[0].sources.later, 1);
});

test('main.js flags the "Try searching" nudge', () => {
  const listeners = {};
  const posted = [];
  const win = { addEventListener: (ty, f) => { listeners[ty] = f; }, postMessage: (m) => posted.push(m),
    ytInitialData: { contents: { richGridRenderer: { contents: [{ richSectionRenderer: { content: { feedNudgeRenderer: {} } } }] } } } };
  const fn = new Function('window', 'location', 'document', require('fs').readFileSync(__dirname + '/../main.js', 'utf8'));
  fn(win, { pathname: '/', origin: 'https://www.youtube.com' }, { querySelector: () => null });
  listeners.message({ source: win, data: { source: 'ytfocus-iso', type: 'get-candidates', id: 'q' } });
  assert.equal(posted[0].items.length, 0);
  assert.equal(posted[0].nudge, true);
});
