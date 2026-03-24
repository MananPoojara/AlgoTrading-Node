const fs = require("fs");
const path = require("path");
const { childLogger } = require("../core/logger/logger");
const { getPublisher } = require("../core/eventBus/publisher");
const { getClient, query } = require("../database/postgresClient");
const { formatIST } = require("../core/utils/time");
const config = require("../../config/default");

const logger = childLogger("market-data-retention");

function sanitizeFileSegment(value) {
  return String(value || "UNKNOWN")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

class MarketDataRetentionService {
  constructor(options = {}) {
    this.archiveRoot = options.archiveRoot || config.scheduler.archiveRoot;
    this.archivePathPrefix = options.archivePathPrefix || "data/market-archive";
    this.archiveBatchSize =
      options.archiveBatchSize || config.scheduler.archiveBatchSize;
    this.publisher = options.publisher || getPublisher();
  }

  async runForTradingDay(tradingDay) {
    const symbols = await this.loadTickSourcesForTradingDay(tradingDay);
    const results = [];

    for (const source of symbols) {
      const result = await this.archiveSourceForTradingDay(source, tradingDay);
      results.push(result);
    }

    return results;
  }

  async loadTickSourcesForTradingDay(tradingDay) {
    const result = await query(
      `SELECT DISTINCT instrument_token, symbol, exchange
       FROM market_ticks
       WHERE timestamp::date = $1::date
       ORDER BY symbol ASC`,
      [tradingDay],
    );

    return result.rows;
  }

  async archiveSourceForTradingDay(source, tradingDay) {
    const client = await getClient();
    const archivePath = this.buildArchivePath(tradingDay, source.symbol);

    try {
      await client.query("BEGIN");

      const rowCount = await this.writeRawTickArchive({
        client,
        tradingDay,
        source,
        archivePath: archivePath.physicalPath,
      });
      const candleCount = await this.aggregateOneMinuteCandles({
        client,
        tradingDay,
        source,
      });
      await this.deleteRawTicks({
        client,
        tradingDay,
        source,
      });
      await this.upsertArchiveStatus({
        client,
        tradingDay,
        source,
        archivePath: archivePath.persistedPath,
        rowCount,
        candleCount,
        status: "completed",
      });

      await client.query("COMMIT");
      await this.publishArchiveAlert("INFO", source, tradingDay, rowCount, candleCount);

      return {
        ...source,
        tradingDay,
        archivePath: archivePath.persistedPath,
        rowCount,
        candleCount,
        status: "completed",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await this.recordArchiveFailure({
        tradingDay,
        source,
        archivePath: archivePath.persistedPath,
        error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  buildArchivePath(tradingDay, symbol) {
    const fileName = `${sanitizeFileSegment(symbol)}.csv`;
    const physicalDir = path.join(this.archiveRoot, tradingDay);
    const persistedDir = path.posix.join(this.archivePathPrefix, tradingDay);

    fs.mkdirSync(physicalDir, { recursive: true });

    return {
      physicalPath: path.join(physicalDir, fileName),
      persistedPath: path.posix.join(persistedDir, fileName),
    };
  }

  async writeRawTickArchive({ client, tradingDay, source, archivePath }) {
    const stream = fs.createWriteStream(archivePath, { encoding: "utf8" });
    stream.write(
      "id,instrument_token,symbol,exchange,ltp,open,high,low,close,volume,bid,ask,bid_quantity,ask_quantity,timestamp\n",
    );

    let lastId = 0;
    let totalRows = 0;

    try {
      while (true) {
        const result = await client.query(
          `SELECT id, instrument_token, symbol, exchange, ltp, open, high, low, close,
                  volume, bid, ask, bid_quantity, ask_quantity, timestamp
           FROM market_ticks
           WHERE timestamp::date = $1::date
             AND instrument_token = $2
             AND id > $3
           ORDER BY id ASC
           LIMIT $4`,
          [tradingDay, source.instrument_token, lastId, this.archiveBatchSize],
        );

        if (result.rows.length === 0) {
          break;
        }

        for (const row of result.rows) {
          stream.write(
            [
              row.id,
              row.instrument_token,
              row.symbol,
              row.exchange,
              row.ltp,
              row.open,
              row.high,
              row.low,
              row.close,
              row.volume,
              row.bid,
              row.ask,
              row.bid_quantity,
              row.ask_quantity,
              formatIST(row.timestamp),
            ].join(",") + "\n",
          );
        }

        totalRows += result.rows.length;
        lastId = result.rows[result.rows.length - 1].id;
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }

    return totalRows;
  }

  async aggregateOneMinuteCandles({ client, tradingDay, source }) {
    const result = await client.query(
      `WITH base AS (
         SELECT
           instrument_token,
           symbol,
           exchange,
           date_trunc('minute', timestamp) AS candle_time,
           timestamp,
           id,
           ltp,
           volume
         FROM market_ticks
         WHERE timestamp::date = $1::date
           AND instrument_token = $2
       ),
       aggregated AS (
         SELECT
           instrument_token,
           symbol,
           exchange,
           $1::date AS trading_day,
           candle_time,
           MIN(ltp) AS low,
           MAX(ltp) AS high,
           COALESCE(SUM(volume), 0) AS volume,
           COUNT(*) AS ticks_count
         FROM base
         GROUP BY instrument_token, symbol, exchange, candle_time
       ),
       open_ticks AS (
         SELECT DISTINCT ON (instrument_token, candle_time)
           instrument_token,
           candle_time,
           ltp AS open
         FROM base
         ORDER BY instrument_token, candle_time, timestamp ASC, id ASC
       ),
       close_ticks AS (
         SELECT DISTINCT ON (instrument_token, candle_time)
           instrument_token,
           candle_time,
           ltp AS close
         FROM base
         ORDER BY instrument_token, candle_time, timestamp DESC, id DESC
       ),
       upserted AS (
         INSERT INTO market_ohlc_1m (
           instrument_token, symbol, exchange, trading_day, candle_time,
           open, high, low, close, volume, ticks_count
         )
         SELECT
           aggregated.instrument_token,
           aggregated.symbol,
           aggregated.exchange,
           aggregated.trading_day,
           aggregated.candle_time,
           open_ticks.open,
           aggregated.high,
           aggregated.low,
           close_ticks.close,
           aggregated.volume,
           aggregated.ticks_count
         FROM aggregated
         JOIN open_ticks
           ON open_ticks.instrument_token = aggregated.instrument_token
          AND open_ticks.candle_time = aggregated.candle_time
         JOIN close_ticks
           ON close_ticks.instrument_token = aggregated.instrument_token
          AND close_ticks.candle_time = aggregated.candle_time
         ON CONFLICT (instrument_token, candle_time)
         DO UPDATE SET
           symbol = EXCLUDED.symbol,
           exchange = EXCLUDED.exchange,
           trading_day = EXCLUDED.trading_day,
           open = EXCLUDED.open,
           high = EXCLUDED.high,
           low = EXCLUDED.low,
           close = EXCLUDED.close,
           volume = EXCLUDED.volume,
           ticks_count = EXCLUDED.ticks_count,
           updated_at = NOW()
         RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM upserted`,
      [tradingDay, source.instrument_token],
    );

    return result.rows[0]?.count || 0;
  }

  async deleteRawTicks({ client, tradingDay, source }) {
    await client.query(
      `DELETE FROM market_ticks
       WHERE timestamp::date = $1::date
         AND instrument_token = $2`,
      [tradingDay, source.instrument_token],
    );
  }

  async upsertArchiveStatus({
    client,
    tradingDay,
    source,
    archivePath,
    rowCount = 0,
    candleCount = 0,
    status,
    errorMessage = null,
  }) {
    await client.query(
      `INSERT INTO market_tick_archives (
         trading_day, instrument_token, symbol, archive_path,
         row_count, candle_count, status, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (trading_day, instrument_token)
       DO UPDATE SET
         archive_path = EXCLUDED.archive_path,
         row_count = EXCLUDED.row_count,
         candle_count = EXCLUDED.candle_count,
         status = EXCLUDED.status,
         error_message = EXCLUDED.error_message,
         updated_at = NOW()`,
      [
        tradingDay,
        source.instrument_token,
        source.symbol,
        archivePath,
        rowCount,
        candleCount,
        status,
        errorMessage,
      ],
    );
  }

  async recordArchiveFailure({ tradingDay, source, archivePath, error }) {
    logger.error("Market tick archive failed", {
      tradingDay,
      symbol: source.symbol,
      instrumentToken: source.instrument_token,
      error: error.message,
    });

    await query(
      `INSERT INTO market_tick_archives (
         trading_day, instrument_token, symbol, archive_path,
         row_count, candle_count, status, error_message
       )
       VALUES ($1, $2, $3, $4, 0, 0, 'failed', $5)
       ON CONFLICT (trading_day, instrument_token)
       DO UPDATE SET
         archive_path = EXCLUDED.archive_path,
         status = EXCLUDED.status,
         error_message = EXCLUDED.error_message,
         updated_at = NOW()`,
      [
        tradingDay,
        source.instrument_token,
        source.symbol,
        archivePath,
        error.message,
      ],
    ).catch((upsertError) => {
      logger.error("Failed to record archive failure", {
        tradingDay,
        symbol: source.symbol,
        error: upsertError.message,
      });
    });

    await this.publishArchiveAlert("ERROR", source, tradingDay, 0, 0, error.message);
  }

  async publishArchiveAlert(level, source, tradingDay, rowCount, candleCount, error = null) {
    if (!this.publisher?.publishSystemAlert) {
      return;
    }

    await this.publisher.publishSystemAlert({
      level,
      service: "market-data-retention",
      message:
        error ||
        `Archived ${rowCount} raw ticks and retained ${candleCount} 1m candles for ${source.symbol} on ${tradingDay}`,
      trading_day: tradingDay,
      symbol: source.symbol,
      instrument_token: source.instrument_token,
      row_count: rowCount,
      candle_count: candleCount,
    });
  }
}

module.exports = {
  MarketDataRetentionService,
  sanitizeFileSegment,
};
