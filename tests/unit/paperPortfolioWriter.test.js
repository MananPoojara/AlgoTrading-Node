const {
  PaperPortfolioWriter,
  calculateNextPositionState,
} = require("../../apps/order-manager/src/paperPortfolioWriter");

describe("calculateNextPositionState", () => {
  it("averages into a long position on repeated buys", () => {
    const next = calculateNextPositionState(
      { position: 10, average_price: 100, realized_pnl: 0 },
      "BUY",
      5,
      110,
    );

    expect(next.position).toBe(15);
    expect(next.averagePrice).toBeCloseTo(103.3333, 3);
    expect(next.realizedPnL).toBe(0);
  });

  it("realizes pnl when selling against an existing long", () => {
    const next = calculateNextPositionState(
      { position: 10, average_price: 100, realized_pnl: 0 },
      "SELL",
      4,
      110,
    );

    expect(next.position).toBe(6);
    expect(next.averagePrice).toBe(100);
    expect(next.realizedDelta).toBe(40);
    expect(next.realizedPnL).toBe(40);
  });

  it("flips from short to long and resets average to fill price", () => {
    const next = calculateNextPositionState(
      { position: -5, average_price: 120, realized_pnl: 10 },
      "BUY",
      8,
      100,
    );

    expect(next.position).toBe(3);
    expect(next.averagePrice).toBe(100);
    expect(next.realizedDelta).toBe(100);
    expect(next.realizedPnL).toBe(110);
  });
});

describe("PaperPortfolioWriter", () => {
  it("records trade, upserts position, and stores a snapshot", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 10, order_id: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 11, client_id: 1, instrument: "NIFTY24APRCE", position: 2 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            symbol: "NIFTY",
            instrument: "NIFTY24APRCE",
            position: 2,
            average_price: 101,
            current_price: 101,
            unrealized_pnl: 0,
            realized_pnl: 0,
            updated_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 12, client_id: 1, total_pnl: 0 }] });

    const writer = new PaperPortfolioWriter({ query });

    const result = await writer.syncAfterFill({
      id: 1,
      client_id: 1,
      strategy_instance_id: 2,
      signal_id: 3,
      symbol: "NIFTY",
      instrument: "NIFTY24APRCE",
      side: "BUY",
      quantity: 2,
    }, 101);

    expect(result.trade.id).toBe(10);
    expect(result.position.id).toBe(11);
    expect(result.snapshot.id).toBe(12);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("updates an existing position row when a sell closes part of a long", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 20, order_id: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 31,
            client_id: 1,
            strategy_instance_id: 2,
            symbol: "NIFTY",
            instrument: "NIFTY24APRPE",
            position: 5,
            average_price: 100,
            realized_pnl: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 31, client_id: 1, instrument: "NIFTY24APRPE", position: 2, realized_pnl: 60 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            symbol: "NIFTY",
            instrument: "NIFTY24APRPE",
            position: 2,
            average_price: 100,
            current_price: 120,
            unrealized_pnl: 0,
            realized_pnl: 60,
            updated_at: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 40, client_id: 1, total_pnl: 60 }] });

    const writer = new PaperPortfolioWriter({ query });

    const result = await writer.syncAfterFill({
      id: 2,
      client_id: 1,
      strategy_instance_id: 2,
      signal_id: 4,
      symbol: "NIFTY",
      instrument: "NIFTY24APRPE",
      side: "SELL",
      quantity: 3,
    }, 120);

    expect(result.position.position).toBe(2);
    expect(result.position.realized_pnl).toBe(60);
    expect(query).toHaveBeenCalledTimes(5);
  });
});
