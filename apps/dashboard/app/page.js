"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { useAlerts, usePositions } from "@/hooks/useWebSocket";
import SignalChart from "@/components/SignalChart";
import StrategySettingsModal from "@/components/StrategySettingsModal";

function formatCurrency(value) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `₹${numeric.toLocaleString("en-IN", {
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

function formatMetric(value, digits = 2) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function formatTimeframeLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1d", "1day", "day", "daily"].includes(normalized)) return "1day";
  if (["1m", "1min"].includes(normalized)) return "1min";
  if (["5m", "5min"].includes(normalized)) return "5min";
  if (["15m", "15min"].includes(normalized)) return "15min";
  return value || "—";
}

function formatSourceLabel(source) {
  if (source === "market_ohlc_1m") return "Retained 1m feed";
  if (source === "angel_historical_intraday") return "Angel intraday historical";
  if (source === "market_ohlc_1m_intraday") return "Retained intraday";
  return source || "Unknown";
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
    info: "text-sky-300",
  }[tone] || "text-white";

  return (
    <div className="animate-in rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--bg-card)" }}>
      <div className="section-label">{label}</div>
      <div className={clsx("mt-2 font-data text-xl font-semibold", toneClass)}>{value}</div>
      <div className="mt-1.5 text-xs text-zinc-600">{detail}</div>
    </div>
  );
}

function StatusChip({ label, tone = "neutral" }) {
  const toneClass =
    tone === "good"
      ? "badge-green"
      : tone === "warn"
        ? "badge-amber"
        : tone === "bad"
          ? "badge-red"
          : "badge-neutral";

  return <span className={clsx("badge", toneClass)}>{label}</span>;
}

function StrategyRow({ instance, surface, isSelected, busyId, onSelect, onToggle, onEdit }) {
  const parameters = instance.parameters || {};
  const riskLimits = instance.risk_limits || {};
  const timeframe = surface?.strategy?.timeframe || parameters.timeframe || "1day";
  const pendingRestart = Boolean(surface?.strategy?.pending_restart);
  const mismatch = Boolean(surface?.position_mismatch?.has_mismatch);

  return (
    <button
      type="button"
      onClick={() => onSelect(instance)}
      className={clsx(
        "w-full rounded-xl border px-4 py-4 text-left transition-all",
        isSelected
          ? "border-zinc-700 bg-zinc-900"
          : "border-transparent hover:border-zinc-800 hover:bg-zinc-900/50",
      )}
      style={{ borderColor: isSelected ? undefined : "var(--border)" }}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-sm font-semibold text-white">{instance.strategy_name}</span>
            <StatusChip label={instance.status} tone={instance.status === "running" ? "good" : instance.status === "paused" ? "warn" : "neutral"} />
            <StatusChip label={formatTimeframeLabel(timeframe)} tone="neutral" />
            {pendingRestart ? <StatusChip label="restart required" tone="warn" /> : null}
            {mismatch ? <StatusChip label="mismatch" tone="warn" /> : null}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-data text-xs text-zinc-500">
            <span>{instance.client_name || `Client ${instance.client_id}`}</span>
            <span>{parameters.symbol || "—"}</span>
            <span>Qty {parameters.quantity || 25}</span>
            <span>Capital {formatCurrency(parameters.capital || riskLimits.capital || 0)}</span>
            <span>Worker {instance.worker_id || "unassigned"}</span>
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
            className={clsx("btn", instance.status === "running" ? "btn-danger" : "btn-success")}
          >
            {busyId === instance.id ? "..." : instance.status === "running" ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </button>
  );
}

function SurfacePanel({ title, badge = null, actions = null, children }) {
  return (
    <div className="card animate-in">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {badge}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function TapeCard({ title, rows = [], emptyLabel, renderRow, footer = null }) {
  return (
    <div className="card animate-in">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      <div className="mt-4 space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed py-6 text-center text-sm text-zinc-600" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
            {emptyLabel}
          </div>
        ) : (
          rows.map(renderRow)
        )}
      </div>
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}

export default function DashboardPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [surfaceLoading, setSurfaceLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [editingInstance, setEditingInstance] = useState(null);
  const [overview, setOverview] = useState({
    portfolio: null,
    health: null,
    strategies: [],
    approvals: [],
    warnings: [],
  });
  const [selectedStrategyId, setSelectedStrategyId] = useState(null);
  const [strategySurface, setStrategySurface] = useState(null);

  const positions = usePositions(ws);
  const alerts = useAlerts(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    let active = true;

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

        if (!active) return;

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
          const runningStrategy = nextStrategies.find((strategy) => strategy.status === "running");
          return runningStrategy?.id || nextStrategies[0]?.id || null;
        });
      } catch (error) {
        console.error("Failed to fetch dashboard overview:", error);
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchOverview();
    const interval = setInterval(fetchOverview, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [router, user]);

  const selectedStrategy = useMemo(
    () => overview.strategies.find((strategy) => strategy.id === selectedStrategyId) || null,
    [overview.strategies, selectedStrategyId],
  );

  useEffect(() => {
    if (!selectedStrategyId) {
      setStrategySurface(null);
      return;
    }

    let active = true;

    const fetchSurface = async () => {
      setSurfaceLoading(true);
      try {
        const response = await api.getStrategyDashboardSurface(selectedStrategyId, { limit: 180 });
        if (!active) return;
        setStrategySurface(response.success ? response.data : null);
      } catch (error) {
        if (!active) return;
        console.error("Failed to load strategy dashboard surface:", error);
        setStrategySurface(null);
      } finally {
        if (active) setSurfaceLoading(false);
      }
    };

    fetchSurface();
    const interval = setInterval(fetchSurface, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedStrategyId]);

  const cockpitStrategy = strategySurface?.strategy || null;
  const runtime = strategySurface?.runtime || {};
  const chart = strategySurface?.chart || {};
  const signalHistory = strategySurface?.signals || [];
  const orderHistory = strategySurface?.orders || [];
  const manualCorrections = strategySurface?.manual_corrections || [];
  const mismatch = strategySurface?.position_mismatch || null;
  const latestEvaluation = runtime.last_evaluation || {};
  const lifecycle = runtime.lifecycle || "IDLE";

  const stats = useMemo(() => {
    const totalPnl = Number(overview.portfolio?.total_pnl || 0);
    return [
      {
        label: "Lifecycle",
        value: lifecycle,
        detail: cockpitStrategy ? `${cockpitStrategy.strategy_name} · ${cockpitStrategy.client_name || cockpitStrategy.client_id}` : "Select a strategy",
        tone: lifecycle === "IN_POSITION" ? "positive" : lifecycle.startsWith("PENDING") ? "warning" : "neutral",
      },
      {
        label: "Timeframe",
        value: formatTimeframeLabel(cockpitStrategy?.timeframe),
        detail: cockpitStrategy?.pending_restart
          ? `Running ${formatTimeframeLabel(cockpitStrategy?.running_timeframe)} · restart required`
          : `Running ${formatTimeframeLabel(cockpitStrategy?.running_timeframe || cockpitStrategy?.timeframe)}`,
        tone: cockpitStrategy?.pending_restart ? "warning" : "info",
      },
      {
        label: "Latest Action",
        value: latestEvaluation.action || "NONE",
        detail: latestEvaluation.reason || "No recent evaluation",
        tone: latestEvaluation.action === "BUY" ? "positive" : latestEvaluation.action === "SELL" ? "negative" : "neutral",
      },
      {
        label: "Mismatch",
        value: mismatch?.has_mismatch ? "OPEN" : "CLEAR",
        detail: mismatch?.has_mismatch
          ? (mismatch.reasons || []).join(", ")
          : "Runtime and DB position state aligned",
        tone: mismatch?.has_mismatch ? "warning" : "positive",
      },
      {
        label: "Realized P&L",
        value: formatCurrency(overview.portfolio?.realized_pnl || 0),
        detail: `Total P&L ${formatCurrency(totalPnl)}`,
        tone: Number(overview.portfolio?.realized_pnl || 0) >= 0 ? "positive" : "negative",
      },
      {
        label: "Live Alerts",
        value: String(overview.warnings.length + overview.approvals.length),
        detail: `${alerts.length} websocket alerts · ${positions.length || overview.portfolio?.positions?.length || 0} positions`,
        tone: overview.warnings.length + overview.approvals.length > 0 ? "warning" : "neutral",
      },
    ];
  }, [alerts.length, cockpitStrategy, latestEvaluation.action, latestEvaluation.reason, lifecycle, mismatch, overview, positions.length]);

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
            ? { ...strategy, status: status === "running" ? "stopped" : "running" }
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
    <div className="space-y-6 animate-in">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Strategy1 Operator Cockpit</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Candlesticks, VWAP, runtime state, orders, and mismatch visibility in one operator surface.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cockpitStrategy ? <StatusChip label={cockpitStrategy.status} tone={cockpitStrategy.status === "running" ? "good" : cockpitStrategy.status === "paused" ? "warn" : "neutral"} /> : null}
          {cockpitStrategy?.timeframe ? <StatusChip label={formatTimeframeLabel(cockpitStrategy.timeframe)} tone="neutral" /> : null}
          {cockpitStrategy?.pending_restart ? <StatusChip label="restart required" tone="warn" /> : null}
          {mismatch?.has_mismatch ? <StatusChip label="position mismatch" tone="warn" /> : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6 stagger">
        {stats.map((stat) => (
          <StatTile key={stat.label} label={stat.label} value={stat.value} detail={stat.detail} tone={stat.tone} />
        ))}
      </div>

      {mismatch?.has_mismatch ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-4 text-amber-100">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Position mismatch detected</h2>
              <p className="mt-1 text-sm">
                {mismatch.reasons?.join(", ") || "Runtime state and persisted position state diverged."}
              </p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => router.push(strategySurface?.links?.validation || "/validation")}>
              Open Replay Audit
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)]">
        <SurfacePanel
          title="Live Session Chart"
          badge={<span className="text-xs text-zinc-600">{chart.candles?.length || 0} candles · {formatSourceLabel(chart.source)}</span>}
          actions={
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{surfaceLoading ? "Refreshing…" : `Updated ${formatRelativeTime(strategySurface?.generated_at)}`}</span>
              <button type="button" className="btn btn-ghost" onClick={() => router.push(strategySurface?.links?.validation || "/validation")}>
                Replay Audit
              </button>
            </div>
          }
        >
          <SignalChart
            candles={chart.candles || []}
            markers={chart.markers || []}
            lineSeries={chart.vwap_series || []}
            symbol={`${cockpitStrategy?.symbol || selectedStrategy?.parameters?.symbol || "NIFTY 50"} · Live Session`}
            timeframeLabel="1min"
            axisMode="intraday"
            subtitle="Candlesticks use retained 1-minute feed. Cyan line is session VWAP. Markers show strategy signals, recorded orders, manual overrides, and manual corrections."
          />
        </SurfacePanel>

        <SurfacePanel
          title="Runtime State"
          badge={<span className={clsx("badge", lifecycleTone(lifecycle))}>{lifecycle}</span>}
        >
          {!selectedStrategy ? (
            <div className="rounded-xl border border-dashed py-6 text-center text-sm text-zinc-600" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
              Select a strategy to inspect runtime state.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {[
                ["Last Action", latestEvaluation.action || "NONE", latestEvaluation.reason || "No recent evaluation"],
                ["Trailing Stop", formatMetric(runtime.trailing_stop), "Current paper exit threshold"],
                ["Instrument", runtime.entryContext?.instrument || runtime.pendingEntryContext?.instrument || runtime.pendingExitContext?.instrument || "—", "Active or pending option contract"],
                ["Pending Event", runtime.pendingExitContext?.eventId || runtime.pendingEntryContext?.eventId || "—", "Awaiting lifecycle update"],
                ["Trade Date", latestEvaluation.tradeDate || "—", "Last completed candle used for evaluation"],
                ["Decision Price vs VWAP", `${formatMetric(latestEvaluation.decisionPrice)} / ${formatMetric(latestEvaluation.vwap)}`, latestEvaluation.vwapGatePassed === false ? "VWAP gate blocked latest BUY" : "Latest decision context"],
                ["Timeframe", `${formatTimeframeLabel(cockpitStrategy?.timeframe)}${cockpitStrategy?.pending_restart ? " · restart required" : ""}`, `Running ${formatTimeframeLabel(cockpitStrategy?.running_timeframe || cockpitStrategy?.timeframe)}`],
                ["Worker", cockpitStrategy?.worker_id || selectedStrategy?.worker_id || "unassigned", `Source ${formatSourceLabel(chart.source)}`],
              ].map(([label, value, detail]) => (
                <div key={label} className="rounded-xl px-3 py-3" style={{ background: "var(--bg)" }}>
                  <div className="section-label">{label}</div>
                  <div className="mt-2 text-sm font-semibold text-white break-words">{value}</div>
                  <div className="mt-1 text-xs text-zinc-600">{detail}</div>
                </div>
              ))}
            </div>
          )}
        </SurfacePanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <TapeCard
          title="Signal Tape"
          rows={signalHistory.slice(0, 10)}
          emptyLabel="No signals recorded for the selected strategy yet."
          renderRow={(signal) => (
            <div key={signal.event_id} className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <StatusChip label={signal.action || "—"} tone={signal.action === "BUY" ? "good" : signal.action === "SELL" ? "bad" : "neutral"} />
                  <span className="truncate text-sm text-zinc-300">{signal.instrument || signal.symbol || "—"}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-600">{signal.reason || signal.status || "No reason recorded"}</div>
              </div>
              <span className="font-data text-xs text-zinc-600">{formatRelativeTime(signal.timestamp)}</span>
            </div>
          )}
        />

        <TapeCard
          title="Order Tape"
          rows={orderHistory.slice(0, 10)}
          emptyLabel="No order lifecycle updates for the selected strategy yet."
          renderRow={(order) => (
            <div key={order.id || order.order_id} className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <StatusChip label={order.side || "—"} tone={order.side === "BUY" ? "good" : order.side === "SELL" ? "bad" : "neutral"} />
                  <span className="truncate text-sm text-zinc-300">{order.instrument || order.symbol || "—"}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-600">#{order.id || order.order_id} · {order.status || "unknown"}</div>
              </div>
              <span className="font-data text-xs text-zinc-600">{formatRelativeTime(order.updated_at || order.created_at)}</span>
            </div>
          )}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <TapeCard
          title="Manual Position Corrections"
          rows={manualCorrections.slice(0, 8)}
          emptyLabel="No manual position corrections recorded for the current session."
          renderRow={(row) => (
            <div key={row.id || row.timestamp} className="rounded-xl px-3 py-3" style={{ background: "var(--bg)" }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">{row.metadata?.instrument || row.metadata?.symbol || "—"}</div>
                  <div className="mt-1 text-xs text-zinc-600">{row.metadata?.reason || "Manual correction"}</div>
                </div>
                <StatusChip
                  label={Number(row.metadata?.corrected_quantity || 0) >= Number(row.metadata?.previous_quantity || 0) ? "BUY" : "SELL"}
                  tone={Number(row.metadata?.corrected_quantity || 0) >= Number(row.metadata?.previous_quantity || 0) ? "good" : "bad"}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-data text-xs text-zinc-500">
                <span>Qty {formatMetric(row.metadata?.corrected_quantity, 0)}</span>
                <span>Avg {formatCurrency(row.metadata?.corrected_average_price)}</span>
                <span>{row.operator_username || "operator"}</span>
                <span>{formatRelativeTime(row.timestamp)}</span>
              </div>
            </div>
          )}
        />

        <TapeCard
          title="Alerts"
          rows={[...overview.approvals, ...overview.warnings].slice(0, 6)}
          emptyLabel="No alerts or approvals pending."
          renderRow={(item) => (
            <div key={item.id} className="rounded-xl px-3 py-3" style={{ background: "var(--amber-muted)" }}>
              <div className="text-sm text-amber-100">{item.message || item.reason || "Alert"}</div>
              <div className="mt-1 text-xs text-zinc-500">{formatRelativeTime(item.timestamp || item.created_at)}</div>
            </div>
          )}
        />
      </div>

      <SurfacePanel
        title="Strategies"
        badge={<span className="text-xs text-zinc-600">{loading ? "Loading…" : `${overview.strategies.length} configured`}</span>}
      >
        <div className="space-y-2">
          {overview.strategies.map((instance) => (
            <StrategyRow
              key={instance.id}
              instance={instance}
              surface={selectedStrategyId === instance.id ? strategySurface : null}
              isSelected={selectedStrategyId === instance.id}
              busyId={busyId}
              onSelect={(strategy) => setSelectedStrategyId(strategy.id)}
              onToggle={handleToggleStrategy}
              onEdit={setEditingInstance}
            />
          ))}
        </div>
      </SurfacePanel>

      <StrategySettingsModal
        isOpen={Boolean(editingInstance)}
        instance={editingInstance}
        onClose={() => setEditingInstance(null)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
