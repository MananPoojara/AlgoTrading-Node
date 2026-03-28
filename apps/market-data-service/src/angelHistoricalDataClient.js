const loggerModule = require("../../../packages/core/logger/logger");
const { query } = require("../../../packages/database/postgresClient");
const { AngelOneBrokerAPI } = require("../../../packages/broker-adapters/angel-one/angelOneBroker");
const { generateTOTP } = require("../../../packages/core/utils/totp");
const config = require("../../../config/default");

const logger =
  typeof loggerModule.childLogger === "function"
    ? loggerModule.childLogger("angel-historical-data")
    : loggerModule.logger;

const SYMBOL_ALIASES = {
  NIFTY: ["NIFTY 50", "NIFTY"],
  "NIFTY 50": ["NIFTY 50", "NIFTY"],
  BANKNIFTY: ["NIFTY BANK", "BANKNIFTY"],
  "NIFTY BANK": ["NIFTY BANK", "BANKNIFTY"],
  NIFTYBANK: ["NIFTY BANK", "BANKNIFTY"],
};

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

class AngelHistoricalDataClient {
  constructor(options = {}) {
    this.brokerApi = options.brokerApi || null;
    this.now = options.now || (() => Date.now());
    this.sleep =
      options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.enabled = options.enabled ?? config.angelOneHistorical.enabled;
    this.lookbackDays =
      options.lookbackDays ?? config.angelOneHistorical.lookbackDays;
    this.maxDaysPerRequest =
      options.maxDaysPerRequest ?? config.angelOneHistorical.maxDaysPerRequest;
    this.maxRequestsPerSecond =
      options.maxRequestsPerSecond ??
      config.angelOneHistorical.maxRequestsPerSecond;
    this.maxRequestsPerMinute =
      options.maxRequestsPerMinute ??
      config.angelOneHistorical.maxRequestsPerMinute;
    this.rateLimitRetryDelayMs =
      options.rateLimitRetryDelayMs ??
      config.angelOneHistorical.rateLimitRetryDelayMs;
    this.maxRetries =
      options.maxRetries ?? config.angelOneHistorical.maxRetries;
    this.requestTimestamps = [];
  }

