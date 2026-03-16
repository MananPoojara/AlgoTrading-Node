const { query } = require("../../database/postgresClient");

const STRIKE_STEPS = {
  "NIFTY 50": 50,
  NIFTY: 50,
  BANKNIFTY: 100,
  "NIFTY BANK": 100,
};

function getStrikeStep(symbol) {
  return STRIKE_STEPS[symbol] || 50;
}

function roundToStrike(symbol, price) {
  const strikeStep = getStrikeStep(symbol);
  return Math.round(Number(price || 0) / strikeStep) * strikeStep;
}

function buildFallbackInstrument(symbol, strike, optionType) {
  return `${symbol} ${strike} ${optionType}`;
}

async function resolveAtmOptionInstrument({
  symbol,
  spotPrice,
  optionType = "CE",
}) {
  const strike = roundToStrike(symbol, spotPrice);
  const fallbackInstrument = buildFallbackInstrument(symbol, strike, optionType);

  try {
    const result = await query(
      `SELECT 
         COALESCE(trading_symbol, symbol) AS instrument,
         token,
         symbol,
         expiry
       FROM instruments
       WHERE (
         symbol = $1
         OR underlying = $1
         OR tradingsymbol ILIKE $2
         OR trading_symbol ILIKE $2
       )
       AND (
         instrumenttype = $3
         OR option_type = $3
         OR tradingsymbol ILIKE $4
         OR trading_symbol ILIKE $4
       )
       ORDER BY expiry ASC NULLS LAST
       LIMIT 1`,
      [symbol, `%${strike}%`, optionType, `%${optionType}%`],
    );

    if (result.rows.length > 0) {
      return {
        instrument: result.rows[0].instrument,
        instrumentToken: result.rows[0].token || null,
        strike,
        optionType,
        source: "database",
      };
    }
  } catch (error) {
    return {
      instrument: fallbackInstrument,
      instrumentToken: null,
      strike,
      optionType,
      source: "fallback",
      warning: error.message,
    };
  }

  return {
    instrument: fallbackInstrument,
    instrumentToken: null,
    strike,
    optionType,
    source: "fallback",
  };
}

module.exports = {
  resolveAtmOptionInstrument,
  roundToStrike,
};
