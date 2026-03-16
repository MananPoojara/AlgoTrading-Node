"use client";

import { createContext, useContext, useState, useEffect } from "react";
import api from "@/lib/api";
import { useWebSocket } from "@/hooks/useWebSocket";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const ws = useWebSocket();

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (token) {
      setUser({ token });
      ws.authenticate(token);
    }
    setLoading(false);
  }, []);

  const login = async (credentials) => {
    const response = await api.login(credentials);
    if (response.success && response.data?.token) {
      setUser(response.data);
      ws.authenticate(response.data.token);
    }
    return response;
  };

  const logout = () => {
    api.logout();
    setUser(null);
    ws.disconnect();
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, ws }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
