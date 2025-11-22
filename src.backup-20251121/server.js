import http from "node:http";
import { buildApp } from "./app.js";
import { getConfig, loadEnvironment } from "./config/env.js";
import { logger } from "./utils/logger.js";

loadEnvironment();

const config = getConfig();
const app = buildApp();
const server = http.createServer(app);

const listen = () => {
  server.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "WhatsApp service started");
  });
};

const shutdown = (signal) => {
  logger.info({ signal }, "Received shutdown signal");
  server.close((error) => {
    if (error) {
      logger.error({ error }, "Error while shutting down server");
      process.exit(1);
      return;
    }

    logger.info("Server closed gracefully");
    process.exit(0);
  });
};

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

listen();

export default server;
