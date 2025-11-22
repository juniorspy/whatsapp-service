import pino from "pino";
import { loadEnvironment } from "../config/env.js";

loadEnvironment();

const createLogger = () =>
  pino({
    name: "whatsapp-service",
    level: process.env.LOG_LEVEL ?? "info"
  });

export const logger = createLogger();

export default logger;
