(function () {
  'use strict';

  var STORE_KEY = 'tgj_vid';
  var ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
  var PIXEL_ID_RE = /^\d{5,20}$/;
  // Events Meta defines itself. Anything else is sent as a custom event.
  var STANDARD_EVENTS = ['Lead', 'Contact', 'Subscribe', 'ViewContent', 'CompleteRegistration', 'Search'];

  /* ---------- helpers ---------- */

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }

  function readCookie(name) {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Returns this browser's random visitor ID, creating it on first use.
   * Stored in localStorage and mirrored in a first-party cookie so that it
   * survives if either one is cleared. Contains no personal data.
   */
  function getVisitorId() {
    var id = null;
    try { id = window.localStorage.getItem(STORE_KEY); } catch (e) { /* storage blocked */ }
    if (!ID_RE.test(id || '')) id = readCookie(STORE_KEY);
    if (!ID_RE.test(id || '')) id = randomId();

    try { window.localStorage.setItem(STORE_KEY, id); } catch (e) { /* ignore */ }
    try {
      var secure = window.location && window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = STORE_KEY + '=' + id + '; Max-Age=31536000; Path=/; SameSite=Lax' + secure;
    } catch (e) { /* ignore */ }
    return id;
  }

  /* ---------- Meta Pixel (optional, only when an ID is configured) ---------- */

  function loadPixel(pixelId) {
    if (window.fbq) return;
    var fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
      else fbq.queue.push(arguments);
    };
    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];

    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);

    // Do not let Meta scrape button text or form fields automatically.
    fbq('set', 'autoConfig', false, pixelId);
    fbq('init', pixelId); // no advanced-matching data: nothing personal is passed
    fbq('track', 'PageView');
  }

  /* ---------- tracking ---------- */

  function sendTracking(trackUrl, payload) {
    var json = JSON.stringify(payload);
    var queued = false;
    try {
      if (navigator.sendBeacon) {
        queued = navigator.sendBeacon(trackUrl, new Blob([json], { type: 'application/json' }));
      }
    } catch (e) { queued = false; }
    if (queued) return;
    try {
      // Same click_id, so a server that already saw the beacon will ignore this.
      var request = fetch(trackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
        credentials: 'omit'
      });
      if (request && request.catch) request.catch(function () {});
    } catch (e) { /* tracking is best effort */ }
  }

  function init() {
    var cfg = document.body.dataset;
    var trackUrl = cfg.trackUrl || '/api/track';

    var campaign = cfg.campaign;
    try {
      var requested = new URLSearchParams(window.location.search).get('c');
      if (requested && (cfg.campaigns || '').split(',').indexOf(requested) !== -1) campaign = requested;
    } catch (e) { /* keep default */ }

    var pixelId = cfg.pixelId || '';
    var pixelOn = PIXEL_ID_RE.test(pixelId);
    if (pixelOn) {
      try { loadPixel(pixelId); } catch (e) { pixelOn = false; }
    }

    function onJoin(buttonName) {
      // Everything here is best effort and wrapped in try/catch. The handler
      // never calls preventDefault, so the link always opens Telegram.
      try {
        sendTracking(trackUrl, {
          visitorId: getVisitorId(),
          clickId: randomId(), // unique per click: makes retries idempotent
          campaign: campaign,
          button: buttonName
        });
      } catch (e) { /* ignore */ }

      if (pixelOn) {
        try {
          var eventName = cfg.pixelEvent || 'TelegramJoinClick';
          var method = STANDARD_EVENTS.indexOf(eventName) !== -1 ? 'track' : 'trackCustom';
          // Meta Pixel reporting is independent of the database metric.
          window.fbq(method, eventName, { button: buttonName, campaign: campaign });
        } catch (e) { /* ignore */ }
      }
    }

    var buttons = document.querySelectorAll('[data-join]');
    Array.prototype.forEach.call(buttons, function (el) {
      var name = el.getAttribute('data-button') || 'hero';
      el.addEventListener('click', function () { onJoin(name); });
      // Middle-click opens the link in a new tab without firing "click".
      el.addEventListener('auxclick', function (event) {
        if (event.button === 1) onJoin(name);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
