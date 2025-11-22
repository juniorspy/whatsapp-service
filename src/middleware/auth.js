import { getConfig } from "../config/env.js";

export const requireAdminToken = (req, res, next) => {
  const {
    security: { adminToken }
  } = getConfig();

  if (!adminToken) {
    return next();
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  if (token !== adminToken) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Invalid or missing API token"
    });
  }

  return next();
};

export default requireAdminToken;
