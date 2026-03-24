"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import {
  useAlerts,
  useOrders,
  usePositions,
} from "@/hooks/useWebSocket";
import SignalChart from "@/components/SignalChart";
import StrategySettingsModal from "@/components/StrategySettingsModal";

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

function formatRelativeTime(value) {
  if (!value) return "—";
  try {
    return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
  } catch {
    return "—";
  }
}

function formatMetric(value) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function deriveLifecycle(runtimeState = {}) {
  if (runtimeState.pendingExitContext) return "PENDING_EXIT";
  if (runtimeState.entryContext) return "IN_POSITION";
  if (runtimeState.pendingEntryContext) return "PENDING_ENTRY";
  return "IDLE";
}

function lifecycleTone(lifecycle) {
  if (lifecycle === "IN_POSITION") return "badge-green";
  if (lifecycle === "PENDING_ENTRY" || lifecycle === "PENDING_EXIT") return "badge-amber";
  return "badge-neutral";
}

function StatTile({ label, value, detail, tone = "neutral" }) {
  const toneClass = {
    positive: "text-emerald-400",
    negative: "text-rose-400",
    accent: "text-white",
    warning: "text-amber-400",
    neutral: "text-white",
  }[tone] || "text-white";

  return (
    <div className="animate-in rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--bg-card)" }}>
      <div className="section-label">{label}</div>
      <div className={clsx("mt-2 font-data text-xl font-semibold", toneClass)}>{value}</div>
      <div className="mt-1.5 text-xs text-zinc-600">{detail}</div>
    </div>
  );
}

function StrategyRow({
  instance,
  isSelected,
  busyId,
  onSelect,
  onToggle,
  onEdit,
}) {
  const parameters = instance.parameters || {};
  const riskLimits = instance.risk_limits || {};

  return (
    <button
      type="button"
      onClick={() => onSelect(instance)}
      className={clsx(
        "w-full rounded-lg border px-4 py-3.5 text-left transition-all",
        isSelected
          ? "border-zinc-700 bg-zinc-900"
          : "border-transparent hover:border-zinc-800 hover:bg-zinc-900/50",
      )}
      style={{ borderColor: isSelected ? undefined : "var(--border)" }}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-white">
              {instance.strategy_name}
            </span>
            <span
              className={clsx(
                "badge",
                instance.status === "running"
                  ? "badge-green"
                  : instance.status === "paused"
                    ? "badge-amber"
                    : "badge-neutral",
              )}
            >
              {instance.status}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-data text-xs text-zinc-500">
            <span>{instance.client_name || `Client ${instance.client_id}`}</span>
            <span>{parameters.symbol || "—"}</span>
            <span>Qty {parameters.quantity || 25}</span>
            <span>Capital {formatCurrency(parameters.capital || riskLimits.capital || 0)}</span>
            <span>Max loss {formatCurrency(parameters.maxDailyLoss || riskLimits.max_daily_loss || 0)}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onEdit(instance);
            }}
            className="btn btn-ghost"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(instance.id, instance.status);
            }}
            disabled={busyId === instance.id}
            className={clsx(
              "btn",
              instance.status === "running" ? "btn-danger" : "btn-success",
            )}
          >
            {busyId === instance.id
              ? "..."
              : instance.status === "running"
                ? "Stop"
                : "Start"}
          </button>
        </div>
      </div>
    </button>
  );
}

