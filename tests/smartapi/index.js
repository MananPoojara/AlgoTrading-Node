require("dotenv").config({ path: __dirname + "/.env" });
const axios = require("axios");
const os = require("os");

const API_BASE_URL =
  process.env.ANGEL_ONE_API_URL || "https://apiconnect.angelone.in";
const LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword";
const LOGOUT_PATH = "/rest/secure/angelbroking/user/v1/logout";
const PROFILE_PATH = "/rest/secure/angelbroking/user/v1/getProfile";
const RMS_PATH = "/rest/secure/angelbroking/user/v1/getRMS";
const ORDER_BOOK_PATH = "/rest/secure/angelbroking/order/v1/getOrderBook";
const POSITION_PATH = "/rest/secure/angelbroking/order/v1/getPosition";
const HOLDING_PATH = "/rest/secure/angelbroking/portfolio/v1/getHolding";
const LTP_PATH = "/rest/secure/angelbroking/order/v1/getLtpData";
const PLACE_ORDER_PATH = "/rest/secure/angelbroking/order/v1/placeOrder";
const CANCEL_ORDER_PATH = "/rest/secure/angelbroking/order/v1/cancelOrder";

const SYMBOLS = {
  SBIN: { exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "3045" },
};

class SmartAPITester {
  constructor() {
    this.apiKey = process.env.ANGEL_ONE_API_KEY;
    this.clientCode = process.env.ANGEL_ONE_CLIENT_CODE;
    this.password = process.env.ANGEL_ONE_PASSWORD;
    this.totpSecret = process.env.ANGEL_ONE_TOTP_SECRET;
    this.jwtToken = null;
    this.feedToken = null;

    this.httpClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  getMachineDetails() {
    const interfaces = os.networkInterfaces();
    let localIp = "127.0.0.1";
    let macAddress = "02:00:00:00:00:00";

    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          localIp = address.address;
          if (address.mac && address.mac !== "00:00:00:00:00:00") {
            macAddress = address.mac;
          }
          break;
        }
      }
      if (localIp !== "127.0.0.1") {
        break;
      }
    }

    return {
      localIp,
      publicIp: process.env.ANGEL_ONE_PUBLIC_IP || localIp,
      macAddress: process.env.ANGEL_ONE_MAC_ADDRESS || macAddress,
    };
  }

  getBaseHeaders() {
    const { localIp, publicIp, macAddress } = this.getMachineDetails();
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-PrivateKey": this.apiKey,
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": localIp,
      "X-ClientPublicIP": publicIp,
      "X-MACAddress": macAddress,
    };
  }

  getAuthHeaders() {
    return {
      ...this.getBaseHeaders(),
      Authorization: `Bearer ${this.jwtToken}`,
    };
  }

  generateTOTP() {
    const secret = this.totpSecret || process.env.ANGEL_ONE_TOTP_SECRET;
    if (!secret || secret === "YOUR_TOTP_SECRET_HERE" || secret.length < 10) {
      throw new Error(
        "TOTP_SECRET not configured or invalid. Please update .env with your real TOTP secret from SmartAPI portal.",
      );
    }
    const { TOTP } = require("totp-generator");
    const result = TOTP.generate(secret);
    return typeof result === "object" ? result.otp : result;
  }

  async login() {
    console.log("\n📱 Testing Login...");
    console.log("  Client Code:", this.clientCode);
    console.log(
      "  API Key:",
      this.apiKey ? `${this.apiKey.substring(0, 5)}...` : "NOT SET",
    );

    if (!this.apiKey || !this.clientCode || !this.password) {
      console.log("  ❌ FAILED: Missing credentials in .env");
      return false;
    }

    try {
      const totp = this.generateTOTP();
      console.log("  TOTP Generated:", totp);

      const response = await this.httpClient.post(
        LOGIN_PATH,
        {
          clientcode: this.clientCode,
          password: this.password,
          totp: totp,
        },
        {
          headers: this.getBaseHeaders(),
        },
      );

      if (response.data.status) {
        const responseData = response.data.data || response.data;
        this.jwtToken =
          responseData.jwtToken || responseData.jwtTokenValue || null;
        this.feedToken = responseData.feedToken || null;
        this.refreshToken = responseData.refreshToken || null;
        this.httpClient.defaults.headers.common = this.getAuthHeaders();

        console.log("  ✅ SUCCESS: Logged in successfully");
        console.log(
          "  JWT Token:",
          this.jwtToken ? `${this.jwtToken.substring(0, 20)}...` : "None",
        );
        console.log(
          "  Feed Token:",
          this.feedToken ? `${this.feedToken.substring(0, 20)}...` : "None",
        );
        return true;
      } else {
        console.log(
          "  ❌ FAILED:",
          response.data.message ||
            response.data.error ||
            JSON.stringify(response.data),
        );
        return false;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      if (error.response) {
        console.log("  Response:", error.response.data);
        const supportId = String(error.response.data).match(/support ID is:\s*([0-9]+)/i);
        if (supportId) {
          console.log("  Support ID:", supportId[1]);
        }
      }
      return false;
    }
  }

  async getProfile() {
    console.log("\n👤 Testing Get Profile...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return null;
    }

    try {
      const response = await this.httpClient.get(PROFILE_PATH, {
        headers: this.getAuthHeaders(),
        params: { clientcode: this.clientCode },
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  User Name:", response.data.data?.name);
        return response.data.data;
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return null;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return null;
    }
  }

  async getRMS() {
    console.log("\n💰 Testing Get RMS (Risk Management)...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return null;
    }

    try {
      const response = await this.httpClient.get(RMS_PATH, {
        headers: this.getAuthHeaders(),
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        const rms = response.data.data;
        console.log("  Available Margin:", rms?.netavailablecash);
        console.log("  Opening Balance:", rms?.openingbalance);
        console.log("  Collateral:", rms?.collateral);
        return rms;
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return null;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return null;
    }
  }

  async getOrderBook() {
    console.log("\n📋 Testing Get Order Book...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return [];
    }

    try {
      const response = await this.httpClient.get(ORDER_BOOK_PATH, {
        headers: this.getAuthHeaders(),
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  Total Orders:", response.data.data?.length || 0);
        return response.data.data || [];
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return [];
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return [];
    }
  }

  async getPositions() {
    console.log("\n📊 Testing Get Positions...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return [];
    }

    try {
      const response = await this.httpClient.get(POSITION_PATH, {
        headers: this.getAuthHeaders(),
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  Total Positions:", response.data.data?.length || 0);
        return response.data.data || [];
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return [];
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return [];
    }
  }

  async getHoldings() {
    console.log("\n💼 Testing Get Holdings...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return [];
    }

    try {
      const response = await this.httpClient.get(HOLDING_PATH, {
        headers: this.getAuthHeaders(),
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  Total Holdings:", response.data.data?.length || 0);
        return response.data.data || [];
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return [];
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return [];
    }
  }

  async getInstruments() {
    console.log("\n📈 Testing Get Instruments (NSE)...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return [];
    }

    try {
      const response = await this.httpClient.get("/rest/instrument/get", {
        headers: { Authorization: `Bearer ${this.jwtToken}` },
        params: { exchange: "NSE" },
      });

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  Sample Instruments:", response.data.data?.slice(0, 5));
        return response.data.data || [];
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return [];
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return [];
    }
  }

  async getQuote(symbol) {
    console.log(`\n💵 Testing Get Quote for ${symbol}...`);

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return null;
    }

    try {
      const instrument = SYMBOLS[symbol];
      if (!instrument) {
        throw new Error(`No instrument mapping configured for ${symbol}`);
      }

      const response = await this.httpClient.post(
        LTP_PATH,
        instrument,
        {
          headers: this.getAuthHeaders(),
        },
      );

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        const quote = response.data.data || response.data;
        console.log("  Last Price:", quote?.ltp || quote?.last_price);
        console.log("  Open:", quote?.open);
        console.log("  High:", quote?.high);
        console.log("  Low:", quote?.low);
        console.log("  Volume:", quote?.volume);
        return quote;
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return null;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return null;
    }
  }

  async placeTestOrder() {
    console.log("\n🚀 Testing Place Order (will auto-cancel)...");

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return null;
    }

    try {
      const orderPayload = {
        exchange: "NSE",
        tradingsymbol: "SBIN-EQ",
        symboltoken: "3045",
        producttype: "CASHANDCARRY",
        ordertype: "MARKET",
        transactiontype: "BUY",
        quantity: 1,
        price: 0,
        triggerprice: 0,
        disclosedquantity: 0,
        duration: "DAY",
      };

      console.log("  Order:", JSON.stringify(orderPayload));

      const response = await this.httpClient.post(
        PLACE_ORDER_PATH,
        orderPayload,
        {
          headers: this.getAuthHeaders(),
        },
      );

      if (response.data.status) {
        console.log("  ✅ SUCCESS");
        console.log("  Order ID:", response.data.orderId);
        console.log("  Broker Order ID:", response.data.norenordno);

        // Try to cancel the order immediately
        if (response.data.orderId) {
          console.log("  Attempting to cancel order...");
          await this.cancelOrder(response.data.orderId);
        }

        return response.data;
      } else {
        console.log("  ❌ FAILED:", response.data.message);
        return null;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return null;
    }
  }

  async cancelOrder(orderId) {
    console.log(`\n❌ Testing Cancel Order ${orderId}...`);

    if (!this.jwtToken) {
      console.log("  ❌ FAILED: Not logged in");
      return null;
    }

    try {
      const response = await this.httpClient.post(
        CANCEL_ORDER_PATH,
        { variety: "NORMAL", orderid: orderId },
        {
          headers: this.getAuthHeaders(),
        },
      );

      if (response.data.status) {
        console.log("  ✅ SUCCESS: Order cancelled");
        return true;
      } else {
        console.log(
          "  ❌ FAILED:",
          response.data.message ||
            response.data.error ||
            JSON.stringify(response.data),
        );

        // Check for common issues
        if (
          response.data &&
          response.data.message &&
          response.data.message.includes("Request Rejected")
        ) {
          console.log("\n  ⚠️  IP ADDRESS MAY NOT BE WHITELISTED");
          console.log("  Angel One SmartAPI requires IP whitelisting.");
          console.log("  To fix:");
          console.log("  1. Go to https://smartapi.angelone.in");
          console.log("  2. Login and go to Profile/IP Settings");
          console.log("  3. Add your current IP address");
          console.log("  4. Or use a different network/API key");
        }

        return false;
      }
    } catch (error) {
      console.log("  ❌ ERROR:", error.message);
      return false;
    }
  }

  async logout() {
    console.log("\n👋 Testing Logout...");

    if (!this.jwtToken) {
      console.log("  Not logged in, skipping");
      return;
    }

    try {
      await this.httpClient.post(
        LOGOUT_PATH,
        {},
        {
          headers: this.getAuthHeaders(),
        },
      );
      console.log("  ✅ Logged out");
    } catch (error) {
      console.log("  Note: Logout error (may already be logged out)");
    }
  }
}

// Run tests
async function runTests() {
  console.log("=".repeat(50));
  console.log("SmartAPI Integration Tests");
  console.log("=".repeat(50));

  const tester = new SmartAPITester();

  // Test 1: Login
  const loginSuccess = await tester.login();
  if (!loginSuccess) {
    console.log("\n❌ Login failed. Please check your credentials.");
    console.log("\nMake sure you have:");
    console.log("1. Correct API Key in .env");
    console.log("2. Correct Client Code in .env");
    console.log("3. Correct Password in .env");
    console.log("4. Correct TOTP Secret in .env (NOT the 6-digit OTP)");
    console.log("\nTo get TOTP Secret:");
    console.log("1. Go to https://smartapi.angelone.in");
    console.log("2. Login and go to Profile");
    console.log("3. Find TOTP Secret (not the PIN)");
    process.exit(1);
  }

  // Test 2: Get Profile
  await tester.getProfile();

  // Test 3: Get RMS
  await tester.getRMS();

  // Test 4: Get Order Book
  await tester.getOrderBook();

  // Test 5: Get Positions
  await tester.getPositions();

  // Test 6: Get Holdings
  await tester.getHoldings();

  // Test 7: Get Quote (SBIN as test)
  await tester.getQuote("SBIN");

  // Test 8: Place Test Order (will cancel immediately)
  await tester.placeTestOrder();

  // Cleanup
  await tester.logout();

  console.log("\n" + "=".repeat(50));
  console.log("All tests completed!");
  console.log("=".repeat(50));
}

runTests().catch(console.error);
