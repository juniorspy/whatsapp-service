import express from "express";
import cors from "cors";
import healthRouter from "./routes/health.js";
import whatsappRouter from "./routes/whatsapp.js";
import { requireAdminToken } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";

export const buildApp = () => {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "whatsapp-service",
      status: "ok"
    });
  });

  app.use("/health", healthRouter);
  app.use("/api/v1/whatsapp", requireAdminToken, whatsappRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `Route ${req.method} ${req.originalUrl} not found`
    });
  });

  app.use(errorHandler);

  return app;
};

export default buildApp;
