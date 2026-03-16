import { useState, useEffect, useCallback, useRef } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080";

const EVENT_ALIASES = {
  authenticated: "auth_success",
  auth_success: "auth_success",
  auth_error: "auth_error",
  market_data: "market_tick",
  market_tick: "market_tick",
  signals: "signal",
  signal: "signal",
  orders: "order_update",
  order_update: "order_update",
  positions: "position_update",
  position_update: "position_update",
};

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState(null);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const subscriptionsRef = useRef(new Set());
  const messageHandlersRef = useRef(new Map());

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      wsRef.current = new WebSocket(WS_URL);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setError(null);
        console.log("WebSocket connected");
        reconnectAttempts.current = 0;

        const token =
          typeof window !== "undefined"
            ? localStorage.getItem("auth_token")
            : null;
        if (token) {
          authenticate(token);
        }

        if (subscriptionsRef.current.size > 0) {
          subscribe([...subscriptionsRef.current]);
        }
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);

          const normalizedType = EVENT_ALIASES[data.type] || data.type;
          const normalizedMessage = {
            ...data,
            type: normalizedType,
          };

          if (normalizedType === "auth_success") {
            setIsAuthenticated(true);
          } else if (normalizedType === "auth_error" || normalizedType === "error") {
            setIsAuthenticated(false);
          }

          const handler = messageHandlersRef.current.get(normalizedType);
          if (handler) {
            handler(normalizedMessage);
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        console.log("WebSocket disconnected");

        const maxReconnectAttempts = 5;
        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttempts.current),
            30000,
          );
          reconnectAttempts.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(`Reconnecting... attempt ${reconnectAttempts.current}`);
            connect();
          }, delay);
        } else {
          setError("Max reconnection attempts reached");
        }
      };

      wsRef.current.onerror = (err) => {
        console.error("WebSocket error:", err);
        setError("Connection error");
      };
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const authenticate = useCallback((token) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "auth",
          payload: { token },
        }),
      );
    }
  }, []);

  const subscribe = useCallback((channels) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "subscribe",
          payload: { channels },
        }),
      );
      channels.forEach((ch) => subscriptionsRef.current.add(ch));
    }
  }, []);

  const unsubscribe = useCallback((channels) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "unsubscribe",
          payload: { channels },
        }),
      );
      channels.forEach((ch) => subscriptionsRef.current.delete(ch));
    }
  }, []);

  const onMessage = useCallback((type, handler) => {
    messageHandlersRef.current.set(type, handler);
    return () => {
      messageHandlersRef.current.delete(type);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    isAuthenticated,
    error,
    lastMessage,
    connect,
    disconnect,
    authenticate,
    subscribe,
    unsubscribe,
    onMessage,
  };
}

export function useMarketData(ws) {
  const [ticks, setTicks] = useState({});

  useEffect(() => {
    if (!ws || !ws.isConnected) return;

    const unsubscribe = ws.onMessage("market_tick", (msg) => {
      if (msg.data?.instrument_token) {
        setTicks((prev) => ({
          ...prev,
          [msg.data.instrument_token]: msg.data,
        }));
      }
    });

    ws.subscribe(["market_data"]);

    return () => {
      unsubscribe();
      ws.unsubscribe(["market_data"]);
    };
  }, [ws, ws?.isConnected]);

  return ticks;
}

export function useOrders(ws) {
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    if (!ws || !ws.isConnected) return;

    const unsubscribe = ws.onMessage("order_update", (msg) => {
      if (msg.data) {
        setOrders((prev) => {
          const existing = prev.findIndex(
            (o) => o.order_id === msg.data.order_id,
          );
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = msg.data;
            return updated;
          }
          return [msg.data, ...prev];
        });
      }
    });

    ws.subscribe(["orders"]);

    return () => {
      unsubscribe();
      ws.unsubscribe(["orders"]);
    };
  }, [ws, ws?.isConnected]);

  return orders;
}

export function usePositions(ws) {
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    if (!ws || !ws.isConnected) return;

    const unsubscribe = ws.onMessage("position_update", (msg) => {
      if (msg.data) {
        setPositions(msg.data);
      }
    });

    ws.subscribe(["positions"]);

    return () => {
      unsubscribe();
      ws.unsubscribe(["positions"]);
    };
  }, [ws, ws?.isConnected]);

  return positions;
}

export function useSignals(ws) {
  const [signals, setSignals] = useState([]);

  useEffect(() => {
    if (!ws || !ws.isConnected) return;

    const unsubscribe = ws.onMessage("signal", (msg) => {
      if (msg.data) {
        setSignals((prev) => [msg.data, ...prev].slice(0, 50));
      }
    });

    ws.subscribe(["signals"]);

    return () => {
      unsubscribe();
      ws.unsubscribe(["signals"]);
    };
  }, [ws, ws?.isConnected]);

  return signals;
}
