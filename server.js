const http = require("http");
const process = require("process");
const ApplicationServer = require("./app");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 3000;

const serverLog = logger.createLogger({
  name: 'server-service',
  level: 'debug',
  json: false,
  colors: true,
  logDir: './logs/server',
  context: {
    service: 'server',
    version: '1.0.0'
  }
});

const server = new ApplicationServer({
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  logDir: './logs/app',
  gracefulShutdownTimeout: 30000,
  healthCheck: {
    enabled: true,
    path: '/health',
    interval: 30000
  },
  metrics: {
    enabled: true,
    path: '/metrics'
  }
});

server.start().then(() => {
  logger.success('Server started successfully!');
});

const shutdown = (signal) => {
  serverLog.warn(`\nReceived ${signal}. Closing server...`);

  server.close((err) => {
    if (err) {
      serverLog.error("Error closing server:", err);
      process.exit(1);
    }
    serverLog.info("Server closed cleanly.");
    process.exit(0);
  });

  setTimeout(() => {
    serverLog.warn("Forcing server shutdown...");
    process.exit(1);
  }, 10000).unref();
};

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

