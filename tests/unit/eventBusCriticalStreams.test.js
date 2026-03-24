const mockStreamPublish = jest.fn();
const mockConsumerStart = jest.fn();
const mockConsumerStop = jest.fn();

jest.mock("../../packages/core/eventBus/streamClient", () => ({
  StreamPublisher: jest.fn().mockImplementation(() => ({
    publish: mockStreamPublish,
  })),
  StreamConsumer: jest.fn().mockImplementation(() => ({
    start: mockConsumerStart,
    stop: mockConsumerStop,
  })),
}));

const { StreamConsumer } = require("../../packages/core/eventBus/streamClient");
const { EventPublisher } = require("../../packages/core/eventBus/publisher");
const { EventSubscriber } = require("../../packages/core/eventBus/subscriber");

const makeRedisClient = () => ({
  getPublisher: jest.fn(() => ({ publish: jest.fn() })),
  publish: jest.fn().mockResolvedValue(true),
  getSubscriber: jest.fn(() => ({
    on: jest.fn(),
    subscribe: jest.fn().mockResolvedValue(true),
    unsubscribe: jest.fn().mockResolvedValue(true),
  })),
});

describe("critical event streams", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamPublish.mockResolvedValue("1234-0");
    mockConsumerStart.mockResolvedValue(undefined);
  });

  it("routes order updates through Redis Streams instead of Pub/Sub", async () => {
    const redisClient = makeRedisClient();
    const publisher = new EventPublisher(redisClient);

    await publisher.publishOrderUpdate({ order_id: 51, status: "filled" });

    expect(mockStreamPublish).toHaveBeenCalledWith(
      "order_updates",
      expect.objectContaining({
        event: "order_update",
        order_id: 51,
        status: "filled",
      }),
    );
    expect(redisClient.publish).not.toHaveBeenCalled();
  });

  it("routes rejected orders through Redis Streams instead of Pub/Sub", async () => {
    const redisClient = makeRedisClient();
    const publisher = new EventPublisher(redisClient);

    await publisher.publishRejectedOrder({ event_id: "sig-51", status: "rejected" });

    expect(mockStreamPublish).toHaveBeenCalledWith(
      "rejected_orders",
      expect.objectContaining({
        event: "rejected_order",
        event_id: "sig-51",
        status: "rejected",
      }),
    );
    expect(redisClient.publish).not.toHaveBeenCalled();
  });

  it("starts a stream consumer for order updates", async () => {
    const redisClient = makeRedisClient();
    const subscriber = new EventSubscriber(redisClient);
    const handler = jest.fn();

    await subscriber.subscribeToOrderUpdatesStream(handler, {
      groupName: "strategy-workers",
      consumerName: "consumer-1",
    });

    expect(StreamConsumer).toHaveBeenCalledWith(
      redisClient,
      expect.objectContaining({
        streamName: "order_updates",
        groupName: "strategy-workers",
        consumerName: "consumer-1",
        handler,
      }),
    );
    expect(mockConsumerStart).toHaveBeenCalledTimes(1);
  });

  it("starts a stream consumer for rejected orders", async () => {
    const redisClient = makeRedisClient();
    const subscriber = new EventSubscriber(redisClient);
    const handler = jest.fn();

    await subscriber.subscribeToRejectedOrdersStream(handler, {
      groupName: "strategy-workers-rejections",
      consumerName: "consumer-2",
    });

    expect(StreamConsumer).toHaveBeenCalledWith(
      redisClient,
      expect.objectContaining({
        streamName: "rejected_orders",
        groupName: "strategy-workers-rejections",
        consumerName: "consumer-2",
        handler,
      }),
    );
    expect(mockConsumerStart).toHaveBeenCalledTimes(1);
  });
});
