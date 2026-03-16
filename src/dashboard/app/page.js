"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import {
  useMarketData,
  useOrders,
  usePositions,
  useSignals,
} from "@/hooks/useWebSocket";
import KillSwitch from "@/components/KillSwitch";
import { format } from "date-fns";
import clsx from "clsx";

function StatCard({ title, value, change, positive }) {
  return (
    <div className="card">
      <p className="text-sm text-gray-400">{title}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {change && (
        <p
          className={clsx(
            "text-sm mt-1",
            positive ? "text-green-400" : "text-red-400",
          )}
        >
          {positive ? "+" : ""}
          {change}
        </p>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState(null);

  const ticks = useMarketData(ws);
  const orders = useOrders(ws);
  const positions = usePositions(ws);
  const signals = useSignals(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      try {
        const [portfolioRes, healthRes] = await Promise.all([
          api.getPortfolio(),
          api.getHealth(),
        ]);
        if (portfolioRes.success) setPortfolio(portfolioRes.data);
        if (healthRes.success) setHealth(healthRes);
      } catch (err) {
        console.error("Failed to fetch data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [user, router]);

  if (!user) return null;

  const totalPnL = portfolio?.total_pnl || 0;
  const totalValue = portfolio?.total_value || 0;
  const availableMargin = portfolio?.available_margin || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <KillSwitch />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Portfolio Value"
          value={`₹${totalValue.toLocaleString()}`}
          change={
            totalPnL >= 0
              ? `+₹${totalPnL.toLocaleString()}`
              : `-₹${Math.abs(totalPnL).toLocaleString()}`
          }
          positive={totalPnL >= 0}
        />
        <StatCard
          title="Available Margin"
          value={`₹${availableMargin.toLocaleString()}`}
        />
        <StatCard title="Open Positions" value={positions.length.toString()} />
        <StatCard
          title="Active Orders"
          value={orders.filter((o) => o.status === "open").length.toString()}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Live Market Data</h2>
          <div className="space-y-2">
            {Object.keys(ticks).length === 0 ? (
              <p className="text-gray-400">Waiting for market data...</p>
            ) : (
              Object.entries(ticks)
                .slice(0, 10)
                .map(([token, data]) => (
                  <div
                    key={token}
                    className="flex items-center justify-between p-2 bg-gray-700/50 rounded"
                  >
                    <div>
                      <span className="font-medium">
                        {data.tradingsymbol || token}
                      </span>
                      <span className="text-gray-400 ml-2">
                        {data.exchange}
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">
                        ₹{data.last_price?.toLocaleString()}
                      </p>
                      <p
                        className={clsx(
                          "text-sm",
                          data.change >= 0 ? "text-green-400" : "text-red-400",
                        )}
                      >
                        {data.change >= 0 ? "+" : ""}
                        {data.change?.toFixed(2)}%
                      </p>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Trading Signals</h2>
          <div className="space-y-2">
            {signals.length === 0 ? (
              <p className="text-gray-400">No signals yet</p>
            ) : (
              signals.slice(0, 10).map((signal, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 bg-gray-700/50 rounded"
                >
                  <div>
                    <span className="font-medium">{signal.symbol}</span>
                    <span
                      className={clsx(
                        "ml-2 px-2 py-0.5 text-xs rounded",
                        signal.action === "BUY"
                          ? "bg-green-900 text-green-300"
                          : "bg-red-900 text-red-300",
                      )}
                    >
                      {signal.action}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-400">{signal.strategy}</p>
                    <p className="text-xs text-gray-500">
                      {signal.timestamp
                        ? format(new Date(signal.timestamp), "HH:mm:ss")
                        : ""}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold mb-4">System Health</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-3 bg-gray-700/50 rounded">
            <p className="text-sm text-gray-400">API</p>
            <p
              className={clsx(
                "font-medium",
                health?.api === "healthy" ? "text-green-400" : "text-red-400",
              )}
            >
              {health?.api || "Unknown"}
            </p>
          </div>
          <div className="p-3 bg-gray-700/50 rounded">
            <p className="text-sm text-gray-400">Database</p>
            <p
              className={clsx(
                "font-medium",
                health?.database === "healthy"
                  ? "text-green-400"
                  : "text-red-400",
              )}
            >
              {health?.database || "Unknown"}
            </p>
          </div>
          <div className="p-3 bg-gray-700/50 rounded">
            <p className="text-sm text-gray-400">Redis</p>
            <p
              className={clsx(
                "font-medium",
                health?.redis === "connected"
                  ? "text-green-400"
                  : "text-red-400",
              )}
            >
              {health?.redis || "Unknown"}
            </p>
          </div>
          <div className="p-3 bg-gray-700/50 rounded">
            <p className="text-sm text-gray-400">Broker</p>
            <p
              className={clsx(
                "font-medium",
                health?.broker === "connected" || health?.broker === "paper"
                  ? "text-green-400"
                  : "text-red-400",
              )}
            >
              {health?.broker || "Unknown"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
