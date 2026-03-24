const config = require('../../../config/default');

const TIMEZONE = {
  IST: 'Asia/Kolkata',
  UTC: 'UTC'
};

const getMarketHours = () => ({
  OPEN: config.marketHours.open,
  CLOSE: config.marketHours.close,
  SQUARE_OFF: config.marketHours.squareOff
});

const MARKET_HOURS = getMarketHours();

const createISTDate = (date = new Date()) => {
  const normalized = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(normalized.getTime())) {
    return null;
  }
  return normalized;
};

const getISTParts = (date = new Date()) => {
  const normalized = createISTDate(date);
  if (!normalized) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE.IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return formatter.formatToParts(normalized).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
};

const isMarketOpen = () => {
  const now = new Date();
  const istTime = toIST(now);
  const currentTime = istTime.toTimeString().slice(0, 5);
  
  return currentTime >= MARKET_HOURS.OPEN && currentTime < MARKET_HOURS.CLOSE;
};

const toUTC = (date = new Date()) => {
  return new Date(date.toISOString());
};

const toIST = (date = new Date()) => {
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(date.getTime() + istOffset);
};

const getISTTime = () => {
  return toIST(new Date());
};

const formatIST = (date = new Date()) => {
  const normalized = createISTDate(date);
  const parts = getISTParts(normalized);
  if (!normalized || !parts) {
    return null;
  }

  const milliseconds = String(normalized.getMilliseconds()).padStart(3, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}+05:30`;
};

const getTodayIST = () => {
  const formatted = formatIST(new Date());
  return formatted ? formatted.slice(0, 10) : null;
};

const getStartOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getEndOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const getStartOfWeek = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getEndOfWeek = (date = new Date()) => {
  const start = getStartOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
};

const getStartOfMonth = (date = new Date()) => {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getEndOfMonth = (date = new Date()) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
};

const isWeekend = (date = new Date()) => {
  const day = date.getDay();
  return day === 0 || day === 6;
};

const isTradingDay = (date = new Date()) => {
  return !isWeekend(date);
};

const getTimeDifference = (start, end) => {
  const diff = end - start;
  return {
    milliseconds: diff,
    seconds: Math.floor(diff / 1000),
    minutes: Math.floor(diff / (1000 * 60)),
    hours: Math.floor(diff / (1000 * 60 * 60))
  };
};

const wait = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const parseTimeString = (timeStr) => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
};

const isTimeAfter = (time1, time2) => {
  const t1 = parseTimeString(time1);
  const t2 = parseTimeString(time2);
  return t1 > t2;
};

const isTimeBefore = (time1, time2) => {
  const t1 = parseTimeString(time1);
  const t2 = parseTimeString(time2);
  return t1 < t2;
};

const shouldSquareOff = () => {
  const now = new Date();
  const istTime = toIST(now);
  const currentTime = istTime.toTimeString().slice(0, 5);
  
  return currentTime >= MARKET_HOURS.SQUARE_OFF && currentTime < MARKET_HOURS.CLOSE;
};

module.exports = {
  TIMEZONE,
  MARKET_HOURS,
  getMarketHours,
  isMarketOpen,
  toUTC,
  toIST,
  getISTTime,
  getISTParts,
  formatIST,
  getTodayIST,
  getStartOfDay,
  getEndOfDay,
  getStartOfWeek,
  getEndOfWeek,
  getStartOfMonth,
  getEndOfMonth,
  isWeekend,
  isTradingDay,
  getTimeDifference,
  wait,
  parseTimeString,
  isTimeAfter,
  isTimeBefore,
  shouldSquareOff
};
