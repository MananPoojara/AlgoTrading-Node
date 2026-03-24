const fs = require("fs");
const http = require("http");

const DOCKER_SOCKET_PATH =
  process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

const CORE_SERVICES = [
  {
    key: "market-data-service",
    label: "Market Data",
    containerName: "algo-market-data",
  },
  {
    key: "strategy-engine",
    label: "Strategy Engine",
    containerName: "algo-strategy-engine",
  },
  {
    key: "order-manager",
    label: "Order Manager",
    containerName: "algo-order-manager",
  },
  {
    key: "api-server",
    label: "API Server",
    containerName: "algo-api",
  },
  {
    key: "market-scheduler",
    label: "Market Scheduler",
    containerName: "algo-market-scheduler",
  },
];

const DEFAULT_LOG_LEVELS = ["warn", "error"];
const ALL_LOG_LEVELS = ["debug", "info", "warn", "error"];
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;

function getCoreServices() {
  return CORE_SERVICES.map((service) => ({ ...service }));
}

function hasDockerSocket() {
  return fs.existsSync(DOCKER_SOCKET_PATH);
}

function dockerRequest(path) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path,
        method: "GET",
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          if (response.statusCode >= 400) {
            reject(
              new Error(
                `Docker API request failed (${response.statusCode}): ${path}`,
              ),
            );
            return;
          }

          resolve(body);
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE_REGEX, "");
}

function parseLevelFromMessage(message) {
  const cleaned = stripAnsi(message).trim();
  const matches = cleaned.match(
    /(?:\d{4}-\d{2}-\d{2}T[^\s]+\s+)?\[.*?\]\s+([A-Za-z]+):\s*(.*)$/,
  );

  if (matches) {
    return {
      level: matches[1].toLowerCase(),
      message: matches[2].trim(),
    };
  }

  return {
    level: "info",
    message: cleaned,
  };
}

function parseDockerLogLine(serviceKey, line) {
  const cleanedLine = stripAnsi(line).trim();
  if (!cleanedLine) {
    return null;
  }

  const outerTimestampMatch = cleanedLine.match(
    /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+([\s\S]+)$/,
  );

  const timestamp = outerTimestampMatch
    ? outerTimestampMatch[1]
    : new Date().toISOString();
  const payload = outerTimestampMatch ? outerTimestampMatch[2] : cleanedLine;
  const parsedPayload = parseLevelFromMessage(payload);

  return {
    id: `${serviceKey}:${timestamp}:${Buffer.from(cleanedLine).toString("base64")}`,
    timestamp,
    service: serviceKey,
    level: ALL_LOG_LEVELS.includes(parsedPayload.level)
      ? parsedPayload.level
      : "info",
    message: parsedPayload.message,
    raw: payload.trim(),
    source: "docker",
  };
}

function normalizeRequestedServices(value) {
  if (!value) {
    return CORE_SERVICES.map((service) => service.key);
  }

  const allowed = new Set(CORE_SERVICES.map((service) => service.key));
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => allowed.has(entry));
}

function normalizeRequestedLevels(value) {
  if (!value) {
    return [...DEFAULT_LOG_LEVELS];
  }

  const requested = String(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => ALL_LOG_LEVELS.includes(entry));

  return requested.length > 0 ? requested : [...DEFAULT_LOG_LEVELS];
}

function filterLogRecordsByLevels(records, levels) {
  const allowed = new Set(levels);
  return records.filter((record) => allowed.has(record.level));
}

async function fetchContainerInspect(containerName) {
  const response = await dockerRequest(
    `/containers/${encodeURIComponent(containerName)}/json`,
  );
  return JSON.parse(response);
}

async function fetchContainerLogs(containerName, options = {}) {
  const params = new URLSearchParams({
    stdout: "1",
    stderr: "1",
    timestamps: "1",
    tail: String(options.tail || 200),
  });

  if (options.since) {
    params.set("since", String(options.since));
  }

  const response = await dockerRequest(
    `/containers/${encodeURIComponent(containerName)}/logs?${params.toString()}`,
  );

  return response
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function listServiceStatuses() {
  if (!hasDockerSocket()) {
    return CORE_SERVICES.map((service) => ({
      service: service.key,
      label: service.label,
      container_name: service.containerName,
      running: false,
      healthy: false,
      available: false,
      last_seen_log_at: null,
      last_error_at: null,
      status: "docker_socket_unavailable",
    }));
  }

  return Promise.all(
    CORE_SERVICES.map(async (service) => {
      try {
        const [inspect, lines] = await Promise.all([
          fetchContainerInspect(service.containerName),
          fetchContainerLogs(service.containerName, { tail: 60 }),
        ]);

        const records = lines
          .map((line) => parseDockerLogLine(service.key, line))
          .filter(Boolean);
        const lastSeen = records[records.length - 1]?.timestamp || null;
        const lastError =
          [...records].reverse().find((record) => record.level === "error")
            ?.timestamp || null;
        const healthStatus = inspect.State?.Health?.Status || null;
        const running = inspect.State?.Running === true;

        return {
          service: service.key,
          label: service.label,
          container_name: service.containerName,
          running,
          healthy: running && (healthStatus ? healthStatus === "healthy" : true),
          available: true,
          last_seen_log_at: lastSeen,
          last_error_at: lastError,
          status: healthStatus || inspect.State?.Status || "unknown",
        };
      } catch (error) {
        return {
          service: service.key,
          label: service.label,
          container_name: service.containerName,
          running: false,
          healthy: false,
          available: false,
          last_seen_log_at: null,
          last_error_at: null,
          status: error.message,
        };
      }
    }),
  );
}

async function listRecentLogs(options = {}) {
  if (!hasDockerSocket()) {
    return [];
  }

  const services = normalizeRequestedServices(options.services);
  const levels = normalizeRequestedLevels(options.levels);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 500);
  const parsedSince = options.since ? Number(options.since) : null;
  const since = Number.isFinite(parsedSince) ? parsedSince : null;
  const serviceMap = new Map(CORE_SERVICES.map((service) => [service.key, service]));

  const recordsByService = await Promise.all(
    services.map(async (serviceKey) => {
      const service = serviceMap.get(serviceKey);
      if (!service) {
        return [];
      }

      try {
        const lines = await fetchContainerLogs(service.containerName, {
          tail: Math.min(Math.max(limit, 50), 250),
          since,
        });

        return lines
          .map((line) => parseDockerLogLine(serviceKey, line))
          .filter(Boolean);
      } catch {
        return [];
      }
    }),
  );

  const filteredRecords = filterLogRecordsByLevels(
    recordsByService.flat(),
    levels,
  );

  return filteredRecords
    .sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime();
      const rightTime = new Date(right.timestamp).getTime();
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

module.exports = {
  ALL_LOG_LEVELS,
  DEFAULT_LOG_LEVELS,
  getCoreServices,
  hasDockerSocket,
  listRecentLogs,
  listServiceStatuses,
  normalizeRequestedLevels,
  normalizeRequestedServices,
  parseDockerLogLine,
  filterLogRecordsByLevels,
};
