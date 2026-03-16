"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { usePositions } from "@/hooks/useWebSocket";
import { format } from "date-fns";
import clsx from "clsx";

function PositionRow({ position }) {
  const pnl = position.pnl || 0;
  const pnlClass = pnl >= 0 ? "text-green-400" : "text-red-400";

  return (
    <tr className="border-b border-gray-700">
      <td className="py-3 px-4">{position.tradingsymbol}</td>
      <td className="py-3 px-4">
        <span
          className={clsx(
            "px-2 py-1 text-xs font-medium rounded",
            position.position_type === "LONG"
              ? "bg-green-900 text-green-300"
              : "bg-red-900 text-red-300",
          )}
        >
          {position.position_type}
        </span>
      </td>
      <td className="py-3 px-4 text-right">{position.quantity}</td>
      <td className="py-3 px-4 text-right">
        ₹{position.average_price?.toLocaleString()}
      </td>
      <td className="py-3 px-4 text-right">
        ₹{position.ltp?.toLocaleString()}
      </td>
      <td className="py-3 px-4 text-right">
        ₹{position.market_value?.toLocaleString()}
      </td>
      <td className={clsx("py-3 px-4 text-right font-medium", pnlClass)}>
        {pnl >= 0 ? "+" : ""}₹{pnl.toLocaleString()}
      </td>
      <td className="py-3 px-4 text-right">
        <span className={clsx("text-sm", pnlClass)}>
          {position.pnl_percent?.toFixed(2)}%
        </span>
      </td>
    </tr>
  );
}

export default function PortfolioPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [positions, setPositions] = useState([]);
  const [portfolio, setPortfolio] = useState(null);
  const [margin, setMargin] = useState(null);
  const [loading, setLoading] = useState(true);

  const wsPositions = usePositions(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      try {
        const [positionsRes, portfolioRes, marginRes] = await Promise.all([
          api.getPositions(),
          api.getPortfolio(),
          api.getMargin(),
        ]);
        if (positionsRes.success) setPositions(positionsRes.data || []);
        if (portfolioRes.success) setPortfolio(portfolioRes.data);
        if (marginRes.success) setMargin(marginRes.data);
      } catch (err) {
        console.error("Failed to fetch data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [user, router]);

  useEffect(() => {
    if (wsPositions.length > 0) {
      setPositions(wsPositions);
    }
  }, [wsPositions]);

  if (!user) return null;

  const totalPnL = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const totalValue = positions.reduce(
    (sum, p) => sum + (p.market_value || 0),
    0,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Portfolio</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-400">Total Value</p>
          <p className="text-2xl font-bold mt-1">
            ₹{totalValue.toLocaleString()}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400">Total P&L</p>
          <p
            className={clsx(
              "text-2xl font-bold mt-1",
              totalPnL >= 0 ? "text-green-400" : "text-red-400",
            )}
          >
            {totalPnL >= 0 ? "+" : ""}₹{totalPnL.toLocaleString()}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400">Available Margin</p>
          <p className="text-2xl font-bold mt-1">
            ₹{margin?.available?.toLocaleString() || "0"}
          </p>
        </div>
      </div>

      {margin && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Margin Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-gray-400">Total Margin</p>
              <p className="font-medium">
                ₹{margin.total?.toLocaleString() || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Used Margin</p>
              <p className="font-medium">
                ₹{margin.used?.toLocaleString() || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Available</p>
              <p className="font-medium">
                ₹{margin.available?.toLocaleString() || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Unrealized P&L</p>
              <p
                className={clsx(
                  "font-medium",
                  (margin.unrealized_pnl || 0) >= 0
                    ? "text-green-400"
                    : "text-red-400",
                )}
              >
                ₹{margin.unrealized_pnl?.toLocaleString() || 0}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        <h2 className="text-lg font-semibold p-6 pb-0">Open Positions</h2>
        {loading ? (
          <div className="p-6 text-center text-gray-400">
            Loading positions...
          </div>
        ) : positions.length === 0 ? (
          <div className="p-6 text-center text-gray-400">No open positions</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-700/50">
                <tr>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Symbol
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Type
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Qty
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Avg Price
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    LTP
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Value
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    P&L
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    P&L %
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position, idx) => (
                  <PositionRow
                    key={position.tradingsymbol || idx}
                    position={position}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
