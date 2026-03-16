const { logger } = require("../../core/logger/logger");
const { query } = require("../../database/postgresClient");
const config = require("../../../config/default");

const PUBLIC_PATHS = [
  "/health",
  "/ready",
  "/api/auth/login",
  "/api/auth/callback",
];

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    });
  }

  const token = authHeader.substring(7);

  try {
    const result = await query(
      "SELECT id, client_id, expires_at FROM api_tokens WHERE token = $1 AND status = $2",
      [token, "active"],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid token",
      });
    }

    const tokenRecord = result.rows[0];

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(401).json({
        success: false,
        error: "Token expired",
      });
    }

    req.user = {
      id: tokenRecord.id,
      clientId: tokenRecord.client_id,
    };

    await query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1", [
      tokenRecord.id,
    ]);

    next();
  } catch (error) {
    logger.error("Auth middleware error", { error: error.message });
    return res.status(500).json({
      success: false,
      error: "Authentication failed",
    });
  }
}

async function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    try {
      const result = await query("SELECT role FROM clients WHERE id = $1", [
        req.user.clientId,
      ]);

      if (result.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: "User not found",
        });
      }

      const userRole = result.rows[0].role;

      if (!roles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: "Insufficient permissions",
        });
      }

      next();
    } catch (error) {
      logger.error("Role check error", { error: error.message });
      return res.status(500).json({
        success: false,
        error: "Authorization failed",
      });
    }
  };
}

function isPublicPath(path) {
  return PUBLIC_PATHS.some(
    (publicPath) => path === publicPath || path.startsWith(publicPath + "/"),
  );
}

module.exports = {
  requireAuth,
  requireRole,
  isPublicPath,
  PUBLIC_PATHS,
};
