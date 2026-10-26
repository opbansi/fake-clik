'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRateLimiter } = require('./rateLimit');
const { isBusyError } = require('./db');
const { CAMPAIGN_RE } = require('./config');

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BUTTONS = new Set(['hero', 'footer']);
const MAX_BODY_BYTES = 2048;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, code, message, { headers = {}, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.details = details;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function renderIndex(template, config) {
  const pixel = config.metaPixelId;
  const values = {
    TITLE: escapeHtml(config.siteTitle),
    HEADLINE: escapeHtml(config.siteHeadline),
    DESCRIPTION: escapeHtml(config.siteDescription),
    TELEGRAM_URL: escapeHtml(config.telegramUrl),
    CAMPAIGN: escapeHtml(config.campaign),
    CAMPAIGNS: escapeHtml(config.allowedCampaigns.join(',')),
    PIXEL_ID: escapeHtml(pixel),
    PIXEL_EVENT: escapeHtml(config.metaPixelClickEvent),
    // The Pixel ID is validated as digits-only in config.js, so it is safe in a URL.
    PIXEL_NOSCRIPT: pixel
      ? `<noscript><img class="pixel" alt="" width="1" height="1" src="https://www.facebook.com/tr?id=${pixel}&amp;ev=PageView&amp;noscript=1"></noscript>`
      : '',
    PIXEL_NOTICE: pixel
      ? ' This page also uses the Meta Pixel. Meta receives standard browser data such as your IP address and browser type, plus page-view and Join-click events. We send it no name, email or phone number.'
      : '',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in values ? values[key] : match));
}

