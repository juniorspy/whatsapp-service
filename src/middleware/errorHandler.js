import { logger } from "../utils/logger.js";

// eslint-disable-next-line no-unused-vars
export const errorHandler = (error, req, res, _next) => {
  logger.error(
    {
      err: {
        message: error.message,
        stack: error.stack
      },
      route: `${req.method} ${req.originalUrl}`
    },
    "Unhandled error"
  );

  if (res.headersSent) {
    return;
  }

  const status = error.status ?? 500;

  res.status(status).json({
    error: error.code ?? "internal_error",
    message: error.message ?? "Internal server error"
  });
};

export default errorHandler;
