const Joi = require('joi');

const validateSchema = async (schema, data) => {
  try {
    const validated = await schema.validateAsync(data, { 
      abortEarly: false,
      stripUnknown: true 
    });
    return { valid: true, data error: validated,: null };
  } catch (error) {
    const errors = error.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message,
      type: detail.type
    }));
    return { valid: false, data: null, error: errors };
  }
};

const createSchema = (fields) => {
  return Joi.object(fields);
};

const safeJsonParse = (str, defaultValue = null) => {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
};

const deepClone = (obj) => {
  return JSON.parse(JSON.stringify(obj));
};

const pick = (obj, keys) => {
  return keys.reduce((acc, key) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
};

const omit = (obj, keys) => {
  const result = { ...obj };
  keys.forEach(key => delete result[key]);
  return result;
};

const roundTo = (num, decimals = 2) => {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

const clamp = (num, min, max) => {
  return Math.min(Math.max(num, min), max);
};

const isEmpty = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
};

const isNumber = (value) => {
  return typeof value === 'number' && !isNaN(value);
};

const isPositiveInteger = (value) => {
  return Number.isInteger(value) && value > 0;
};

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const retry = async (fn, options = {}) => {
  const { 
    maxAttempts = 3, 
    delay = 1000, 
    backoff = 2,
    onRetry = null 
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxAttempts) {
        break;
      }

      if (onRetry) {
        onRetry(attempt, error);
      }

      await sleep(delay * Math.pow(backoff, attempt - 1));
    }
  }

  throw lastError;
};

const debounce = (fn, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

const throttle = (fn, limit) => {
  let inThrottle;
  return (...args) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

const capitalize = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

const snakeToCamel = (str) => {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
};

const camelToSnake = (str) => {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
};

const sanitizeString = (str) => {
  if (!str) return '';
  return str.replace(/[<>\"'&]/g, '');
};

const calculatePercentage = (value, total) => {
  if (!total || total === 0) return 0;
  return roundTo((value / total) * 100);
};

const formatCurrency = (amount, currency = 'INR') => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency
  }).format(amount);
};

const chunk = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const groupBy = (array, key) => {
  return array.reduce((result, item) => {
    const groupKey = typeof key === 'function' ? key(item) : item[key];
    (result[groupKey] = result[groupKey] || []).push(item);
    return result;
  }, {});
};

const unique = (array) => {
  return [...new Set(array)];
};

module.exports = {
  validateSchema,
  createSchema,
  safeJsonParse,
  deepClone,
  pick,
  omit,
  roundTo,
  clamp,
  isEmpty,
  isNumber,
  isPositiveInteger,
  sleep,
  retry,
  debounce,
  throttle,
  capitalize,
  snakeToCamel,
  camelToSnake,
  sanitizeString,
  calculatePercentage,
  formatCurrency,
  chunk,
  groupBy,
  unique
};
