const { logger } = require("../../../../packages/core/logger/logger");

function sanitizeError(error, context = {}) {
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  logger.error("API Error", {
    errorId,
    message: error.message,
    stack: error.stack,
    ...context,
  });

  return {
    success: false,
    error: "An internal error occurred",
    errorId,
  };
}

function handleApiError(res, error, context = {}) {
  const sanitized = sanitizeError(error, context);
  return res.status(500).json(sanitized);
}

module.exports = {
  sanitizeError,
  handleApiError,
};
