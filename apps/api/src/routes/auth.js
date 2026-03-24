const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../../../../packages/database/postgresClient");
const { logger } = require("../../../../packages/core/logger/logger");
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

function normalizeClientId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOperatorIdentifier(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const localPart = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  return localPart || null;
}

async function resolveLoginClientId(requestedClientId) {
  const clientId = normalizeClientId(requestedClientId);

  if (clientId) {
    const explicitClient = await query(
      "SELECT id FROM clients WHERE id = $1 AND status = $2 LIMIT 1",
      [clientId, "active"],
    );

    if (explicitClient.rows.length > 0) {
      return explicitClient.rows[0].id;
    }
  }

  const fallbackClient = await query(
    "SELECT id FROM clients WHERE status = $1 ORDER BY id ASC LIMIT 1",
    ["active"],
  );

  return fallbackClient.rows[0]?.id || null;
}

router.post("/login", async (req, res) => {
  try {
    const identifier = normalizeOperatorIdentifier(
      req.body?.username || req.body?.email,
    );
    const password = req.body?.password;

    if (!identifier || typeof password !== "string" || password.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Username/email and password are required",
      });
    }

    const operatorResult = await query(
      `SELECT id, username, password_hash, role, status
       FROM operators
       WHERE username = $1
       LIMIT 1`,
      [identifier],
    );

    const operator = operatorResult.rows[0];

    if (!operator || operator.status !== "active") {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      operator.password_hash,
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const clientId = await resolveLoginClientId(req.body?.client_id);

    if (!clientId) {
      logger.error("Dashboard login failed: no active client available", {
        operator: operator.username,
      });
      return res.status(503).json({
        success: false,
        error: "No active client available for operator session",
      });
    }

    const token = crypto.randomBytes(64).toString("hex");

    await query(
      `INSERT INTO api_tokens (client_id, token, status, expires_at, created_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '24 hours', NOW())`,
      [clientId, token],
    );

    await query("UPDATE operators SET last_login = NOW() WHERE id = $1", [
      operator.id,
    ]);

    logger.info("Operator logged in", {
      operator: operator.username,
      role: operator.role,
      clientId,
    });

    return res.json({
      success: true,
      data: {
        token,
        expires_in: 86400,
        user: {
          username: operator.username,
          role: operator.role,
          client_id: clientId,
        },
      },
    });
  } catch (error) {
    logger.error("Credential login error", { error: error.message });
    return handleApiError(res, error, { route: "/auth/login" });
  }
});

router.get("/login", (req, res) => {
  try {
    const clientId = normalizeClientId(req.query.client_id);
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

      const stateRow = stateResult.rows[0];
      await query("DELETE FROM oauth_states WHERE state = $1", [state]);
      req.oauthClientId = stateRow.client_id;
    }

    const clientId = normalizeClientId(req.oauthClientId);

    await query(
      `INSERT INTO api_tokens (client_id, token, status, expires_at, created_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '24 hours', NOW())
       ON CONFLICT (token) DO UPDATE SET expires_at = NOW() + INTERVAL '24 hours', last_used_at = NOW()`,
      [clientId, token],
    );

    logger.info("OAuth token stored", { clientId });

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
      "SELECT * FROM api_tokens WHERE token = $1 AND status = $2",
      [refresh_token, "active"],
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
