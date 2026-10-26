# Telegram Join Landing Page

A fast, responsive landing page with a **Join on Telegram** button, plus a small
Node.js + SQLite backend that counts **total clicks** and **unique visitors who
clicked**, as two separate metrics. This is an original implementation inspired by
the general layout and flow of a typical "join link" page; it contains no third-party
code, branding or private backend functionality.

**Zero npm dependencies.** It uses Node's built-in `node:sqlite`, so `npm install`
is not needed. Requires **Node.js 22.13 or newer**.

## Project structure

```
telegram-join-landing/
├── package.json              scripts: start, dev, test, gen-secret
├── .env.example              all configuration, documented
├── .gitignore
├── server.js                 entry point (HTTP server, timeouts, graceful shutdown)
├── src/
│   ├── config.js             env parsing + strict validation (fails fast at boot)
│   ├── db.js                 SQLite schema, atomic idempotent click recording, stats
│   ├── rateLimit.js          in-memory rate limiter
│   └── app.js                routes, validation, security headers, static files
├── public/
│   ├── index.html            page template (server fills {{placeholders}})
│   ├── styles.css            mobile-first styles
│   ├── app.js                visitor ID, click tracking, optional Meta Pixel
│   └── favicon.svg
├── test/
│   └── tracking.test.js      14 tests (see "Testing")
└── data/                     SQLite file is created here at first start
```

## Quick start (local)

```bash
cd telegram-join-landing
cp .env.example .env
npm run gen-secret          # copy the output into HASH_SECRET in .env
# edit .env: set TELEGRAM_URL=https://t.me/your_channel and HASH_SECRET=...
npm start
```

Open <http://localhost:3000>. Click the button, then check
<http://localhost:3000/api/stats>.

## Configuration

All settings are environment variables (see `.env.example`). Nothing secret is
hardcoded, and the server refuses to start with an invalid or missing required value.

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_URL` | required | Join link. Must be `https` on `t.me`, `telegram.me` or `telegram.dog` |
| `HASH_SECRET` | required | Secret for hashing visitor IDs (16+ chars). Keep it stable |
| `CAMPAIGN_ID` | `main` | Default campaign name stored with each click |
| `ALLOWED_CAMPAIGNS` | empty | Extra campaigns, e.g. `spring-ad,newsletter`. Use `/?c=spring-ad` |
| `SITE_TITLE`, `SITE_HEADLINE`, `SITE_DESCRIPTION` | sensible text | Page copy |
| `DATABASE_PATH` | `./data/tracking.sqlite` | SQLite file |
| `STATS_TOKEN` | empty | If set, `/api/stats` needs `Authorization: Bearer <token>` |
| `RATE_LIMIT_IP_PER_MIN` | `60` | Per-IP limit for `POST /api/track` |
| `RATE_LIMIT_VISITOR_PER_MIN` | `20` | Per-visitor limit for `POST /api/track` |
| `ALLOWED_ORIGINS` | empty | Extra browser origins allowed to call the API |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the client IP (only behind your own proxy) |
| `META_PIXEL_ID` | empty | Numeric Pixel ID. Empty means no Meta script is loaded at all |
| `META_PIXEL_CLICK_EVENT` | `TelegramJoinClick` | Event name sent on Join click |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Listen address |

## How unique tracking works

1. On the first Join click the browser creates a random ID (`crypto.randomUUID()`),
   saves it in `localStorage` and mirrors it in a first-party cookie (1 year).
2. Every click sends `{ visitorId, clickId, campaign, button }` using
   `navigator.sendBeacon` (falling back to `fetch` with `keepalive`). The click handler
   **never calls `preventDefault`**, so the link to Telegram always opens, whether or not
   tracking succeeds, is rate limited or the visitor was already counted.
3. The server validates the payload and stores only `HMAC-SHA256(HASH_SECRET, visitorId)`.
4. In one `BEGIN IMMEDIATE` transaction it runs two `INSERT OR IGNORE` statements:

   | Table | Constraint | Meaning |
   |---|---|---|
   | `click_events` | `click_id UNIQUE` | **Total clicks.** A retried request with the same `clickId` is ignored, so requests are idempotent |
   | `unique_clicks` | `PRIMARY KEY (campaign, visitor_hash)` | **Unique visitors.** Whether someone clicks 10, 1,000 or 10,000 times there is still one row |

Concurrent requests cannot create duplicates: the primary key is enforced by SQLite
itself, and the write transaction serialises writers. A busy database returns `503`
with `Retry-After`; unexpected errors return a generic `500` and are logged without
request data.

## API

### `POST /api/track`

```bash
curl -X POST http://localhost:3000/api/track \
  -H 'Content-Type: application/json' \
  -d '{"visitorId":"3f1c9a52-6d0e-4a7b-9c1d-2e8f5b7a4c10",
       "clickId":"b7d2f0aa-1c34-4e55-8f06-9a1b2c3d4e5f",
       "campaign":"main","button":"hero"}'
```

Success: `200 {"ok":true,"duplicate":false,"newUniqueVisitor":true}`

Errors use `{"ok":false,"error":{"code","message","details?"}}`:
`400` invalid input, `403` origin not allowed, `405` wrong method, `413` body over
2 KB, `415` wrong content type, `429` rate limited (with `Retry-After`), `503` database
busy, `500` internal error.

### `GET /api/stats?campaign=main`

```json
{"ok":true,"campaign":"main","totalClicks":125,"uniqueVisitors":1,
 "clicksByButton":{"footer":50,"hero":75},"generatedAt":"2026-10-26T04:50:21.962Z"}
