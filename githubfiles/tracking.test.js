'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadConfig } = require('../src/config');
const { openStore } = require('../src/db');
const { createApp } = require('../src/app');

const BASE_ENV = {
  TELEGRAM_URL: 'https://t.me/example_channel',
  CAMPAIGN_ID: 'test',
  ALLOWED_CAMPAIGNS: 'test,spring',
  HASH_SECRET: 'unit-test-secret-0123456789abcdef',
  RATE_LIMIT_IP_PER_MIN: '100000',
  RATE_LIMIT_VISITOR_PER_MIN: '100000',
};

async function startServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgj-'));
  const config = loadConfig({ ...BASE_ENV, DATABASE_PATH: path.join(dir, 't.sqlite'), ...overrides }, dir);
  const store = openStore(config.dbPath);
  const app = createApp(config, store);
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    store,
    base,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const newId = () => crypto.randomUUID();

function post(base, body, headers = {}) {
  return fetch(`${base}/api/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const click = (visitorId, extra = {}) => ({
  visitorId,
  clickId: newId(),
  campaign: 'test',
  button: 'hero',
  ...extra,
});

async function getStats(base, campaign = 'test') {
  const res = await fetch(`${base}/api/stats?campaign=${campaign}`);
  assert.equal(res.status, 200);
  return res.json();
}

/* ------------------------------------------------------------------ */

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  await srv.close();
});

test('landing page serves an untouched Telegram link on both buttons', async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await res.text();

  const links = html.match(/<a class="btn"[^>]*>/g) || [];
  assert.equal(links.length, 2, 'hero and footer Join buttons');
  for (const tag of links) {
    assert.ok(tag.includes(`href="${srv.config.telegramUrl}"`), 'real Telegram href');
    assert.ok(tag.includes('target="_blank"'));
    assert.ok(tag.includes('rel="noopener noreferrer"'));
    assert.ok(tag.includes('data-join'));
  }
  assert.ok(!html.includes('{{'), 'all template placeholders were filled');
  assert.ok(!html.includes('connect.facebook.net'), 'Pixel is absent when no ID is configured');
});

test('repeated and concurrent clicks from one visitor create exactly ONE unique record', async () => {
  const visitor = newId();

  // 25 sequential clicks...
  let uniqueFlags = 0;
  for (let i = 0; i < 25; i++) {
    const res = await post(srv.base, click(visitor));
    assert.equal(res.status, 200);
    const body = await res.json();
    if (body.newUniqueVisitor) uniqueFlags += 1;
  }
  // ...plus 100 simultaneous ones (alternating buttons).
  const burst = await Promise.all(
    Array.from({ length: 100 }, (_, i) => post(srv.base, click(visitor, { button: i % 2 ? 'footer' : 'hero' })))
  );
  for (const res of burst) {
    assert.equal(res.status, 200);
    if ((await res.json()).newUniqueVisitor) uniqueFlags += 1;
  }

  assert.equal(uniqueFlags, 1, 'only the very first click may report a new unique visitor');

  const stats = await getStats(srv.base);
  assert.equal(stats.totalClicks, 125);
  assert.equal(stats.uniqueVisitors, 1);
  assert.equal(stats.clicksByButton.hero + stats.clicksByButton.footer, 125);

  // Look straight at the database.
  const uniqueRows = srv.store.db.prepare('SELECT visitor_hash FROM unique_clicks WHERE campaign = ?').all('test');
  assert.equal(uniqueRows.length, 1);
  assert.notEqual(uniqueRows[0].visitor_hash, visitor, 'raw visitor ID is never stored');
  assert.match(uniqueRows[0].visitor_hash, /^[0-9a-f]{64}$/);
  const eventRows = srv.store.db.prepare('SELECT COUNT(*) AS n FROM click_events WHERE campaign = ?').get('test');
  assert.equal(Number(eventRows.n), 125);
});

test('the database itself rejects a second unique row for the same visitor and campaign', () => {
  const insert = srv.store.db.prepare('INSERT INTO unique_clicks (campaign, visitor_hash) VALUES (?, ?)');
  const hash = srv.store.db.prepare('SELECT visitor_hash FROM unique_clicks LIMIT 1').get().visitor_hash;
  assert.throws(() => insert.run('test', hash), /UNIQUE|constraint/i);
});

test('retrying the same click_id is idempotent', async () => {
  const before = await getStats(srv.base);
  const payload = click(newId());
  const first = await (await post(srv.base, payload)).json();
  const retry = await (await post(srv.base, payload)).json();
  const retry2 = await (await post(srv.base, payload)).json();
  assert.equal(first.duplicate, false);
  assert.equal(first.newUniqueVisitor, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry2.duplicate, true);

  const after = await getStats(srv.base);
  assert.equal(after.totalClicks, before.totalClicks + 1);
  assert.equal(after.uniqueVisitors, before.uniqueVisitors + 1);
});

test('different visitors and different campaigns are counted separately', async () => {
  const a = newId();
  const b = newId();
  await post(srv.base, click(a, { campaign: 'spring' }));
  await post(srv.base, click(b, { campaign: 'spring' }));
  await post(srv.base, click(a, { campaign: 'spring' }));
  const spring = await getStats(srv.base, 'spring');
  assert.equal(spring.totalClicks, 3);
  assert.equal(spring.uniqueVisitors, 2);

  // Same visitor on another campaign is a separate unique record.
  await post(srv.base, click(a, { campaign: 'test' }));
  const rows = srv.store.db.prepare('SELECT COUNT(*) AS n FROM unique_clicks WHERE campaign = ?');
  assert.equal(Number(rows.get('spring').n), 2);
});

test('public stats expose aggregates only, never visitor identifiers', async () => {
  const visitor = newId();
  await post(srv.base, click(visitor));
  const res = await fetch(`${srv.base}/api/stats`);
  const text = await res.text();
  const hash = crypto.createHmac('sha256', srv.config.hashSecret).update(visitor).digest('hex');
  assert.ok(!text.includes(visitor));
  assert.ok(!text.includes(hash));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
    'campaign', 'clicksByButton', 'generatedAt', 'ok', 'totalClicks', 'uniqueVisitors',
  ]);
});

test('invalid input is rejected with clear errors', async () => {
  const cases = [
    ['short visitor id', click('short'), 400],
    ['bad characters in click id', click(newId(), { clickId: 'has spaces and !! chars' }), 400],
    ['unknown campaign', click(newId(), { campaign: 'nope' }), 400],
    ['unknown button', click(newId(), { button: 'sidebar' }), 400],
    ['array body', '[]', 400],
    ['malformed JSON', '{not json', 400],
    ['oversized body', JSON.stringify({ pad: 'x'.repeat(5000) }), 413],
  ];
  for (const [label, body, status] of cases) {
    const res = await post(srv.base, body);
    assert.equal(res.status, status, label);
    const json = await res.json();
    assert.equal(json.ok, false, label);
    assert.ok(json.error.code && json.error.message, label);
  }

  const wrongType = await fetch(`${srv.base}/api/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=b',
  });
  assert.equal(wrongType.status, 415);

  const wrongMethod = await fetch(`${srv.base}/api/track`);
  assert.equal(wrongMethod.status, 405);

  const crossOrigin = await post(srv.base, click(newId()), { origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403);
});

