const express = require("express");
const crypto = require("crypto");
const { query } = require("../../database/postgresClient");
const { logger } = require("../../core/logger/logger");
const { handleApiError } = require("../utils/errorHandler");

const router = express.Router();

const ALLOWED_REDIRECT_ORIGINS = [
  "http://localhost:3000",
  "https://localhost:3000",
];

function validateRedirectUrl(url) {
  if (!url) return "http://localhost:3000";

  try {
    const urlObj = new URL(url);
    const isAllowed = ALLOWED_REDIRECT_ORIGINS.some((origin) =>
      url.startsWith(origin),
    );
    return isAllowed ? url : null;
  } catch {
    return null;
  }
}

function validateApiKey() {
  const apiKey = process.env.ANGEL_ONE_API_KEY;
  if (!apiKey) {
    throw new Error("ANGEL_ONE_API_KEY environment variable is not set");
  }
  return apiKey;
}

router.get("/login", (req, res) => {
  try {
    const clientId = req.query.client_id || "default";
    const redirectUrl =
      process.env.ANGEL_ONE_REDIRECT_URL ||
      "http://localhost:3000/api/auth/callback";

    const apiKey = validateApiKey();

    const state = crypto.randomBytes(32).toString("hex");
    const stateExpiry = new Date(Date.now() + 10 * 60 * 1000);

    query(
      `INSERT INTO oauth_states (state, client_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [state, clientId, stateExpiry],
    ).catch((err) =>
      logger.error("Failed to store OAuth state", { error: err.message }),
    );

    const angelAuthUrl = `https://angelone.com/smartapi-auth?api_key=${apiKey}&redirect_url=${encodeURIComponent(redirectUrl)}&state=${state}`;

    res.json({
      success: true,
      data: {
        authUrl: angelAuthUrl,
        message: "Redirect user to authUrl for OAuth flow",
        expiresIn: 600,
      },
    });
  } catch (error) {
    logger.error("Login error", { error: error.message });
    res.status(500).json({
      success: false,
      error: "Authentication not configured",
    });
  }
});

router.get("/callback", async (req, res) => {
  try {
    const { token, state, api_key } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Missing token in callback",
      });
    }

    if (state) {
      const stateResult = await query(
        "SELECT * FROM oauth_states WHERE state = $1 AND expires_at > NOW()",
        [state],
      );

      if (stateResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Invalid or expired state parameter",
        });
      }

      await query("DELETE FROM oauth_states WHERE state = $1", [state]);
    }

    const clientId = state
      ? (
          await query("SELECT client_id FROM oauth_states WHERE state = $1", [
            state,
          ])
        ).rows[0]?.client_id
      : "default";

    await query(
      `INSERT INTO api_tokens (client_id, token, status, expires_at, created_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '24 hours', NOW())
       ON CONFLICT (token) DO UPDATE SET expires_at = NOW() + INTERVAL '24 hours', last_used_at = NOW()`,
      [clientId || "default", token],
    );

    logger.info("OAuth token stored", { clientId: clientId || "default" });

    const frontendUrl = validateRedirectUrl(process.env.FRONTEND_URL);
    if (!frontendUrl) {
      return res.status(500).json({
        success: false,
        error: "Invalid redirect URL configured",
      });
    }

    res.redirect(`${frontendUrl}?token=${token}`);
  } catch (error) {
    logger.error("OAuth callback error", { error: error.message });
    res.status(500).json({
      success: false,
      error: "Failed to process authentication",
    });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const token = authHeader.substring(7);

    await query("DELETE FROM api_tokens WHERE token = $1", [token]);

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/auth/logout" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: "Refresh token required",
      });
    }

    const existingToken = await query(
      "SELECT * FROM api_tokens WHERE token = $1 AND status = $active",
      [refresh_token],
    );

    if (existingToken.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid refresh token",
      });
    }

    const newToken = crypto.randomBytes(64).toString("hex");

    await query(
      `UPDATE api_tokens 
       SET status = 'expired'
       WHERE token = $1`,
      [refresh_token],
    );

    await query(
      `INSERT INTO api_tokens (client_id, token, status, expires_at, created_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '24 hours', NOW())`,
      [existingToken.rows[0].client_id, newToken],
    );

    res.json({
      success: true,
      data: {
        token: newToken,
        expires_in: 86400,
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/auth/refresh" });
  }
});

module.exports = router;
