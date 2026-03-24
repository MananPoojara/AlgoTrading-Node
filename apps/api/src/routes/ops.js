const express = require("express");
const {
  hasDockerSocket,
  listRecentLogs,
  listServiceStatuses,
  normalizeRequestedLevels,
  normalizeRequestedServices,
} = require("../services/dockerOps");
const { handleApiError } = require("../utils/errorHandler");

const router = express.Router();

router.get("/services", async (req, res) => {
  try {
    const data = await listServiceStatuses();

    res.json({
      success: true,
      data,
      meta: {
        docker_socket_available: hasDockerSocket(),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/ops/services" });
  }
});

router.get("/logs", async (req, res) => {
  try {
    const data = await listRecentLogs({
      services: req.query.services,
      levels: req.query.levels || req.query.level,
      limit: req.query.limit,
      since: req.query.since,
    });

    res.json({
      success: true,
      data,
      meta: {
        services: normalizeRequestedServices(req.query.services),
        levels: normalizeRequestedLevels(req.query.levels || req.query.level),
        limit: Math.min(Math.max(Number(req.query.limit || 200), 1), 500),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/ops/logs" });
  }
});

router.get("/logs/stream", async (req, res) => {
  const services = normalizeRequestedServices(req.query.services);
  const levels = normalizeRequestedLevels(req.query.levels || req.query.level);
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
  const parsedSince = req.query.since ? Number(req.query.since) : null;
  let since = Number.isFinite(parsedSince)
    ? parsedSince
    : Math.max(Math.floor(Date.now() / 1000) - 30, 0);
  const sentIds = new Set();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendEvent("connected", {
    services,
    levels,
    limit,
    docker_socket_available: hasDockerSocket(),
  });

  if (!hasDockerSocket()) {
    sendEvent("error", {
      message: "Docker socket is not available inside the API container",
    });
    res.end();
    return;
  }

  const pollLogs = async () => {
    try {
      const records = await listRecentLogs({
        services,
        levels,
        limit,
        since,
      });

      const unsentRecords = records
        .filter((record) => !sentIds.has(record.id))
        .sort(
          (left, right) =>
            new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
        );

      for (const record of unsentRecords) {
        sendEvent("log", record);
        sentIds.add(record.id);
      }

      if (unsentRecords.length > 0) {
        const maxTimestamp = unsentRecords.reduce((currentMax, record) => {
          const unixSeconds = Math.floor(new Date(record.timestamp).getTime() / 1000);
          return Math.max(currentMax, unixSeconds);
        }, since);

        since = Math.max(maxTimestamp - 1, 0);

        if (sentIds.size > 1000) {
          const recentIds = new Set(
            Array.from(sentIds).slice(Math.max(sentIds.size - 500, 0)),
          );
          sentIds.clear();
          recentIds.forEach((id) => sentIds.add(id));
        }
      }
    } catch (error) {
      sendEvent("error", { message: error.message });
    }
  };

  await pollLogs();
  const interval = setInterval(pollLogs, 2000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});

module.exports = router;
