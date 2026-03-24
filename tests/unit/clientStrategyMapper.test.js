jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/database/schemaCapabilities", () => ({
  getSchemaCapability: jest.fn(),
  markSchemaCapabilitySupported: jest.fn(),
  markSchemaCapabilityUnsupported: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const {
  getSchemaCapability,
} = require("../../packages/database/schemaCapabilities");
const { ClientStrategyMapper } = require("../../apps/strategy-engine/src/clientStrategyMapper");

describe("ClientStrategyMapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSchemaCapability.mockResolvedValue(true);
  });

  it("falls back to legacy strategy_instances query when runtime_state column is missing", async () => {
    const missingColumnError = new Error("column si.runtime_state does not exist");
    missingColumnError.code = "42703";

    query
      .mockRejectedValueOnce(missingColumnError)
      .mockResolvedValueOnce({
        rows: [
          {
            instance_id: 7,
            client_id: 1,
            strategy_id: 6,
            instance_status: "running",
            strategy_name: "STRATEGY1_LIVE",
            strategy_type: "intraday",
            file_path: "packages/strategies/intraday/strategy1Live.js",
            instance_parameters: { symbol: "NIFTY 50" },
            client_name: "Demo Client",
          },
        ],
      });

    const mapper = new ClientStrategyMapper();
    const mappings = await mapper.loadFromDatabase();

    expect(mappings.get(7)).toMatchObject({
      instanceId: 7,
      parameters: { symbol: "NIFTY 50" },
      runtimeState: {},
    });
  });
});