test('SQL injection strings are treated as plain data and rejected by validation', async () => {
  const res = await post(srv.base, click(newId(), { campaign: "test'; DROP TABLE unique_clicks;--" }));
  assert.equal(res.status, 400);
  const still = srv.store.db.prepare('SELECT COUNT(*) AS n FROM unique_clicks').get();
  assert.ok(Number(still.n) > 0, 'tables still exist');
});

test('rate limiting returns 429 with Retry-After', async () => {
  const limited = await startServer({ RATE_LIMIT_IP_PER_MIN: '3' });
  try {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 5; i++) {
      const res = await post(limited.base, click(newId()));
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.ok(Number(retryAfter) >= 1);
  } finally {
    await limited.close();
  }
});

test('stats can be protected with a bearer token', async () => {
  const guarded = await startServer({ STATS_TOKEN: 'a-long-enough-test-token' });
  try {
    assert.equal((await fetch(`${guarded.base}/api/stats`)).status, 401);
    const ok = await fetch(`${guarded.base}/api/stats`, {
      headers: { authorization: 'Bearer a-long-enough-test-token' },
    });
    assert.equal(ok.status, 200);
  } finally {
    await guarded.close();
  }
});

test('Meta Pixel is only wired in when a numeric ID is configured', async () => {
  const withPixel = await startServer({ META_PIXEL_ID: '123456789012345' });
  try {
    const res = await fetch(`${withPixel.base}/`);
    assert.match(res.headers.get('content-security-policy'), /connect\.facebook\.net/);
    const html = await res.text();
    assert.ok(html.includes('data-pixel-id="123456789012345"'));
    assert.ok(html.includes('id=123456789012345&amp;ev=PageView&amp;noscript=1'));
  } finally {
    await withPixel.close();
  }
  assert.throws(() => loadConfig({ ...BASE_ENV, META_PIXEL_ID: '12abc' }), /META_PIXEL_ID/);
});

