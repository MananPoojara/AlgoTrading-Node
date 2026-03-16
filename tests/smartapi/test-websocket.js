require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const { TOTP } = require("totp-generator");

const OUTPUT_DIR = path.join(__dirname, "output");
const TOKEN_MAP = {
  "3045": "SBIN-EQ",
  "11536": "RELIANCE-EQ",
  "1594": "TCS-EQ",
  "10794": "INFY-EQ",
  "3456": "HDFCBANK-EQ",
  "4963": "ICICIBANK-EQ",
  "4106": "HINDUNILVR-EQ",
  "2708": "KOTAKBANK-EQ",
};
const TOKENS = Object.keys(TOKEN_MAP);
const MARKET_CLOSE = process.env.SMARTAPI_CAPTURE_UNTIL
  ? new Date(process.env.SMARTAPI_CAPTURE_UNTIL)
  : new Date("2026-03-13T15:30:00+05:30");

function generateTotp(secret) {
  const result = TOTP.generate(secret);
  return typeof result === "object" ? result.otp : result;
}

function formatIstTimestamp(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(date)
    .replace(" ", "T");
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const stringValue = String(value);
  if (
    stringValue.includes(",") ||
    stringValue.includes("\"") ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }
  return stringValue;
}

function normalizeToken(token) {
  return String(token || "").replace(/^"+|"+$/g, "");
}

function makeOutputPaths() {
  const stamp = formatIstTimestamp(new Date()).replace(/:/g, "-");
  return {
    csvPath: path.join(OUTPUT_DIR, `smartapi_ticks_${stamp}.csv`),
    rawPath: path.join(OUTPUT_DIR, `smartapi_ticks_${stamp}.jsonl`),
    logPath: path.join(OUTPUT_DIR, `smartapi_ticks_${stamp}.log`),
  };
}

async function main() {
  if (new Date() >= MARKET_CLOSE) {
    throw new Error(
      "Current time is already past 2026-03-13 15:30:00 IST. No capture started.",
    );
  }

  const apiKey = process.env.ANGEL_ONE_API_KEY;
  const clientCode = process.env.ANGEL_ONE_CLIENT_CODE;
  const password = process.env.ANGEL_ONE_PASSWORD;
  const totpSecret = process.env.ANGEL_ONE_TOTP_SECRET;

  if (!apiKey || !clientCode || !password || !totpSecret) {
    throw new Error("Missing SmartAPI credentials in tests/smartapi/.env");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { csvPath, rawPath, logPath } = makeOutputPaths();
  const csvStream = fs.createWriteStream(csvPath, { flags: "a" });
  const rawStream = fs.createWriteStream(rawPath, { flags: "a" });
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    logStream.write(`${line}\n`);
  };

  csvStream.write(
    "received_at_ist,received_at_epoch_ms,subscription_mode,exchange_type,token,symbol,sequence_number,exchange_timestamp,last_traded_price_raw,last_traded_price,raw_json\n",
  );

  const smartApi = new SmartAPI({ api_key: apiKey });
  const session = await smartApi.generateSession(
    clientCode,
    password,
    generateTotp(totpSecret),
  );

  if (!session?.status || !session?.data?.jwtToken || !session?.data?.feedToken) {
    throw new Error(`Session creation failed: ${JSON.stringify(session)}`);
  }

  const webSocket = new WebSocketV2({
    jwttoken: session.data.jwtToken,
    apikey: apiKey,
    clientcode: clientCode,
    feedtype: session.data.feedToken,
  });

  let tickCount = 0;
  let stopTimer = null;
  let terminalTimer = null;
  let shutdownStarted = false;
  const latestByToken = new Map();

  const shutdown = async (reason) => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    log(`Stopping capture: ${reason}`);
    try {
      webSocket.close();
    } catch (error) {
      log(`WebSocket close error: ${error.message}`);
    }
    try {
      await smartApi.logout(clientCode);
    } catch (error) {
      log(`Logout error: ${error.message}`);
    }
    csvStream.end();
    rawStream.end();
    logStream.end();
    if (terminalTimer) {
      clearInterval(terminalTimer);
      terminalTimer = null;
    }
  };

  const msUntilClose = Math.max(MARKET_CLOSE.getTime() - Date.now(), 1);
  stopTimer = setTimeout(() => {
    shutdown("Reached scheduled cutoff at 15:30 IST")
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  }, msUntilClose);

  process.on("SIGINT", async () => {
    clearTimeout(stopTimer);
    await shutdown("Received SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    clearTimeout(stopTimer);
    await shutdown("Received SIGTERM");
    process.exit(0);
  });

  webSocket.on("tick", (tick) => {
    const now = new Date();
    const token = normalizeToken(tick.token);
    const lastTradedPriceRaw = Number(tick.last_traded_price);
    const record = {
      received_at_ist: formatIstTimestamp(now),
      received_at_epoch_ms: now.getTime(),
      subscription_mode: tick.subscription_mode,
      exchange_type: tick.exchange_type,
      token,
      symbol: TOKEN_MAP[token] || "",
      sequence_number: tick.sequence_number,
      exchange_timestamp: tick.exchange_timestamp,
      last_traded_price_raw: lastTradedPriceRaw,
      last_traded_price: Number.isFinite(lastTradedPriceRaw)
        ? lastTradedPriceRaw / 100
        : "",
      raw_json: JSON.stringify(tick),
    };

    rawStream.write(`${record.raw_json}\n`);
    csvStream.write(
      [
        record.received_at_ist,
        record.received_at_epoch_ms,
        record.subscription_mode,
        record.exchange_type,
        record.token,
        record.symbol,
        record.sequence_number,
        record.exchange_timestamp,
        record.last_traded_price_raw,
        record.last_traded_price,
        record.raw_json,
      ]
        .map(csvEscape)
        .join(",") + "\n",
    );

    tickCount += 1;
    latestByToken.set(record.token, record);
  });

  log(`CSV output: ${csvPath}`);
  log(`Raw output: ${rawPath}`);
  log(`Log output: ${logPath}`);
  log(`Scheduled stop: ${MARKET_CLOSE.toISOString()}`);

  await webSocket.connect();
  log("WebSocket connected");
  webSocket.fetchData({
    correlationID: "tick-capture",
    action: 1,
    mode: 1,
    exchangeType: 1,
    tokens: TOKENS,
  });
  log(`Subscribed to ${TOKENS.length} NSE cash tokens`);

  terminalTimer = setInterval(() => {
    const timestamp = formatIstTimestamp(new Date()).replace("T", " ");
    const parts = TOKENS.map((token) => {
      const record = latestByToken.get(token);
      const symbol = TOKEN_MAP[token] || token;
      const ltp =
        record && record.last_traded_price !== ""
          ? Number(record.last_traded_price).toFixed(2)
          : "--";
      return `${symbol}:${ltp}`;
    });
    console.log(`[${timestamp}] ${parts.join(" | ")}`);
  }, 1000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
