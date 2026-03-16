jest.mock("../src/database/postgresClient", () => ({
  query: jest.fn(),
}));

const { query } = require("../src/database/postgresClient");
const { ClientStrategyMapper } = require("../src/strategyEngine/clientStrategyMapper");

describe("ClientStrategyMapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads instance parameters from strategy_instances for active strategies", async () => {
    query.mockResolvedValue({
      rows: [
        {
          instance_id: 5,
          client_id: 1,
          instance_status: "running",
          strategy_id: 6,
          strategy_name: "STRATEGY1_LIVE",
          strategy_type: "intraday",
          file_path: "src/strategies/intraday/strategy1Live.js",
          instance_parameters: {
            symbol: "NIFTY 50",
            historyPath: "/app/data/history/NIFTY_50.csv",
            evaluationMode: "1m_close",
          },
          client_name: "Client A",
        },
      ],
    });

    const mapper = new ClientStrategyMapper();
    const mappings = await mapper.loadFromDatabase();

    expect(query).toHaveBeenCalledTimes(1);
    expect(mappings.get(5)).toMatchObject({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        historyPath: "/app/data/history/NIFTY_50.csv",
        evaluationMode: "1m_close",
      },
      status: "running",
    });
  });
});
