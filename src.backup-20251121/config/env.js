import dotenv from "dotenv";

let isLoaded = false;

export const loadEnvironment = () => {
  if (isLoaded) {
    return;
  }

  const envFile = process.env.ENV_FILE;
  const options = {};

  if (envFile) {
    options.path = envFile;
  }

  dotenv.config(options);
  isLoaded = true;
};

export const getConfig = () => {
  loadEnvironment();

  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number.parseInt(process.env.PORT ?? "4001", 10),
    security: {
      adminToken: process.env.API_TOKEN ?? ""
    },
    evolution: {
      baseUrl: process.env.EVOLUTION_API_URL ?? "https://evo.onrpa.com",
      masterKey: process.env.EVOLUTION_MASTER_KEY ?? "",
      timeoutMs: Number.parseInt(process.env.EVOLUTION_API_TIMEOUT ?? "45000", 10)
    },
    firebase: {
      serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT ?? "",
      databaseUrl: process.env.FIREBASE_DATABASE_URL ?? ""
    }
  };
};
