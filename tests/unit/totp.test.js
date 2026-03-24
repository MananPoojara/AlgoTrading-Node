const { generateTOTP } = require("../../packages/core/utils/totp");

describe("generateTOTP", () => {
  it("matches the RFC 6238 SHA1 test vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    expect(
      generateTOTP(secret, {
        digits: 8,
        timestampMs: 59000,
      }),
    ).toBe("94287082");
  });
});