function contentSecurityPolicy(config) {
  const pixel = Boolean(config.metaPixelId);
  return [
    "default-src 'self'",
    `script-src 'self'${pixel ? ' https://connect.facebook.net' : ''}`,
    "style-src 'self'",
    `img-src 'self' data:${pixel ? ' https://www.facebook.com' : ''}`,
    `connect-src 'self'${pixel ? ' https://www.facebook.com https://connect.facebook.net' : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function createApp(config, store) {
  const template = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');
  const indexHtml = renderIndex(template, config);
  const csp = contentSecurityPolicy(config);

  const ipLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitIpPerMin });
  const visitorLimiter = createRateLimiter({ windowMs: 60_000, max: config.rateLimitVisitorPerMin });
  const statsLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

  const hashVisitor = (visitorId) =>
    crypto.createHmac('sha256', config.hashSecret).update(visitorId).digest('hex');

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded) {
        // The right-most entry is the address your own proxy actually saw.
        const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients; browsers always send Origin on POST
    try {
      if (new URL(origin).host === req.headers.host) return true;
    } catch {
      return false;
    }
    return config.allowedOrigins.includes(origin.replace(/\/+$/, ''));
  }

  function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  function rateLimited(result) {
    return new HttpError(429, 'rate_limited', 'Too many requests. Please try again shortly.', {
      headers: { 'Retry-After': String(result.retryAfterSec) },
    });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const tooLarge = () =>
        new HttpError(413, 'payload_too_large', `Request body must be at most ${MAX_BODY_BYTES} bytes.`, {
          headers: { Connection: 'close' },
        });
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reject(tooLarge());

      const chunks = [];
      let size = 0;
      let finished = false;
      req.on('data', (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finished = true;
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'));
        }
      });
      req.on('error', (err) => {
        if (finished) return;
        finished = true;
        reject(err);
      });
    });
  }

  function validateTrackBody(body) {
    const problems = [];
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
    }
    const { visitorId, clickId, campaign, button } = body;
    if (typeof visitorId !== 'string' || !ID_RE.test(visitorId)) {
      problems.push({ field: 'visitorId', message: 'Must be 16-64 characters: letters, digits, "_" or "-".' });
    }
    if (typeof clickId !== 'string' || !ID_RE.test(clickId)) {
      problems.push({ field: 'clickId', message: 'Must be 16-64 characters: letters, digits, "_" or "-".' });
    }
    if (typeof campaign !== 'string' || !CAMPAIGN_RE.test(campaign) || !config.allowedCampaigns.includes(campaign)) {
      problems.push({ field: 'campaign', message: 'Unknown campaign.' });
    }
    if (typeof button !== 'string' || !BUTTONS.has(button)) {
      problems.push({ field: 'button', message: `Must be one of: ${[...BUTTONS].join(', ')}.` });
    }
    if (problems.length) {
      throw new HttpError(400, 'invalid_request', 'One or more fields are invalid.', { details: problems });
    }
    return { visitorId, clickId, campaign, button };
  }

  async function handleTrack(req, res) {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', 'Use POST.', { headers: { Allow: 'POST' } });
    }
    if (!originAllowed(req)) throw new HttpError(403, 'origin_not_allowed', 'Origin not allowed.');

    const ipResult = ipLimiter.check(clientIp(req));
    if (!ipResult.allowed) throw rateLimited(ipResult);

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json' && contentType !== 'text/plain') {
      throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
    }

    const input = validateTrackBody(await readJson(req));
    const visitorHash = hashVisitor(input.visitorId);

    const visitorResult = visitorLimiter.check(visitorHash);
    if (!visitorResult.allowed) throw rateLimited(visitorResult);

    const result = store.recordClick({
      clickId: input.clickId,
      campaign: input.campaign,
      visitorHash,
      button: input.button,
    });
    sendJson(res, 200, {
      ok: true,
      duplicate: result.duplicate,
      newUniqueVisitor: result.newUniqueVisitor,
    });
  }

  function handleStats(req, res, url) {
    if (req.method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', 'Use GET.', { headers: { Allow: 'GET' } });
    }
    const limit = statsLimiter.check(clientIp(req));
    if (!limit.allowed) throw rateLimited(limit);

    if (config.statsToken) {
      const header = String(req.headers.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!token || !safeEqual(token, config.statsToken)) {
        throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.', {
          headers: { 'WWW-Authenticate': 'Bearer' },
        });
      }
    }

    const campaign = url.searchParams.get('campaign') || config.campaign;
    if (!config.allowedCampaigns.includes(campaign)) {
      throw new HttpError(400, 'invalid_request', 'Unknown campaign.');
    }
    sendJson(res, 200, {
      ok: true,
      campaign,
      ...store.getStats(campaign),
      generatedAt: new Date().toISOString(),
    });
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'Use GET.', { headers: { Allow: 'GET, HEAD' } });
    }

    let body;
    let type;
    let cache;
    if (pathname === '/' || pathname === '/index.html') {
      body = Buffer.from(indexHtml, 'utf8');
      type = MIME['.html'];
      cache = 'public, max-age=60';
    } else {
      let relative;
      try {
        relative = decodeURIComponent(pathname);
      } catch {
        throw new HttpError(400, 'bad_request', 'Malformed URL.');
      }
      const hidden = relative.split('/').some((segment) => segment.startsWith('.'));
      const file = path.resolve(config.publicDir, `.${relative}`);
      type = MIME[path.extname(file).toLowerCase()];
      if (relative.includes('\0') || hidden || !type || !file.startsWith(config.publicDir + path.sep)) {
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      try {
        body = await fs.promises.readFile(file);
      } catch {
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      cache = 'public, max-age=3600';
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': cache,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function handleError(err, res) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      const error = { code: err.code, message: err.message };
      if (err.details) error.details = err.details;
      sendJson(res, err.status, { ok: false, error }, err.headers);
      return;
    }
    if (isBusyError(err)) {
      sendJson(
        res,
        503,
        { ok: false, error: { code: 'temporarily_unavailable', message: 'Database busy. Retry shortly.' } },
        { 'Retry-After': '2' }
      );
      return;
    }
    // Never log request bodies or visitor identifiers.
    console.error('[error]', err && err.stack ? err.stack : err);
    sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong.' } });
  }

  async function handler(req, res) {
    try {
      setSecurityHeaders(res);
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (pathname === '/api/track') return await handleTrack(req, res);
      if (pathname === '/api/stats') return handleStats(req, res, url);
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found.');
      return await serveStatic(req, res, pathname);
    } catch (err) {
      handleError(err, res);
    }
  }

  return {
    handler,
    close() {
      ipLimiter.close();
      visitorLimiter.close();
      statsLimiter.close();
    },
  };
}

module.exports = { createApp, renderIndex };
