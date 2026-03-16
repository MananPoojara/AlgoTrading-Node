/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080",
    NEXT_PUBLIC_SMARTAPI_CLIENT_ID: process.env.NEXT_PUBLIC_SMARTAPI_CLIENT_ID,
    NEXT_PUBLIC_OAUTH_CALLBACK_URL:
      process.env.NEXT_PUBLIC_OAUTH_CALLBACK_URL ||
      "http://localhost:3000/api/auth/callback",
  },
};

module.exports = nextConfig;
