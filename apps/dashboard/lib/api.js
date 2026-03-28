class ApiService {
  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    this.tokenKey = "auth_token";
  }

  getToken() {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(this.tokenKey);
  }

  setToken(token) {
    if (typeof window !== "undefined" && token) {
      localStorage.setItem(this.tokenKey, token);
    }
  }

  clearToken() {
    if (typeof window !== "undefined") {
      localStorage.removeItem(this.tokenKey);
    }
  }

  getHeaders() {
    const token = this.getToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const config = {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        const error = new Error(data.error || "Request failed");
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      console.error("API Error:", error);
      throw error;
    }
  }

  get(endpoint) {
    return this.request(endpoint, { method: "GET" });
  }

  post(endpoint, data) {
    return this.request(endpoint, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  put(endpoint, data) {
    return this.request(endpoint, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  patch(endpoint, data) {
    return this.request(endpoint, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  delete(endpoint) {
    return this.request(endpoint, { method: "DELETE" });
  }

  async login(credentials) {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Login failed");
      }

      if (data.data?.token) {
        this.setToken(data.data.token);
      }

      return data;
    } catch (error) {
      console.error("Login error:", error);
      throw error;
    }
  }

  logout() {
    this.clearToken();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }

  isAuthenticated() {
    return !!this.getToken();
  }

  async getHealth() {
    return this.get("/health");
  }

  async getOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/orders${query ? `?${query}` : ""}`);
  }

  async getOrder(id) {
    return this.get(`/api/orders/${id}`);
  }

  async createOrder(orderData) {
    return this.post("/api/orders", orderData);
  }

  async cancelOrder(id) {
    return this.delete(`/api/orders/${id}`);
  }

  async getStrategies(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/strategies${query ? `?${query}` : ""}`);
  }

  async getStrategyInstances(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/strategies/instances${query ? `?${query}` : ""}`);
  }

  async startStrategy(instance_id) {
    return this.post("/api/strategies/start", { instance_id });
  }

  async stopStrategy(instance_id) {
    return this.post("/api/strategies/stop", { instance_id });
  }

  async getPortfolio() {
    return this.get("/api/portfolio");
  }

  async getPositions() {
    return this.get("/api/portfolio/positions");
  }

  async getPnL(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/portfolio/pnl${query ? `?${query}` : ""}`);
  }

  async getMargin() {
    return this.get("/api/portfolio/margin");
  }

  async getInstruments(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/market/instruments${query ? `?${query}` : ""}`);
  }

  async getQuote(token) {
    return this.get(`/api/market/quotes/${token}`);
  }

  async getChart(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/market/chart${query ? `?${query}` : ""}`);
  }

  async getRiskWarnings(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/risk/warnings${query ? `?${query}` : ""}`);
  }

  async getRiskApprovals(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/risk/approvals${query ? `?${query}` : ""}`);
  }

  async getRiskDecisions(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/risk/decisions${query ? `?${query}` : ""}`);
  }

  async getStrategySignals(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/strategies/signals${query ? `?${query}` : ""}`);
  }

  async getStrategyValidation(instanceId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(
      `/api/strategies/instances/${instanceId}/validation${query ? `?${query}` : ""}`,
    );
  }
  async getStrategyDashboardSurface(instanceId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(
      `/api/strategies/instances/${instanceId}/dashboard-surface${query ? `?${query}` : ""}`,
    );
  }


  async getStrategyPositionMismatch(instanceId) {
    return this.get(`/api/strategies/instances/${instanceId}/position-mismatch`);
  }

  async getManualPositionCorrections(instanceId) {
    return this.get(`/api/strategies/instances/${instanceId}/manual-position-corrections`);
  }

  async createManualPositionCorrection(instanceId, payload) {
    return this.post(
      `/api/strategies/instances/${instanceId}/manual-position-corrections`,
      payload,
    );
  }

  async updateStrategySettings(instanceId, payload) {
    return this.patch(`/api/strategies/instances/${instanceId}/settings`, payload);
  }

  async getOpsServices() {
    return this.get("/api/ops/services");
  }

  async getOpsLogs(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.get(`/api/ops/logs${query ? `?${query}` : ""}`);
  }

  getOpsLogStreamUrl(params = {}) {
    const query = new URLSearchParams(params).toString();
    return `${this.baseUrl}/api/ops/logs/stream${query ? `?${query}` : ""}`;
  }

  async approveRiskApproval(id, payload = {}) {
    return this.post(`/api/risk/approvals/${id}/approve`, payload);
  }

  async rejectRiskApproval(id, payload = {}) {
    return this.post(`/api/risk/approvals/${id}/reject`, payload);
  }
}

const api = new ApiService();
export default api;
