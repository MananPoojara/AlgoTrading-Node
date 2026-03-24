const { EventEmitter } = require("events");
const { EventSubscriber } = require("../../packages/core/eventBus/subscriber");

describe("EventSubscriber", () => {
  it("fans out messages to multiple handlers on the same channel", async () => {
    const subscriberEmitter = new EventEmitter();
    subscriberEmitter.subscribe = jest.fn().mockResolvedValue(true);
    subscriberEmitter.unsubscribe = jest.fn().mockResolvedValue(true);

    const redisClient = {
      getSubscriber: () => subscriberEmitter,
    };

    const subscriber = new EventSubscriber(redisClient);
    const firstHandler = jest.fn();
    const secondHandler = jest.fn();

    await subscriber.subscribe("strategy_signals", firstHandler);
    await subscriber.subscribe("strategy_signals", secondHandler);

    subscriberEmitter.emit(
      "message",
      "strategy_signals",
      JSON.stringify({ event_id: "sig-1" }),
    );

    expect(firstHandler).toHaveBeenCalledWith({ event_id: "sig-1" });
    expect(secondHandler).toHaveBeenCalledWith({ event_id: "sig-1" });
    expect(subscriberEmitter.subscribe).toHaveBeenCalledTimes(1);
  });
});
