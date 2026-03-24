require("../core/bootstrap/loadEnv").loadEnv();
const { childLogger } = require("../core/logger/logger");
const { getPublisher } = require("../core/eventBus/publisher");
const { close, query } = require("../database/postgresClient");
const {
  evaluateSchedulerWindow,
  getMinutesSinceMidnight,
  parseTimeToMinutes,
} = require("./marketClock");
const { MarketDataRetentionService } = require("./marketDataRetention");
const { formatIST } = require("../core/utils/time");
const config = require("../../config/default");

const logger = childLogger("market-scheduler");

class MarketScheduler {
  constructor(options = {}) {
    this.publisher = options.publisher || getPublisher();
    this.retentionService =
      options.retentionService || new MarketDataRetentionService();
    this.schedule = options.schedule || config.scheduler;
    this.now = options.now || (() => new Date());
    this.interval = null;
  }

  async start() {
    if (!this.schedule.enabled) {
      logger.warn("Market scheduler disabled");
      return;
    }

    await this.runCycle();
    this.interval = setInterval(() => {
      this.runCycle().catch((error) => {
        logger.error("Market scheduler cycle failed", { error: error.message });
      });
    }, this.schedule.pollMs);

    logger.info("Market scheduler started", {
      feedStart: this.schedule.feedStart,
      strategyStart: this.schedule.strategyStart,
      strategyPause: this.schedule.strategyPause,
      feedStop: this.schedule.feedStop,
    });
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info("Market scheduler stopped");
  }

  async runCycle() {
    const now = this.now();
    const windowState = evaluateSchedulerWindow(now, this.schedule);

    await this.ensureMarketDataState(windowState);
    await this.ensureSquareOffState(windowState);
    await this.ensureSquareOffOpenPositionAlert(now, windowState);
    await this.ensureStrategyState(windowState);

    if (windowState.archiveShouldRun) {
      await this.runRetentionIfNeeded(windowState.tradingDate);
    }
  }

  async ensureMarketDataState(windowState) {
    const desiredState = windowState.feedShouldRun ? "running" : "stopped";
    const currentState = await this.getState("market_data_state");

    if (currentState?.desired === desiredState) {
      return;
    }

    await this.publisher.publishMarketDataControl({
      command: desiredState === "running" ? "start_feed" : "stop_feed",
    });
    await this.setState("market_data_state", {
      desired: desiredState,
      tradingDate: windowState.tradingDate,
      updatedAt: formatIST(),
    });
    await this.publisher.publishSystemAlert({
      level: "INFO",
      service: "market-scheduler",
      message: `Scheduler set market-data to ${desiredState}`,
      trading_day: windowState.tradingDate,
    });
  }

  async ensureStrategyState(windowState) {
    const desiredState = windowState.strategiesShouldRun ? "running" : "paused";
    const currentState = await this.getState("strategy_runtime_state");

    if (currentState?.desired === desiredState) {
      return;
    }

    if (desiredState === "running") {
      await this.resumeScheduledStrategies(windowState.tradingDate);
    } else {
      await this.pauseManagedStrategies(windowState.tradingDate);
    }
  }

  async ensureSquareOffState(windowState) {
    if (!windowState.squareOffShouldRun) {
      return;
    }

    const currentState = await this.getState("last_square_off_run");
    if (currentState?.tradingDate === windowState.tradingDate) {
      return;
    }

    await this.squareOffManagedStrategies(windowState.tradingDate);
  }

  async pauseManagedStrategies(tradingDate) {
    const result = await query(
      `UPDATE strategy_instances
       SET status = 'paused',
           scheduler_paused = TRUE,
           updated_at = NOW()
       WHERE auto_managed = TRUE
         AND status = 'running'`,
    );

    await this.publisher.publishStrategyControl({
      command: "pause_all_strategies",
    });
    await this.setState("strategy_runtime_state", {
      desired: "paused",
      tradingDate,
      updatedAt: formatIST(),
      affectedRows: result.rowCount,
    });
    await this.publisher.publishSystemAlert({
      level: "INFO",
      service: "market-scheduler",
      message: `Scheduler paused ${result.rowCount} strategy instance(s)`,
      trading_day: tradingDate,
    });
  }

