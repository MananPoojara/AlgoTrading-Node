function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      if (
        rules.required &&
        (value === undefined || value === null || value === "")
      ) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      if (value !== undefined && value !== null) {
        if (rules.type) {
          const actualType = typeof value;
          if (actualType !== rules.type) {
            errors.push({
              field,
              message: `${field} must be of type ${rules.type}`,
            });
          }
        }

        if (rules.type === "number" && typeof value === "number") {
          if (rules.min !== undefined && value < rules.min) {
            errors.push({
              field,
              message: `${field} must be at least ${rules.min}`,
            });
          }
          if (rules.max !== undefined && value > rules.max) {
            errors.push({
              field,
              message: `${field} must be at most ${rules.max}`,
            });
          }
        }

        if (rules.enum && !rules.enum.includes(value)) {
          errors.push({
            field,
            message: `${field} must be one of: ${rules.enum.join(", ")}`,
          });
        }

        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push({ field, message: `${field} has invalid format` });
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.query[field];

      if (rules.required && !value) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      if (value) {
        if (rules.type === "number") {
          const numValue = parseInt(value);
          if (isNaN(numValue)) {
            errors.push({ field, message: `${field} must be a number` });
          } else {
            if (rules.min !== undefined && numValue < rules.min) {
              errors.push({
                field,
                message: `${field} must be at least ${rules.min}`,
              });
            }
            if (rules.max !== undefined && numValue > rules.max) {
              errors.push({
                field,
                message: `${field} must be at most ${rules.max}`,
              });
            }
            req.query[field] = numValue;
          }
        }

        if (rules.enum && !rules.enum.includes(value)) {
          errors.push({
            field,
            message: `${field} must be one of: ${rules.enum.join(", ")}`,
          });
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    next();
  };
}

const schemas = {
  order: {
    client_id: { required: true, type: "string" },
    instrument: { required: true, type: "string" },
    side: { required: true, enum: ["BUY", "SELL"] },
    quantity: { required: true, type: "number", min: 1 },
    price: { type: "number", min: 0 },
    price_type: { enum: ["MARKET", "LIMIT"] },
  },
  strategyInstance: {
    client_id: { required: true, type: "string" },
    strategy_id: { required: true, type: "string" },
    parameters: { type: "object" },
  },
  pagination: {
    limit: { type: "number", min: 1, max: 1000 },
    offset: { type: "number", min: 0 },
  },
};

module.exports = {
  validateBody,
  validateQuery,
  schemas,
};