  async fetchIntradayBarsForSymbol({
    symbol,
    tradeDate,
    interval = "ONE_MINUTE",
    sessionStart = "09:15",
    sessionEnd = "15:30",
  }) {
    if (!this.enabled || !symbol || !tradeDate) {
      return [];
    }

    const instrument = await this.resolveInstrumentForSymbol(symbol);
    if (!instrument) {
      logger.warn("Unable to resolve instrument for intraday historical fetch", {
        symbol,
        tradeDate,
      });
      return [];
    }

    const rangeDate = new Date(`${tradeDate}T00:00:00.000Z`);
    const candles = await this.fetchHistoricalCandles({
      exchange: instrument.exchange,
      symbolToken: String(instrument.instrument_token),
      interval,
      fromDate: rangeDate,
      toDate: rangeDate,
      sessionStart,
      sessionEnd,
    });

    return candles.map((candle) => ({
      barTime: String(candle[0]),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5] || 0),
      instrument_token: String(instrument.instrument_token),
      symbol: instrument.symbol,
    }));
  }

  async fetchDailyBarsForSymbol({
    symbol,
    lookbackDays = this.lookbackDays,
    interval = "ONE_DAY",
  }) {
    if (!this.enabled || !symbol) {
      return [];
    }

    const instrument = await this.resolveInstrumentForSymbol(symbol);
    if (!instrument) {
      logger.warn("Unable to resolve instrument for historical bootstrap", {
        symbol,
      });
      return [];
    }

    const toDate = new Date(this.now());
    const fromDate = new Date(toDate.getTime());
    fromDate.setUTCDate(fromDate.getUTCDate() - Number(lookbackDays || 0));

    const candles = await this.fetchHistoricalCandles({
      exchange: instrument.exchange,
      symbolToken: String(instrument.instrument_token),
      interval,
      fromDate,
      toDate,
    });

    return candles.map((candle) => ({
      date: String(candle[0]).slice(0, 10),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
    }));
  }

  async resolveInstrumentForSymbol(symbol) {
    const aliases = this.expandAliases(symbol);
    const result = await query(
      `SELECT exchange, symbol, instrument_token
       FROM instruments
       WHERE is_active = TRUE
         AND instrument_type = 'INDEX'
         AND UPPER(symbol) = ANY($1::text[])
       ORDER BY CASE WHEN UPPER(symbol) = $1[1] THEN 0 ELSE 1 END, symbol ASC
       LIMIT 1`,
      [aliases],
    );

    return result.rows[0] || null;
  }

  expandAliases(symbol) {
    const normalized = String(symbol || "").trim().toUpperCase();
    return SYMBOL_ALIASES[normalized] || [normalized];
  }

  async fetchHistoricalCandles({
    exchange,
    symbolToken,
    interval,
    fromDate,
    toDate,
    sessionStart = "09:15",
    sessionEnd = "15:30",
  }) {
    const chunks = this.buildDateChunks(fromDate, toDate, this.maxDaysPerRequest);
    const allCandles = [];

    for (const chunk of chunks) {
      const candles = await this.fetchChunkWithRetry({
        exchange,
        symbolToken,
        interval,
        fromDate: chunk.fromDate,
        toDate: chunk.toDate,
        sessionStart,
        sessionEnd,
      });
      allCandles.push(...candles);
    }

    return allCandles;
  }

  buildDateChunks(fromDate, toDate, maxDaysPerRequest) {
    const chunks = [];
    const maxDays = Math.max(1, Number(maxDaysPerRequest || 1));
    let chunkStart = new Date(fromDate.getTime());

    while (chunkStart <= toDate) {
      const chunkEnd = new Date(chunkStart.getTime());
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays);

      if (chunkEnd > toDate) {
        chunkEnd.setTime(toDate.getTime());
      }

      chunks.push({
        fromDate: new Date(chunkStart.getTime()),
        toDate: new Date(chunkEnd.getTime()),
      });

      chunkStart = new Date(chunkEnd.getTime());
      chunkStart.setUTCDate(chunkStart.getUTCDate() + 1);
    }

    return chunks;
  }

  async fetchChunkWithRetry({
    exchange,
    symbolToken,
    interval,
    fromDate,
    toDate,
    sessionStart = "09:15",
    sessionEnd = "15:30",
  }) {
    const broker = await this.ensureBrokerSession();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForRateLimitSlot();

      const response = await broker.getCandleData({
        exchange,
        symboltoken: symbolToken,
        interval,
        fromdate: this.formatDateTime(fromDate, sessionStart),
        todate: this.formatDateTime(toDate, sessionEnd),
      });

      if (response.success) {
        return Array.isArray(response.data) ? response.data : [];
      }

      if (!this.isRateLimitError(response) || attempt === this.maxRetries) {
        throw new Error(response.error || "Angel historical API request failed");
      }

      logger.warn("Historical API rate limit encountered; waiting before retry", {
        attempt: attempt + 1,
        fromDate: this.formatDateTime(fromDate, sessionStart),
        toDate: this.formatDateTime(toDate, sessionEnd),
      });
      await this.sleep(this.rateLimitRetryDelayMs);
    }

    return [];
  }

  async waitForRateLimitSlot() {
    while (true) {
      const currentTime = this.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (timestamp) => currentTime - timestamp < 60000,
      );

      const lastSecondRequests = this.requestTimestamps.filter(
        (timestamp) => currentTime - timestamp < 1000,
      );
      const waitForSecond =
        lastSecondRequests.length >= this.maxRequestsPerSecond
          ? 1000 - (currentTime - lastSecondRequests[0]) + 1
          : 0;
      const waitForMinute =
        this.requestTimestamps.length >= this.maxRequestsPerMinute
          ? 60000 - (currentTime - this.requestTimestamps[0]) + 1
          : 0;
      const waitMs = Math.max(waitForSecond, waitForMinute, 0);

      if (waitMs <= 0) {
        this.requestTimestamps = [...this.requestTimestamps, currentTime];
        return;
      }

      await this.sleep(waitMs);
    }
  }

  async ensureBrokerSession() {
    if (this.brokerApi?.isConnected) {
      const connected = await this.brokerApi.ensureConnected();
      if (connected.success) {
        return this.brokerApi;
      }
    }

    if (
      !config.angelOneHistorical.apiKey ||
      !config.angelOneHistorical.clientCode ||
      !config.angelOneHistorical.password
    ) {
      throw new Error("Angel historical API credentials are incomplete");
    }

    if (!config.angelOneHistorical.totpSecret) {
      throw new Error(
        "ANGEL_ONE_HISTORICAL_TOTP_SECRET is required for historical API login",
      );
    }

    const brokerApi =
      this.brokerApi ||
      new AngelOneBrokerAPI({
        apiKey: config.angelOneHistorical.apiKey,
        clientCode: config.angelOneHistorical.clientCode,
        password: config.angelOneHistorical.password,
      });

    const totp = generateTOTP(config.angelOneHistorical.totpSecret);
    const loginResult = await brokerApi.login(
      config.angelOneHistorical.clientCode,
      config.angelOneHistorical.password,
      totp,
    );

    if (!loginResult.success) {
      throw new Error(loginResult.error || "Angel historical API login failed");
    }

    this.brokerApi = brokerApi;
    return this.brokerApi;
  }

  isRateLimitError(response = {}) {
    const message = String(response.error || response.message || "").toLowerCase();
    return (
      response.statusCode === 429 ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("exceeding access rate")
    );
  }

  formatDateTime(date, time = "09:15") {
    return `${IST_DATE_FORMATTER.format(date)} ${time}`;
  }
}

let clientInstance = null;

const getAngelHistoricalDataClient = () => {
  if (!clientInstance) {
    clientInstance = new AngelHistoricalDataClient();
  }

  return clientInstance;
};

module.exports = {
  AngelHistoricalDataClient,
  getAngelHistoricalDataClient,
};
