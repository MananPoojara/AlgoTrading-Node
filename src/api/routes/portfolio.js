const express = require("express");
const { logger } = require("../../core/logger/logger");
const { handleApiError } = require("../utils/errorHandler");
const { getPortfolioService } = require("../../portfolio/portfolioService");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const portfolioService = getPortfolioService(clientId);

    await portfolioService.initialize();
    const portfolio = await portfolioService.getFullPortfolio();

    res.json({
      success: true,
      data: portfolio,
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio" });
  }
});

router.get("/positions", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const portfolioService = getPortfolioService(clientId);

    await portfolioService.initialize();
    const positions = portfolioService.getPositions();

    res.json({
      success: true,
      data: positions,
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/positions" });
  }
});

router.get("/pnl", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { days = 30 } = req.query;

    const portfolioService = getPortfolioService(clientId);
    await portfolioService.initialize();

    const currentPnL = portfolioService.getPnL();
    const historicalPnL = await portfolioService.pnlCalculator.getHistoricalPnL(
      clientId,
      parseInt(days),
    );

    res.json({
      success: true,
      data: {
        current: currentPnL,
        historical: historicalPnL,
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/pnl" });
  }
});

router.get("/margin", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const portfolioService = getPortfolioService(clientId);

    await portfolioService.initialize();
    const margin = portfolioService.getMargin();

    res.json({
      success: true,
      data: margin,
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/margin" });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { getMarginTracker } = require("../../portfolio/marginTracker");
    const marginTracker = getMarginTracker(clientId);

    await marginTracker.syncWithBroker();

    res.json({
      success: true,
      message: "Portfolio synced with broker",
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/sync" });
  }
});

router.post("/snapshot", async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const portfolioService = getPortfolioService(clientId);

    await portfolioService.initialize();
    await portfolioService.createSnapshot();

    res.json({
      success: true,
      message: "Portfolio snapshot created",
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/snapshot" });
  }
});

module.exports = router;
