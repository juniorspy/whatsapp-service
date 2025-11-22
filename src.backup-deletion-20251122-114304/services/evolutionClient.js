import axios from "axios";
import crypto from "node:crypto";
import { getConfig } from "../config/env.js";

const config = getConfig();

const masterHttp = axios.create({
  baseURL: config.evolution.baseUrl,
  timeout: config.evolution.timeoutMs,
  headers: {
    "Content-Type": "application/json"
  }
});

const buildInstanceHttp = (instanceApiKey) =>
  axios.create({
    baseURL: config.evolution.baseUrl,
    timeout: config.evolution.timeoutMs,
    headers: {
      "Content-Type": "application/json",
      apikey: instanceApiKey
    }
  });

const extractError = (error, context) => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 500;
    const reason =
      error.response?.data?.response?.message ??
      error.response?.data?.message ??
      error.message;

    const err = new Error(`[Evolution] ${context}: ${reason}`);
    err.status = status;
    err.code = error.response?.data?.error ?? "evolution_error";
    err.data = error.response?.data;
    return err;
  }

  const err = new Error(`[Evolution] ${context}: ${error.message}`);
  err.status = 500;
  return err;
};

export const generateInstanceToken = () => crypto.randomBytes(32).toString("hex");

export const createInstance = async ({
  instanceName,
  phoneNumber,
  webhookUrl
}) => {
  try {
    const token = generateInstanceToken();

    const body = {
      instanceName,
      token,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true
    };

    if (phoneNumber) {
      body.number = phoneNumber;
    }

    if (webhookUrl) {
      body.webhook = {
        enabled: true,
        url: webhookUrl,
        events: ["MESSAGES_UPSERT", "QRCODE_UPDATED", "CONNECTION_UPDATE"]
      };
    }

    const response = await masterHttp.post("/instance/create", body, {
      headers: {
        apikey: config.evolution.masterKey
      }
    });

    return {
      token,
      data: response.data
    };
  } catch (error) {
    throw extractError(error, "Failed to create instance");
  }
};

export const getConnectionState = async ({ instanceName, instanceApiKey }) => {
  try {
    const http = buildInstanceHttp(instanceApiKey);
    const response = await http.get(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
    return response.data;
  } catch (error) {
    throw extractError(
      error,
      `Failed to fetch connection state for ${instanceName}`
    );
  }
};

export const getQrCode = async ({ instanceName, instanceApiKey }) => {
  try {
    const http = buildInstanceHttp(instanceApiKey);
    const response = await http.get(`/instance/connect/${encodeURIComponent(instanceName)}`);
    return response.data;
  } catch (error) {
    throw extractError(error, `Failed to fetch QR code for ${instanceName}`);
  }
};

export const deleteInstance = async ({ instanceName }) => {
  try {
    const response = await masterHttp.delete(`/instance/delete/${encodeURIComponent(instanceName)}`, {
      headers: {
        apikey: config.evolution.masterKey
      }
    });

    return response.data;
  } catch (error) {
    throw extractError(error, `Failed to delete instance ${instanceName}`);
  }
};

export const configureWebhook = async ({ instanceName, webhookUrl }) => {
  if (!webhookUrl) {
    return null;
  }

  try {
    const body = {
      instanceName,
      webhook: {
        enabled: true,
        url: webhookUrl,
        events: ["MESSAGES_UPSERT", "QRCODE_UPDATED", "CONNECTION_UPDATE"]
      }
    };

    const response = await masterHttp.post("/instance/webhook", body, {
      headers: {
        apikey: config.evolution.masterKey
      }
    });

    return response.data;
  } catch (error) {
    throw extractError(
      error,
      `Failed to configure webhook for ${instanceName}`
    );
  }
};

export default {
  createInstance,
  getConnectionState,
  getQrCode,
  deleteInstance,
  configureWebhook,
  generateInstanceToken
};
