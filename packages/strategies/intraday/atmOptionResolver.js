const { query } = require("../../database/postgresClient");

const STRIKE_STEPS = {
  "NIFTY 50": 50,
  NIFTY: 50,
  BANKNIFTY: 100,
  "NIFTY BANK": 100,
};
const SYMBOL_ALIASES = {
  NIFTY: ["NIFTY", "NIFTY 50"],
  "NIFTY 50": ["NIFTY 50", "NIFTY"],
  BANKNIFTY: ["BANKNIFTY", "NIFTY BANK"],
  "NIFTY BANK": ["NIFTY BANK", "BANKNIFTY"],
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

function expandSymbolAliases(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  return SYMBOL_ALIASES[normalized] || [normalized];
}

async function resolveAtmOptionInstrument({
  symbol,
  spotPrice,
  optionType = "CE",
}) {
  const strike = roundToStrike(symbol, spotPrice);
  const normalizedOptionType = String(optionType || "CE").trim().toUpperCase();
  const symbolAliases = expandSymbolAliases(symbol);
  const fallbackInstrument = buildFallbackInstrument(symbol, strike, optionType);

  try {
    const result = await query(
      `SELECT 
         symbol AS instrument,
         instrument_token,
         symbol,
         expiry_date,
         strike
       FROM instruments
       WHERE is_active = TRUE
         AND (
           UPPER(symbol) = ANY($1::text[])
           OR UPPER(COALESCE(underlying_symbol, '')) = ANY($1::text[])
         )
         AND UPPER(COALESCE(option_type, '')) = $2
       ORDER BY
         CASE WHEN strike IS NULL THEN 1 ELSE 0 END,
         ABS(COALESCE(strike, $3) - $3) ASC,
         expiry_date ASC NULLS LAST,
         symbol ASC
       LIMIT 1`,
      [symbolAliases, normalizedOptionType, strike],
    );

    if (result.rows.length > 0) {
      return {
        instrument: result.rows[0].instrument,
        instrumentToken: result.rows[0].instrument_token || null,
        strike,
        optionType: normalizedOptionType,
        source: "database",
      };
    }
  } catch (error) {
    return {
      instrument: fallbackInstrument,
      instrumentToken: null,
      strike,
      optionType: normalizedOptionType,
      source: "fallback",
      warning: error.message,
    };
  }

  return {
    instrument: fallbackInstrument,
    instrumentToken: null,
    strike,
    optionType: normalizedOptionType,
    source: "fallback",
  };
}

module.exports = {
  resolveAtmOptionInstrument,
  roundToStrike,
  expandSymbolAliases,
};
