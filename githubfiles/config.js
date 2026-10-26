'use strict';

const path = require('node:path');

const CAMPAIGN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PIXEL_ID_RE = /^\d{5,20}$/;
const PIXEL_EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);
const PLACEHOLDER_SECRET = 'replace-with-a-long-random-string';

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

function readBool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function readText(env, name, fallback, maxLen) {
  const value = (env[name] || '').trim() || fallback;
  if (value.length > maxLen) throw new Error(`${name} must be at most ${maxLen} characters.`);
  return value;
}

function readList(env, name) {
  return (env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTelegramUrl(raw) {
  if (!raw) throw new Error('TELEGRAM_URL is required (for example https://t.me/your_channel).');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TELEGRAM_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' || !TELEGRAM_HOSTS.has(url.hostname)) {
    throw new Error('TELEGRAM_URL must be an https link on t.me, telegram.me or telegram.dog.');
  }
  return url.toString();
}

/**
 * Builds a validated, frozen configuration object from environment variables.
 * Throws a descriptive Error on any problem so the server fails fast at boot.
 */
function loadConfig(env = process.env, baseDir = process.cwd()) {
  const campaign = (env.CAMPAIGN_ID || 'main').trim();
  const allowedCampaigns = [...new Set([campaign, ...readList(env, 'ALLOWED_CAMPAIGNS')])];
  for (const name of allowedCampaigns) {
    if (!CAMPAIGN_RE.test(name)) {
      throw new Error(`Invalid campaign name "${name}". Use 1-40 letters, digits, "_" or "-".`);
    }
  }

  const hashSecret = (env.HASH_SECRET || '').trim();
  if (hashSecret.length < 16 || hashSecret === PLACEHOLDER_SECRET) {
    throw new Error('HASH_SECRET must be set to a random string of 16+ characters (run: npm run gen-secret).');
  }

  const statsToken = (env.STATS_TOKEN || '').trim();
  if (statsToken && statsToken.length < 16) {
    throw new Error('STATS_TOKEN must be at least 16 characters when set.');
  }

  const metaPixelId = (env.META_PIXEL_ID || '').trim();
  if (metaPixelId && !PIXEL_ID_RE.test(metaPixelId)) {
    throw new Error('META_PIXEL_ID must be numeric (5-20 digits).');
  }
  const metaPixelClickEvent = (env.META_PIXEL_CLICK_EVENT || 'TelegramJoinClick').trim();
  if (!PIXEL_EVENT_RE.test(metaPixelClickEvent)) {
    throw new Error('META_PIXEL_CLICK_EVENT must start with a letter and use only letters, digits or "_".');
  }

  const dbRaw = env.DATABASE_PATH || './data/tracking.sqlite';
  const dbPath = dbRaw === ':memory:' ? dbRaw : path.resolve(baseDir, dbRaw);

  return Object.freeze({
    port: readInt(env, 'PORT', 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    telegramUrl: parseTelegramUrl((env.TELEGRAM_URL || '').trim()),
    siteTitle: readText(env, 'SITE_TITLE', 'Join our Telegram channel', 120),
    siteHeadline: readText(env, 'SITE_HEADLINE', 'Get every update in our Telegram channel', 160),
    siteDescription: readText(
      env,
      'SITE_DESCRIPTION',
      'Short, useful posts delivered straight to your phone. Tap the button, press Join in Telegram, and you are in.',
      320
    ),
    campaign,
    allowedCampaigns,
    dbPath,
    hashSecret,
    statsToken,
    rateLimitIpPerMin: readInt(env, 'RATE_LIMIT_IP_PER_MIN', 60, 1, 1_000_000),
    rateLimitVisitorPerMin: readInt(env, 'RATE_LIMIT_VISITOR_PER_MIN', 20, 1, 1_000_000),
    allowedOrigins: readList(env, 'ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, '')),
    metaPixelId,
    metaPixelClickEvent,
    publicDir: path.resolve(__dirname, '..', 'public'),
  });
}

module.exports = { loadConfig, CAMPAIGN_RE };
