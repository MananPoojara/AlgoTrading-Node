const axios = require("axios");
const os = require("os");
const { logger } = require("../../core/logger/logger");
const config = require("../../../config/default");

const API_BASE_URL =
  process.env.ANGEL_ONE_API_URL || "https://apiconnect.angelone.in";
const LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword";

class AngelOneBrokerAPI {
  constructor(options = {}) {
    this.apiKey = options.apiKey || config.angelOne.apiKey;
    this.clientCode = options.clientCode || null;
    this.password = options.password || null;
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
    this.isConnected = false;
  }

  getBaseHeaders() {
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
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-PrivateKey": this.apiKey,
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": process.env.ANGEL_ONE_LOCAL_IP || localIp,
      "X-ClientPublicIP":
        process.env.ANGEL_ONE_PUBLIC_IP || process.env.ANGEL_ONE_LOCAL_IP || localIp,
      "X-MACAddress": process.env.ANGEL_ONE_MAC_ADDRESS || macAddress,
    };
  }

  async login(clientCode, password, twoFA) {
    try {
      const response = await this.httpClient.post(
        LOGIN_PATH,
        {
          clientcode: clientCode,
          password: password,
          totp: twoFA,
        },
        {
          headers: this.getBaseHeaders(),
        },
      );

      if (response.data.status) {
        const responseData = response.data.data || response.data;
        this.clientCode = clientCode;
        this.password = password;
        this.jwtToken =
          responseData.jwtToken || responseData.jwtTokenValue || null;
        this.feedToken = responseData.feedToken || null;
        this.refreshTokenValue = responseData.refreshToken || "";
        this.isConnected = true;

        const tokenExpiryMs = (responseData.expiresIn || 3600) * 1000;
        this.tokenExpiry = Date.now() + tokenExpiryMs - 60000;

        this.httpClient.defaults.headers.common["Authorization"] =
          `Bearer ${this.jwtToken}`;

        logger.info("Angel One login successful", { clientCode });
        return { success: true, data: response.data };
      } else {
        logger.error("Angel One login failed", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Angel One login error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async logout() {
    if (!this.isConnected) {
      return { success: true };
    }

    try {
      await this.httpClient.post(
        "/rest/auth/logout",
        {},
        {
          headers: { Authorization: `Bearer ${this.jwtToken}` },
        },
      );
      this.isConnected = false;
      this.jwtToken = null;
      this.feedToken = null;
      logger.info("Angel One logout successful");
      return { success: true };
    } catch (error) {
      logger.error("Angel One logout error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async refreshToken() {
    if (!this.clientCode || !this.password) {
      return { success: false, error: "Missing credentials for token refresh" };
    }

    try {
      const response = await this.httpClient.post(
        "/rest/auth/token",
        {
          clientcode: this.clientCode,
          password: this.password,
          grant_type: "refresh_token",
          refresh_token: this.refreshTokenValue || "",
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
      );

      if (response.data.status) {
        this.jwtToken = response.data.jwtToken;
        this.feedToken = response.data.feedToken;
        this.httpClient.defaults.headers.common["Authorization"] =
          `Bearer ${this.jwtToken}`;

        logger.info("Token refreshed successfully");
        return { success: true };
      } else {
        logger.error("Token refresh failed", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Token refresh error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  isTokenExpired() {
    if (!this.tokenExpiry) return true;
    return Date.now() >= this.tokenExpiry;
  }

  async ensureConnected() {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    if (this.isTokenExpired()) {
      logger.info("Token expired, attempting refresh");
      const refreshResult = await this.refreshToken();
      if (!refreshResult.success) {
        return { success: false, error: "Token refresh failed" };
      }
    }

    return { success: true };
  }

  async placeOrder(orderParams) {
    const connected = await this.ensureConnected();
    if (!connected.success) {
      return connected;
    }

    const {
      symbol,
      exchange = "NSE",
      productType = "CASHANDCARRY",
      orderType = "MARKET",
      side,
      quantity,
      price = 0,
      triggerPrice = 0,
      disclosedQuantity = 0,
      duration = "DAY",
      squareOff = 0,
      stopLoss = 0,
      trailingStopLoss = 0,
    } = orderParams;

    try {
      const orderPayload = {
        exchange,
        symbol,
        producttype: productType,
        ordertype: orderType,
        transactiontype: side,
        quantity: parseInt(quantity),
        price: parseFloat(price),
        triggerprice: parseFloat(triggerPrice),
        disclosedquantity: parseInt(disclosedQuantity),
        duration,
        squareoff: parseFloat(squareOff),
        stoploss: parseFloat(stopLoss),
        trailingstoploss: parseFloat(trailingStopLoss),
      };

      logger.info("Placing order", { symbol, side, quantity, orderType });

      const response = await this.httpClient.post(
        "/rest/order/place",
        orderPayload,
        {
          headers: { Authorization: `Bearer ${this.jwtToken}` },
        },
      );

      if (response.data.status) {
        logger.info("Order placed successfully", {
          orderId: response.data.orderId,
          brokerOrderId: response.data.norenordno,
        });
        return {
          success: true,
          orderId: response.data.orderId,
          brokerOrderId: response.data.norenordno,
          message: response.data.message,
        };
      } else {
        logger.error("Order placement failed", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Order placement error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async modifyOrder(brokerOrderId, orderParams) {
    const connected = await this.ensureConnected();
    if (!connected.success) {
      return connected;
    }

    const {
      quantity,
      price = 0,
      triggerPrice = 0,
      orderType = "LIMIT",
    } = orderParams;

    try {
      const modifyPayload = {
        orderId: brokerOrderId,
        quantity: parseInt(quantity),
        price: parseFloat(price),
        triggerprice: parseFloat(triggerPrice),
        ordertype: orderType,
      };

      logger.info("Modifying order", { brokerOrderId, quantity, price });

      const response = await this.httpClient.put(
        "/rest/order/modify",
        modifyPayload,
        {
          headers: { Authorization: `Bearer ${this.jwtToken}` },
        },
      );

      if (response.data.status) {
        logger.info("Order modified successfully", { brokerOrderId });
        return {
          success: true,
          orderId: response.data.orderId,
          brokerOrderId: response.data.norenordno,
        };
      } else {
        logger.error("Order modification failed", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Order modification error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async cancelOrder(brokerOrderId) {
    const connected = await this.ensureConnected();
    if (!connected.success) {
      return connected;
    }

    try {
      logger.info("Cancelling order", { brokerOrderId });

      const response = await this.httpClient.delete("/rest/order/cancel", {
        data: { orderId: brokerOrderId },
        headers: { Authorization: `Bearer ${this.jwtToken}` },
      });

      if (response.data.status) {
        logger.info("Order cancelled successfully", { brokerOrderId });
        return { success: true };
      } else {
        logger.error("Order cancellation failed", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Order cancellation error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getOrderBook() {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    try {
      const response = await this.httpClient.get("/rest/order/get", {
        headers: { Authorization: `Bearer ${this.jwtToken}` },
      });

      if (response.data.status) {
        return { success: true, orders: response.data.data || [] };
      } else {
        logger.error("Failed to get order book", {
          message: response.data.message,
        });
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Get order book error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getOrderHistory(brokerOrderId) {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    try {
      const response = await this.httpClient.get(
        `/rest/order/history?orderId=${brokerOrderId}`,
        {
          headers: { Authorization: `Bearer ${this.jwtToken}` },
        },
      );

      if (response.data.status) {
        return { success: true, history: response.data.data || [] };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Get order history error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getPositions() {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    try {
      const response = await this.httpClient.get("/rest/position/get", {
        headers: { Authorization: `Bearer ${this.jwtToken}` },
      });

      if (response.data.status) {
        return { success: true, positions: response.data.data || [] };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Get positions error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getHoldings() {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    try {
      const response = await this.httpClient.get("/rest/portfolio/get", {
        headers: { Authorization: `Bearer ${this.jwtToken}` },
      });

      if (response.data.status) {
        return { success: true, holdings: response.data.data || [] };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Get holdings error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getRMS() {
    if (!this.isConnected) {
      return { success: false, error: "Not connected to broker" };
    }

    try {
      const response = await this.httpClient.get("/rest/user/rms", {
        headers: { Authorization: `Bearer ${this.jwtToken}` },
      });

      if (response.data.status) {
        return { success: true, rms: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      logger.error("Get RMS error", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      clientCode: this.clientCode,
    };
  }

  async getCandleData(candleParams) {
    const connected = await this.ensureConnected();
    if (!connected.success) {
      return connected;
    }

    try {
      const response = await this.httpClient.post(
        "/rest/secure/angelbroking/historical/v1/getCandleData",
        candleParams,
        {
          headers: {
            ...this.getBaseHeaders(),
            Authorization: `Bearer ${this.jwtToken}`,
          },
        },
      );

      if (response.data?.status) {
        return {
          success: true,
          data: response.data.data || [],
          message: response.data.message,
        };
      }

      return {
        success: false,
        error: response.data?.message || "Historical candle request failed",
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        statusCode: error.response?.status,
      };
    }
  }
}

let brokerAPIInstance = null;

function getBrokerAPI(options = {}) {
  if (!brokerAPIInstance) {
    brokerAPIInstance = new AngelOneBrokerAPI(options);
  }
  return brokerAPIInstance;
}

function setBrokerAPIInstance(instance) {
  brokerAPIInstance = instance;
}

module.exports = {
  AngelOneBrokerAPI,
  getBrokerAPI,
  setBrokerAPIInstance,
};
