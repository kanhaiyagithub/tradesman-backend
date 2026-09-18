const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173",
];

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const getAllowedOrigins = () => {
  const configuredOrigins = parseCsv(process.env.CORS_ALLOWED_ORIGINS);

  if (configuredOrigins.length) {
    return configuredOrigins;
  }

  if (process.env.NODE_ENV === "production") {
    return [];
  }

  return DEFAULT_DEV_ORIGINS;
};

const isOriginAllowed = (origin) => {
  if (!origin) {
    return true;
  }

  return getAllowedOrigins().includes(origin);
};

module.exports = {
  getAllowedOrigins,
  isOriginAllowed,
};
