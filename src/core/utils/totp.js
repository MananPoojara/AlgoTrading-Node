const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function normalizeBase32Secret(secret) {
  return String(secret || "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

function decodeBase32(secret) {
  const normalized = normalizeBase32Secret(secret);

  if (!normalized || normalized.length < 16) {
    throw new Error("TOTP secret is missing or invalid");
  }

  let bits = "";

  for (const char of normalized) {
    const value = BASE32_ALPHABET.indexOf(char);

    if (value === -1) {
      throw new Error("TOTP secret contains invalid base32 characters");
    }

    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];

  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTOTP(secret, options = {}) {
  const digits = options.digits || 6;
  const period = options.period || 30;
  const algorithm = options.algorithm || "sha1";
  const timestampMs = options.timestampMs || Date.now();

  const counter = Math.floor(timestampMs / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const decodedSecret = decodeBase32(secret);
  const hmac = crypto
    .createHmac(algorithm, decodedSecret)
    .update(counterBuffer)
    .digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binaryCode % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

module.exports = {
  generateTOTP,
};