```

Aggregates only. Visitor IDs and their hashes are never returned. Set `STATS_TOKEN` if
you do not want the counts to be public. `GET /healthz` returns `{"ok":true}`.

## Abuse prevention

Strict validation (types, patterns, allow-listed campaigns and buttons), 2 KB body
limit, content-type check, same-origin check on `POST`, per-IP and per-visitor rate
limits, parameterised SQL only, a Content-Security-Policy that blocks everything but
the page's own files (plus Meta's hosts only when a Pixel is configured), request
timeouts, and static-file serving that blocks traversal and dotfiles.

## Meta Pixel

Set `META_PIXEL_ID` to enable it. When set, the page loads Meta's `fbevents.js`, calls
`PageView` on load, and sends one **custom** event (`TelegramJoinClick` by default) when
Join is clicked. This is reported by Meta's own code and is completely separate from the
SQLite metrics; the two numbers will not match (ad blockers, consent choices and
network failures affect them differently).

- A click is **not** a confirmed join. Telegram does not tell this page whether the
  visitor pressed Join, so the event is named for what happened (a click). Avoid mapping
  it to `Lead` or `Subscribe` unless you accept that ad optimisation will treat clicks
  as conversions.
- Nothing personal is sent: no advanced matching data, and `autoConfig` is turned off so
  Meta does not scrape button text or form fields. Meta still receives what any browser
  request reveals (IP address, user agent, its own `_fbp` cookie). The page footer says so.

## Testing

```bash
npm test
```

The suite starts a real server on a temporary SQLite file and checks, among others:

- The page's two buttons carry the real Telegram `href`, `target="_blank"`, `rel="noopener noreferrer"`.
- **25 sequential + 100 concurrent clicks from one visitor** give `totalClicks = 125`,
  `uniqueVisitors = 1`, exactly one row in `unique_clicks`, and only one response ever says `newUniqueVisitor: true`.
- SQLite itself rejects a second `unique_clicks` row for the same visitor/campaign.
- Retrying the same `clickId` changes nothing.
- **The real `public/app.js` runs in a simulated browser: 1,000 clicks give 1 unique
  visitor, and `preventDefault` is never called** so the Join link stays usable. With
  the network completely down, the click handler does not throw and still does not block the link.
- Clearing storage (a fresh browser) is counted as a new visitor, demonstrating the limitation below.
- Validation errors, SQL-injection strings, oversized bodies, wrong method/content type/origin, rate limiting (`429`), optional stats token, Pixel only enabled with a numeric ID, and unsafe `TELEGRAM_URL` / missing secret rejected at startup.

## Deployment

**Any Linux server (systemd + nginx):**

```bash
# on the server, Node 22.13+ installed
git clone <your repo> /opt/telegram-join && cd /opt/telegram-join
cp .env.example .env && nano .env      # set TELEGRAM_URL, HASH_SECRET, TRUST_PROXY=true
```

`/etc/systemd/system/telegram-join.service`:

```ini
[Unit]
Description=Telegram join landing page
After=network.target

[Service]
WorkingDirectory=/opt/telegram-join
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --env-file=.env server.js
Restart=on-failure
User=www-data
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

nginx (TLS via certbot): the app must see the real `Host` and client IP.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Docker:**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
```

```bash
docker run -d -p 3000:3000 --env-file .env -v tgjoin-data:/app/data your-image
```

Notes: the SQLite file must live on persistent storage (a volume or disk). Run a
**single instance**; the rate limiter is in-memory, and SQLite is designed for one
machine. Back up with `sqlite3 data/tracking.sqlite ".backup backup.sqlite"`. Serve
over HTTPS so the `Secure` cookie flag applies.

## Limitations (please read)

- **"Unique" means unique browser profile, not unique person.** The visitor ID lives in
  the browser. If someone clears site data or cookies, uses private/incognito windows,
  another browser, or another device, the same person is counted again. Conversely, two
  people sharing one browser profile count as one. Some privacy browsers and in-app
  browsers limit or reset storage, which inflates the count.
- IP addresses are **not** used as identifiers (many people share an IP and one person
  changes IPs). They are used only in memory for rate limiting.
- **Counts are not fraud-proof.** Someone who scripts requests with fresh random IDs can
  inflate the unique count until rate limits stop them. Rate limits slow this down; they
  do not make it impossible. Treat the numbers as a good-faith measurement.
- **A click is not a join.** The page cannot know whether the visitor completed the join in Telegram.
- Clicks dropped by rate limits, ad blockers or a closed tab before the request is
  sent are not recorded. The Pixel count and the database count will differ.
- Changing `HASH_SECRET` after launch makes all returning visitors look new.
- `node:sqlite` is still marked experimental in Node 22 (its API is stable in practice
  and the start scripts silence the warning). Pin your Node version.

## Privacy considerations

- Stored in the database: a keyed HMAC-SHA256 hash of the random browser ID, campaign, button name, timestamps.
  No IP address, user agent, name, email or phone number.
- Stored in the browser: one random ID (`localStorage` key and cookie `tgj_vid`). It is
  not derived from anything about the person, but it **is** an identifier that persists on
  their device.
- Laws such as GDPR/ePrivacy (EU/UK) and similar rules elsewhere can require **consent**
  before storing identifiers on a device or loading advertising pixels such as Meta's.
  This project ships a plain-language notice but **no consent banner**. If you target
  those regions, add a consent flow and only call the tracking code and the Pixel after consent.
- Because `HASH_SECRET` is needed to link a stored hash back to an ID, keep it private.
  Hashes remain pseudonymous data, not anonymous data.
- Update the footer text if you change what is collected, and publish a privacy policy that matches reality.

## Customising

Edit the copy in `.env` or `public/index.html`. Colours live in the `:root` block of
`public/styles.css`. To add a button, give it `data-join` and `data-button="..."`, and add
the new name to `BUTTONS` in `src/app.js`.
