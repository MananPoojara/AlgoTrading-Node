jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const {
  resolveAtmOptionInstrument,
  expandSymbolAliases,
} = require("../../packages/strategies/intraday/atmOptionResolver");

describe("atmOptionResolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves the nearest expiry ATM option using the current instruments schema", async () => {
    query.mockResolvedValue({
      rows: [
        {
          instrument: "NIFTY24MAR23500CE",
          instrument_token: "OPT_23500_CE",
          symbol: "NIFTY24MAR23500CE",
          expiry_date: "2026-03-26",
          strike: "23500",
        },
      ],
    });

    const result = await resolveAtmOptionInstrument({
      symbol: "NIFTY 50",
      spotPrice: 23512,
      optionType: "CE",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("instrument_token"),
      [["NIFTY 50", "NIFTY"], "CE", 23500],
    );
    expect(result).toEqual({
      instrument: "NIFTY24MAR23500CE",
      instrumentToken: "OPT_23500_CE",
      strike: 23500,
      optionType: "CE",
      source: "database",
    });
  });

  it("falls back to a synthetic instrument when the lookup query fails", async () => {
    query.mockRejectedValue(new Error('column "trading_symbol" does not exist'));

    const result = await resolveAtmOptionInstrument({
      symbol: "NIFTY 50",
      spotPrice: 23512,
      optionType: "CE",
    });

    expect(result).toMatchObject({
      instrument: "NIFTY 50 23500 CE",
      instrumentToken: null,
      strike: 23500,
      optionType: "CE",
      source: "fallback",
    });
    expect(result.warning).toContain('trading_symbol');
  });

  it("expands aliases for underlying symbol matching", () => {
    expect(expandSymbolAliases("BANKNIFTY")).toEqual([
      "BANKNIFTY",
      "NIFTY BANK",
    ]);
  });
});