export default function DashboardPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [editingInstance, setEditingInstance] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [signalHistory, setSignalHistory] = useState([]);
  const [overview, setOverview] = useState({
    portfolio: null,
    health: null,
    strategies: [],
    approvals: [],
    warnings: [],
  });
  const [selectedStrategyId, setSelectedStrategyId] = useState(null);

  const positions = usePositions(ws);
  const alerts = useAlerts(ws);
  const liveOrders = useOrders(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchOverview = async () => {
      try {
        const [portfolioResult, healthResult, strategiesResult, approvalsResult, warningsResult] =
          await Promise.allSettled([
            api.getPortfolio(),
            api.getHealth(),
            api.getStrategyInstances({ limit: 20 }),
            api.getRiskApprovals({ status: "pending", limit: 5 }),
            api.getRiskWarnings({ limit: 5 }),
          ]);

        const portfolioRes = portfolioResult.status === "fulfilled" ? portfolioResult.value : null;
        const healthRes = healthResult.status === "fulfilled" ? healthResult.value : null;
        const strategiesRes = strategiesResult.status === "fulfilled" ? strategiesResult.value : null;
        const approvalsRes = approvalsResult.status === "fulfilled" ? approvalsResult.value : null;
        const warningsRes = warningsResult.status === "fulfilled" ? warningsResult.value : null;

        const nextStrategies = strategiesRes?.success ? strategiesRes.data || [] : [];

        setOverview({
          portfolio: portfolioRes?.success ? portfolioRes.data : null,
          health: healthRes?.success ? healthRes : null,
          strategies: nextStrategies,
          approvals: approvalsRes?.success ? approvalsRes.data || [] : [],
          warnings: warningsRes?.success ? warningsRes.data || [] : [],
        });

        setSelectedStrategyId((prev) => {
          if (prev && nextStrategies.some((strategy) => strategy.id === prev)) {
            return prev;
          }

          const runningStrategy = nextStrategies.find(
            (strategy) => strategy.status === "running",
          );
          return runningStrategy?.id || nextStrategies[0]?.id || null;
        });
      } catch (error) {
        console.error("Failed to fetch dashboard overview:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchOverview();
    const interval = setInterval(fetchOverview, 15000);
    return () => clearInterval(interval);
  }, [user, router]);

  const selectedStrategy = useMemo(
    () =>
      overview.strategies.find((strategy) => strategy.id === selectedStrategyId) ||
      null,
    [overview.strategies, selectedStrategyId],
  );

  const selectedRuntime = selectedStrategy?.runtime_state || {};
  const selectedLifecycle = deriveLifecycle(selectedRuntime);
  const selectedLastEvaluation = selectedRuntime.lastEvaluation || {};
  const selectedOrders = useMemo(() => {
    if (!selectedStrategyId) return [];
    return (liveOrders || [])
      .filter((order) => Number(order.strategy_instance_id) === Number(selectedStrategyId))
      .sort((left, right) => {
        const leftTime = new Date(left.updated_at || left.created_at || 0).getTime();
        const rightTime = new Date(right.updated_at || right.created_at || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, 8);
  }, [liveOrders, selectedStrategyId]);

  useEffect(() => {
    if (!selectedStrategy) {
      setChartData([]);
      setSignalHistory([]);
      return;
    }

    const fetchStrategySurface = async () => {
      try {
        const [chartRes, signalRes] = await Promise.all([
          api.getChart({
            symbol: selectedStrategy.parameters?.symbol || selectedStrategy.strategy_name,
            interval: "1min",
            limit: 120,
          }),
          api.getStrategySignals({
            strategy_instance_id: selectedStrategy.id,
            limit: 20,
          }),
        ]);

        setChartData(chartRes.success ? chartRes.data?.candles || [] : []);
        setSignalHistory(signalRes.success ? signalRes.data || [] : []);
      } catch (error) {
        console.error("Failed to load chart/signal surface:", error);
        setChartData([]);
        setSignalHistory([]);
      }
    };

    fetchStrategySurface();
    const interval = setInterval(fetchStrategySurface, 10000);
    return () => clearInterval(interval);
  }, [selectedStrategy]);

  const stats = useMemo(() => {
    const totalPnl = Number(overview.portfolio?.total_pnl || 0);
    const latestSignal = signalHistory[0];

    return [
      {
        label: "Positions",
        value: String(overview.portfolio?.positions?.length || positions.length || 0),
        detail: `${formatCurrency(overview.portfolio?.total_value || 0)} deployed`,
        tone: "accent",
      },
      {
        label: "Latest Signal",
        value: latestSignal?.action || "—",
        detail: latestSignal?.timestamp
          ? formatRelativeTime(latestSignal.timestamp)
          : "No recent signal",
        tone:
          latestSignal?.action === "BUY"
            ? "positive"
            : latestSignal?.action === "SELL"
              ? "negative"
              : "neutral",
      },
      {
        label: "Realized P&L",
        value: formatCurrency(overview.portfolio?.realized_pnl || 0),
        detail: "Session realized",
        tone: Number(overview.portfolio?.realized_pnl || 0) >= 0 ? "positive" : "negative",
      },
      {
        label: "Total P&L",
        value: formatCurrency(totalPnl),
        detail: `Unrealized ${formatCurrency(overview.portfolio?.unrealized_pnl || 0)}`,
        tone: totalPnl >= 0 ? "positive" : "negative",
      },
      {
        label: "Warnings",
        value: String(overview.warnings.length + overview.approvals.length),
        detail: `${alerts.length} live alerts`,
        tone: overview.warnings.length + overview.approvals.length > 0 ? "warning" : "neutral",
      },
    ];
  }, [overview, positions.length, signalHistory, alerts.length]);

  const handleToggleStrategy = async (instanceId, status) => {
    setBusyId(instanceId);
    try {
      if (status === "running") {
        await api.stopStrategy(instanceId);
      } else {
        await api.startStrategy(instanceId);
      }

      setOverview((prev) => ({
        ...prev,
        strategies: prev.strategies.map((strategy) =>
          strategy.id === instanceId
            ? {
                ...strategy,
                status: status === "running" ? "stopped" : "running",
              }
            : strategy,
        ),
      }));
    } catch (error) {
      console.error("Failed to update strategy status:", error);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveSettings = async (instanceId, payload) => {
    const response = await api.updateStrategySettings(instanceId, payload);
    if (response.success && response.data) {
      setOverview((prev) => ({
        ...prev,
        strategies: prev.strategies.map((strategy) =>
          strategy.id === instanceId
            ? {
                ...strategy,
                parameters: response.data.parameters,
                risk_limits: response.data.risk_limits,
              }
            : strategy,
        ),
      }));
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 stagger">
        {stats.map((stat) => (
          <StatTile
            key={stat.label}
            label={stat.label}
            value={stat.value}
            detail={stat.detail}
            tone={stat.tone}
          />
        ))}
      </div>

      {/* Chart */}
      <div className="animate-in">
        <SignalChart
          candles={chartData}
          signals={signalHistory}
          symbol={selectedStrategy?.parameters?.symbol || selectedStrategy?.strategy_name || "—"}
        />
      </div>

      {/* Selected strategy runtime */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card animate-in">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Selected Strategy Runtime</h2>
            <span className={clsx("badge", lifecycleTone(selectedLifecycle))}>
              {selectedLifecycle}
            </span>
          </div>
          {!selectedStrategy ? (
            <div className="mt-4 rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
              Select a strategy to inspect runtime state
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">Last Action</div>
                <div className="mt-2 text-sm font-semibold text-white">{selectedLastEvaluation.action || "NONE"}</div>
                <div className="mt-1 text-xs text-zinc-600">{selectedLastEvaluation.reason || "No recent evaluation"}</div>
              </div>
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">Trailing Stop</div>
                <div className="mt-2 font-data text-sm text-white">
                  {formatMetric(selectedRuntime.entryContext?.trailingStop ?? selectedLastEvaluation.trailingStop)}
                </div>
                <div className="mt-1 text-xs text-zinc-600">Current paper exit threshold</div>
              </div>
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">Instrument</div>
                <div className="mt-2 text-sm font-semibold text-white">
                  {selectedRuntime.entryContext?.instrument || selectedRuntime.pendingEntryContext?.instrument || selectedRuntime.pendingExitContext?.instrument || "—"}
                </div>
                <div className="mt-1 text-xs text-zinc-600">Active or pending option contract</div>
              </div>
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">Pending Event</div>
                <div className="mt-2 font-data text-sm text-white">
                  {selectedRuntime.pendingExitContext?.eventId || selectedRuntime.pendingEntryContext?.eventId || "—"}
                </div>
                <div className="mt-1 text-xs text-zinc-600">Awaiting exchange or paper lifecycle update</div>
              </div>
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">Trade Date</div>
                <div className="mt-2 font-data text-sm text-white">
                  {selectedLastEvaluation.tradeDate || "—"}
                </div>
                <div className="mt-1 text-xs text-zinc-600">Last completed candle used for evaluation</div>
              </div>
              <div className="rounded-lg px-3 py-3" style={{ background: "var(--bg)" }}>
                <div className="section-label">In Position</div>
                <div className="mt-2 text-sm font-semibold text-white">
                  {selectedRuntime.entryContext ? "YES" : "NO"}
                </div>
                <div className="mt-1 text-xs text-zinc-600">Derived from persisted strategy runtime state</div>
              </div>
            </div>
          )}
        </div>

        <div className="card animate-in">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Live Order Tape</h2>
            <span className="text-xs text-zinc-600">{selectedOrders.length} live updates</span>
          </div>
          <div className="mt-4 space-y-2">
            {selectedOrders.length === 0 ? (
              <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                No live order updates for the selected strategy yet
              </div>
            ) : (
              selectedOrders.map((order) => (
                <div
                  key={order.order_id}
                  className="flex items-center justify-between rounded-lg px-3 py-2.5"
                  style={{ background: "var(--bg)" }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className={clsx(
                        "badge",
                        order.side === "BUY" ? "badge-green" : "badge-red",
                      )}>
                        {order.side}
                      </span>
                      <span className="text-sm text-zinc-300">
                        {order.instrument || order.symbol || "—"}
                      </span>
                    </div>
                    <div className="mt-1 font-data text-xs text-zinc-600">
                      #{order.order_id} · {order.status || order.newState || "unknown"}
                    </div>
                  </div>
                  <span className="font-data text-xs text-zinc-600">
                    {formatRelativeTime(order.updated_at || order.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Signals + Alerts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card animate-in">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Signal Tape</h2>
            <span className="text-xs text-zinc-600">{signalHistory.length} signals</span>
          </div>
          <div className="mt-4 space-y-2">
            {signalHistory.length === 0 ? (
              <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                No signals yet
              </div>
            ) : (
              signalHistory.slice(0, 8).map((signal) => (
                <div
                  key={signal.event_id}
                  className="flex items-center justify-between rounded-lg px-3 py-2.5"
                  style={{ background: "var(--bg)" }}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={clsx(
                        "badge",
                        signal.action === "BUY" ? "badge-green" : "badge-red",
                      )}
                    >
                      {signal.action}
                    </span>
                    <span className="text-sm text-zinc-300">
                      {signal.instrument || signal.symbol || "—"}
                    </span>
                  </div>
                  <span className="font-data text-xs text-zinc-600">
                    {formatRelativeTime(signal.timestamp)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card animate-in">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Alerts</h2>
            <span className="text-xs text-zinc-600">
              {overview.approvals.length + overview.warnings.length} pending
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {overview.approvals.length === 0 && overview.warnings.length === 0 ? (
              <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                No alerts
              </div>
            ) : (
              [...overview.approvals, ...overview.warnings].slice(0, 5).map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg px-3 py-2.5"
                  style={{ background: "var(--amber-muted)" }}
                >
                  <div className="text-sm text-amber-200">{item.message}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {formatRelativeTime(item.timestamp)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Strategies */}
      <div className="card animate-in">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Strategies</h2>
          <span className="text-xs text-zinc-600">
            {loading ? "Loading..." : `${overview.strategies.length} configured`}
          </span>
        </div>
        <div className="mt-4 space-y-2">
          {overview.strategies.map((instance) => (
            <StrategyRow
              key={instance.id}
              instance={instance}
              isSelected={selectedStrategyId === instance.id}
              busyId={busyId}
              onSelect={(strategy) => setSelectedStrategyId(strategy.id)}
              onToggle={handleToggleStrategy}
              onEdit={setEditingInstance}
            />
          ))}
        </div>
      </div>

      <StrategySettingsModal
        isOpen={Boolean(editingInstance)}
        instance={editingInstance}
        onClose={() => setEditingInstance(null)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
