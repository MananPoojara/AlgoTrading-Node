"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { usePositions } from "@/hooks/useWebSocket";
import clsx from "clsx";

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function PositionRow({ position }) {
  const pnl = position.pnl || 0;

  return (
    <tr className="group transition-colors hover:bg-white/[0.02]">
      <td className="table-cell text-sm font-medium text-white">{position.tradingsymbol}</td>
      <td className="table-cell">
        <span className={clsx("badge", position.position_type === "LONG" ? "badge-green" : "badge-red")}>
          {position.position_type}
        </span>
      </td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">{position.quantity}</td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">
        {formatCurrency(position.average_price)}
      </td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">
        {formatCurrency(position.ltp)}
      </td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">
        {formatCurrency(position.market_value)}
      </td>
      <td className={clsx("table-cell text-right font-data text-sm font-medium", pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
        {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
      </td>
      <td className={clsx("table-cell text-right font-data text-sm", pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
        {position.pnl_percent?.toFixed(2)}%
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
  const totalValue = positions.reduce((sum, p) => sum + (p.market_value || 0), 0);

  return (
    <div className="space-y-5 animate-in">
      <h1 className="text-lg font-semibold text-white">Portfolio</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 stagger">
        <div className="card animate-in">
          <div className="section-label">Total Value</div>
          <div className="mt-2 metric-value text-white">{formatCurrency(totalValue)}</div>
        </div>
        <div className="card animate-in">
          <div className="section-label">Total P&L</div>
          <div className={clsx("mt-2 metric-value", totalPnL >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {totalPnL >= 0 ? "+" : ""}{formatCurrency(totalPnL)}
          </div>
        </div>
        <div className="card animate-in">
          <div className="section-label">Available Margin</div>
          <div className="mt-2 metric-value text-white">
            {formatCurrency(margin?.available || 0)}
          </div>
        </div>
      </div>

      {/* Margin breakdown */}
      {margin && (
        <div className="card">
          <h2 className="text-sm font-semibold text-white">Margin Summary</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="section-label">Total</div>
              <div className="mt-1 font-data text-sm text-zinc-300">{formatCurrency(margin.total || 0)}</div>
            </div>
            <div>
              <div className="section-label">Used</div>
              <div className="mt-1 font-data text-sm text-zinc-300">{formatCurrency(margin.used || 0)}</div>
            </div>
            <div>
              <div className="section-label">Available</div>
              <div className="mt-1 font-data text-sm text-zinc-300">{formatCurrency(margin.available || 0)}</div>
            </div>
            <div>
              <div className="section-label">Unrealized P&L</div>
              <div className={clsx("mt-1 font-data text-sm font-medium", (margin.unrealized_pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {formatCurrency(margin.unrealized_pnl || 0)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Positions table */}
      <div className="card-flush">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-sm font-semibold text-white">Open Positions</h2>
          <span className="text-xs text-zinc-600">{positions.length} positions</span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-zinc-600">Loading positions...</div>
        ) : positions.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">No open positions</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-header">Symbol</th>
                  <th className="table-header">Type</th>
                  <th className="table-header text-right">Qty</th>
                  <th className="table-header text-right">Avg Price</th>
                  <th className="table-header text-right">LTP</th>
                  <th className="table-header text-right">Value</th>
                  <th className="table-header text-right">P&L</th>
                  <th className="table-header text-right">P&L %</th>
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
