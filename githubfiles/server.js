'use strict';

const http = require('node:http');
const { loadConfig } = require('./src/config');
const { openStore } = require('./src/db');
const { createApp } = require('./src/app');

function start(config = loadConfig()) {
  const store = openStore(config.dbPath);
  const app = createApp(config, store);
  const server = http.createServer(app.handler);

  // Slow-client protection.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  server.listen(config.port, config.host, () => {
    const where = server.address();
    console.log(`Listening on http://${where.address}:${where.port}  (campaign: ${config.campaign})`);
    console.log(`Join link: ${config.telegramUrl}`);
    console.log(`Meta Pixel: ${config.metaPixelId ? 'enabled' : 'disabled'}`);
  });

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down...`);
    server.close(() => {
      app.close();
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, store, app };
}

if (require.main === module) {
  try {
    start();
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { start };
