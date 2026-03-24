const {
  OrderStateMachine,
  ORDER_STATES,
} = require("../../apps/order-manager/src/orderStateMachine");

describe("OrderStateMachine", () => {
  it("allows queued paper orders to acknowledge and then fill", () => {
    const machine = new OrderStateMachine(ORDER_STATES.QUEUED);

    expect(machine.canTransition(ORDER_STATES.ACKNOWLEDGED)).toBe(true);
    machine.transition(ORDER_STATES.ACKNOWLEDGED);
    expect(machine.canTransition(ORDER_STATES.FILLED)).toBe(true);
  });

  it("allows created orders to fail fast on infrastructure errors", () => {
    const machine = new OrderStateMachine(ORDER_STATES.CREATED);

    expect(machine.canTransition(ORDER_STATES.FAILED)).toBe(true);
  });
});