  async squareOffManagedStrategies(tradingDate) {
    const result = await query(
      `UPDATE strategy_instances
       SET status = 'paused',
           scheduler_paused = TRUE,
           updated_at = NOW()
       WHERE auto_managed = TRUE
         AND status = 'running'`,
    );

    await this.publisher.publishStrategyControl({
      command: "square_off_all_strategies",
      reason: "intraday_square_off",
    });
    await this.setState("last_square_off_run", {
      tradingDate,
      updatedAt: formatIST(),
      affectedRows: result.rowCount,
    });
    await this.setState("strategy_runtime_state", {
      desired: "paused",
      tradingDate,
      updatedAt: formatIST(),
      affectedRows: result.rowCount,
      reason: "square_off",
    });
    await this.publisher.publishSystemAlert({
      level: "INFO",
      service: "market-scheduler",
      message: `Scheduler squared off ${result.rowCount} strategy instance(s)`,
      trading_day: tradingDate,
    });
  }

  async ensureSquareOffOpenPositionAlert(now, windowState) {
    const squareOffMinutes = parseTimeToMinutes(
      this.schedule.squareOff || config.marketHours.squareOff,
    );
    const alertThresholdMinutes = squareOffMinutes + 10;

    if (getMinutesSinceMidnight(now) < alertThresholdMinutes) {
      return;
    }

    const currentState = await this.getState("last_square_off_still_open_alert");
    if (currentState?.tradingDate === windowState.tradingDate) {
      return;
    }

    const result = await query(
      `SELECT COUNT(*) AS open_positions
       FROM positions p
       JOIN strategy_instances si ON si.id = p.strategy_instance_id
       WHERE si.auto_managed = TRUE
         AND p.position > 0`,
    );

    const openPositions = Number(result.rows[0]?.open_positions || 0);
    if (openPositions <= 0) {
      return;
    }

    await this.setState("last_square_off_still_open_alert", {
      tradingDate: windowState.tradingDate,
      updatedAt: formatIST(),
      openPositions,
      thresholdTime: "15:25",
    });
    await this.publisher.publishSystemAlert({
      level: "CRITICAL",
      service: "market-scheduler",
      message: `${openPositions} auto-managed position(s) still open after square-off`,
      trading_day: windowState.tradingDate,
      open_positions: openPositions,
      threshold_time: "15:25",
    });
  }

  async resumeScheduledStrategies(tradingDate) {
    const result = await query(
      `UPDATE strategy_instances
       SET status = 'running',
           scheduler_paused = FALSE,
           updated_at = NOW()
       WHERE auto_managed = TRUE
         AND status = 'paused'
         AND scheduler_paused = TRUE`,
    );

    await this.publisher.publishStrategyControl({
      command: "resume_all_strategies",
    });
    await this.setState("strategy_runtime_state", {
      desired: "running",
      tradingDate,
      updatedAt: formatIST(),
      affectedRows: result.rowCount,
    });
    await this.publisher.publishSystemAlert({
      level: "INFO",
      service: "market-scheduler",
      message: `Scheduler resumed ${result.rowCount} strategy instance(s)`,
      trading_day: tradingDate,
    });
  }

  async runRetentionIfNeeded(tradingDate) {
    const lastArchive = await this.getState("last_archive_run");
    if (lastArchive?.tradingDate === tradingDate && lastArchive?.status === "completed") {
      return;
    }

    const results = await this.retentionService.runForTradingDay(tradingDate);
    await this.setState("last_archive_run", {
      tradingDate,
      status: "completed",
      archives: results.length,
      updatedAt: formatIST(),
    });
  }

  async getState(stateKey) {
    const result = await query(
      `SELECT state_value
       FROM scheduler_state
       WHERE state_key = $1`,
      [stateKey],
    );

    return result.rows[0]?.state_value || null;
  }

  async setState(stateKey, stateValue) {
    await query(
      `INSERT INTO scheduler_state (state_key, state_value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (state_key)
       DO UPDATE SET
         state_value = EXCLUDED.state_value,
         updated_at = NOW()`,
      [stateKey, JSON.stringify(stateValue)],
    );
  }
}

async function main() {
  const scheduler = new MarketScheduler();

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down...");
    await scheduler.stop();
    await close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down...");
    await scheduler.stop();
    await close();
    process.exit(0);
  });

  try {
    await scheduler.start();
  } catch (error) {
    logger.error("Failed to start market scheduler", { error: error.message });
    await close();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MarketScheduler,
};
