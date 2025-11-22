import admin from "firebase-admin";
import "firebase-admin/database";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";

let firebaseApp;

const loadServiceAccount = (serviceAccountPath) => {
  const resolvedPath = path.resolve(serviceAccountPath);

  if (!fs.existsSync(resolvedPath)) {
    const error = new Error(
      `Firebase service account file not found at ${resolvedPath}`
    );
    error.status = 500;
    throw error;
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  return JSON.parse(raw);
};

export const getFirebaseApp = () => {
  if (firebaseApp) {
    return firebaseApp;
  }

  const {
    firebase: { serviceAccountPath, databaseUrl }
  } = getConfig();

  if (!serviceAccountPath || !databaseUrl) {
    const error = new Error("Firebase configuration is incomplete");
    error.status = 500;
    throw error;
  }

  const credentials = loadServiceAccount(serviceAccountPath);

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(credentials),
    databaseURL: databaseUrl
  });

  logger.info("Firebase app initialized");
  return firebaseApp;
};

export const getRealtimeDatabase = () => {
  const app = getFirebaseApp();
  return app.database();
};

export default {
  getFirebaseApp,
  getRealtimeDatabase
};