test('config rejects unsafe Telegram URLs and missing secrets', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, TELEGRAM_URL: 'javascript:alert(1)' }), /TELEGRAM_URL/);
  assert.throws(() => loadConfig({ ...BASE_ENV, TELEGRAM_URL: 'http://t.me/x' }), /TELEGRAM_URL/);
  assert.throws(() => loadConfig({ ...BASE_ENV, TELEGRAM_URL: 'https://evil.example/x' }), /TELEGRAM_URL/);
  assert.throws(() => loadConfig({ ...BASE_ENV, HASH_SECRET: '' }), /HASH_SECRET/);
});

/* ------------------------------------------------------------------ *
 * Run the real public/app.js in a fake browser and click the real
 * Join button handler against the real server.
 * ------------------------------------------------------------------ */

function makeBrowser(base, { offline = false } = {}) {
  const pending = [];
  const listeners = {};
  const storage = new Map();
  const button = {
    getAttribute: (name) => (name === 'data-button' ? 'hero' : null),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  const sandbox = {
    console, URLSearchParams, Blob, crypto,
    location: { search: '?c=spring', protocol: 'http:' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    document: {
      readyState: 'complete',
      cookie: '',
      body: {
        dataset: { campaign: 'test', campaigns: 'test,spring', trackUrl: '/api/track', pixelId: '', pixelEvent: 'TelegramJoinClick' },
      },
      head: { appendChild() {} },
      createElement: () => ({}),
      querySelectorAll: () => [button],
      addEventListener() {},
    },
    navigator: {
      sendBeacon: (url, blob) => {
        if (offline) throw new Error('offline');
        pending.push(
          blob.text().then((text) =>
            fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
          )
        );
        return true;
      },
    },
    fetch: (url, options) => (offline ? Promise.reject(new Error('offline')) : fetch(base + url, options)),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), sandbox);

  return {
    storage,
    /** Simulates a user clicking Join. Returns whether the page tried to block the link. */
    clickJoin() {
      let prevented = false;
      const event = { button: 0, preventDefault: () => { prevented = true; } };
      for (const fn of listeners.click) fn(event);
      return { prevented };
    },
    settle: () => Promise.all(pending),
  };
}

test('browser script: 1,000 clicks from one browser = 1 unique visitor, and the link is never blocked', async () => {
  const before = await getStats(srv.base, 'spring');
  const browser = makeBrowser(srv.base);

  for (let i = 0; i < 1000; i++) {
    // Space the burst out so the per-minute limits (raised in this test server) are irrelevant.
    const { prevented } = browser.clickJoin();
    assert.equal(prevented, false, 'preventDefault must never be called, so Telegram always opens');
  }
  await browser.settle();

  const visitorId = browser.storage.get('tgj_vid');
  assert.match(visitorId, /^[A-Za-z0-9_-]{16,64}$/, 'a persistent random visitor ID was stored');

  const after = await getStats(srv.base, 'spring');
  assert.equal(after.totalClicks - before.totalClicks, 1000);
  assert.equal(after.uniqueVisitors - before.uniqueVisitors, 1);

  // Same person, cleared storage (or another browser): counted again. This is the documented limitation.
  const freshBrowser = makeBrowser(srv.base);
  freshBrowser.clickJoin();
  await freshBrowser.settle();
  const final = await getStats(srv.base, 'spring');
  assert.equal(final.uniqueVisitors - before.uniqueVisitors, 2);
});

test('browser script: link still works when tracking is completely unavailable', () => {
  const offline = makeBrowser(srv.base, { offline: true });
  let result;
  assert.doesNotThrow(() => {
    result = offline.clickJoin();
  });
  assert.equal(result.prevented, false);
});
