"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import SignalChart from "@/components/SignalChart";

function getTodayIstDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function formatMetric(value, digits = 2) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function formatCurrency(value) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `₹${numeric.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return String(value);
  }
}

function verdictTone(verdict) {
  if (verdict === "PASS") return "badge-green";
  if (verdict === "WARN") return "badge-amber";
  if (verdict === "FAIL") return "badge-rose";
  return "badge-neutral";
}

function countMismatches(mismatches = [], action) {
  return mismatches.filter(
    (row) => row.expectedAction === action || row.actualAction === action,
  ).length;
}

function parityTone(ok, caution = false) {
  if (!ok) return "text-rose-400";
  if (caution) return "text-amber-400";
  return "text-emerald-400";
}

function formatSourceLabel(source) {
  if (source === "angel_historical") return "Angel Historical";
  if (source === "market_ohlc_1m") return "Retained Feed";
  return "Unknown";
}

function sourceTone(source, warning) {
  if (warning) return "text-amber-400";
  if (source === "angel_historical") return "text-emerald-400";
  return "text-zinc-200";
}

function ModeButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-white/[0.10] text-white" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {children}
    </button>
  );
}

function StatCard({ label, value, detail, tone = "text-white" }) {
  return (
    <div className="card animate-in">
      <div className="section-label">{label}</div>
      <div className={clsx("mt-2 font-data text-2xl font-semibold", tone)}>{value}</div>
      <div className="mt-1 text-xs text-zinc-600">{detail}</div>
    </div>
  );
}

function EventList({ title, events = [], emptyLabel }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-xs text-zinc-600">{events.length} events</span>
      </div>
      {events.length === 0 ? (
        <div className="mt-4 text-sm text-zinc-600">{emptyLabel}</div>
      ) : (
        <div className="mt-4 space-y-2">
          {events.map((event, index) => (
            <div
              key={`${title}-${event.barTime || event.timestamp || index}`}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className={clsx(
                    "badge",
                    event.action === "BUY"
                      ? "badge-green"
                      : event.action === "SELL"
                        ? "badge-rose"
                        : "badge-neutral",
                  )}
                >
                  {event.action || "—"}
                </span>
                <span className="font-data text-xs text-zinc-500">
                  {formatDateTime(event.barTime || event.timestamp)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                <span>Reason {event.reason || "—"}</span>
                <span>Price {formatMetric(event.price)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ValidationPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [instances, setInstances] = useState([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState(null);
  const [tradeDate, setTradeDate] = useState(getTodayIstDate());
  const [chartMode, setChartMode] = useState("replay");
  const [validation, setValidation] = useState(null);
  const [errorState, setErrorState] = useState(null);

  const strategyInstances = useMemo(
    () =>
      instances.filter(
        (instance) => String(instance.strategy_name || "").toUpperCase() === "STRATEGY1_LIVE",
      ),
    [instances],
  );

  const selectedInstance = useMemo(
    () =>
      strategyInstances.find(
        (instance) => Number(instance.id) === Number(selectedInstanceId),
      ) || strategyInstances[0] || null,
    [strategyInstances, selectedInstanceId],
  );

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchInstances = async () => {
      try {
        const response = await api.getStrategyInstances({ limit: 50 });
        if (response.success) {
          const nextInstances = response.data || [];
          const nextStrategyInstances = nextInstances.filter(
            (instance) => String(instance.strategy_name || "").toUpperCase() === "STRATEGY1_LIVE",
          );
          setInstances(nextInstances);
          setSelectedInstanceId((current) => {
            if (
              current &&
              nextStrategyInstances.some((instance) => Number(instance.id) === Number(current))
            ) {
              return current;
            }
            return nextStrategyInstances[0]?.id || null;
          });
        }
      } catch (error) {
        setErrorState({
          title: "Strategy instances unavailable",
          message: error.message,
        });
      } finally {
        setLoading(false);
      }
    };

    fetchInstances();
  }, [user, router]);

  useEffect(() => {
    if (!selectedInstance?.id) {
      setValidation(null);
      return;
    }

    let active = true;

    const fetchValidation = async () => {
      setLoading(true);

      try {
        const response = await api.getStrategyValidation(selectedInstance.id, {
          trade_date: tradeDate,
        });

        if (!active) return;
        setValidation(response.data || null);
        setErrorState(null);
      } catch (error) {
        if (!active) return;
        setValidation(null);

        if (error.status === 409) {
          setErrorState({
            title: "Validation window not open",
            message:
              error.data?.data?.trade_date === getTodayIstDate()
                ? "Today’s validation opens after 16:15 IST so the candle set is finalized."
                : error.message,
            detail: error.data?.data?.available_after_ist
              ? `Available after ${error.data.data.available_after_ist} IST`
              : null,
          });
        } else {
          setErrorState({
            title: "Validation unavailable",
            message: error.message,
          });
        }
      } finally {
        if (!active) return;
        setLoading(false);
      }
    };

    fetchValidation();

    return () => {
      active = false;
    };
  }, [selectedInstance?.id, tradeDate]);

  const refreshValidation = async () => {
    if (!selectedInstance?.id) {
      return;
    }

    setRefreshing(true);
    try {
      const response = await api.getStrategyValidation(selectedInstance.id, {
        trade_date: tradeDate,
      });
      setValidation(response.data || null);
      setErrorState(null);
    } catch (error) {
      setValidation(null);
      setErrorState({
        title: error.status === 409 ? "Validation window not open" : "Validation unavailable",
        message:
          error.status === 409
            ? "Today’s validation opens after 16:15 IST so the candle set is finalized."
            : error.message,
        detail: error.data?.data?.available_after_ist
          ? `Available after ${error.data.data.available_after_ist} IST`
          : null,
      });
    } finally {
      setRefreshing(false);
    }
  };

  const replaySignals = validation?.replay?.events || [];
  const actualSignals = validation?.actual?.signals || [];
  const actualOrders = validation?.actual?.orders || [];
  const mismatches = validation?.comparison?.mismatches || [];
  const summary = validation?.comparison?.summary || {};
  const candleAudit = validation?.candle_audit || {};
  const candleSource = validation?.candle_source || {};
  const timeline = validation?.replay?.timeline || [];
  const chartCandles = validation?.candles || [];

  const replayBuyCount = replaySignals.filter((event) => event.action === "BUY").length;
  const replaySellCount = replaySignals.filter((event) => event.action === "SELL").length;
  const actualBuyCount = actualSignals.filter((event) => event.action === "BUY").length;
  const actualSellCount = actualSignals.filter((event) => event.action === "SELL").length;
  const completedOrders = actualOrders.filter((order) => ["filled", "completed"].includes(String(order.status || "").toLowerCase())).length;

  const buyMismatchCount = countMismatches(mismatches, "BUY");
  const sellMismatchCount = countMismatches(mismatches, "SELL");

  const chartSignals = useMemo(() => {
    if (chartMode === "recorded") {
      return actualSignals.map((signal) => ({
        timestamp: signal.trigger_bar_time || signal.timestamp,
        action: signal.action,
      }));
    }

    return replaySignals.map((event) => ({
      timestamp: event.barTime,
      action: event.action,
    }));
  }, [actualSignals, chartMode, replaySignals]);

  if (!user) return null;

  return (
    <div className="space-y-5 animate-in">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Validation</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Strategy1 parity board and session replay for after-hours paper validation. Signals stay read-only and are driven from backend truth.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Strategy1 Instance
            <select
              value={selectedInstance?.id || ""}
              onChange={(event) => setSelectedInstanceId(event.target.value)}
              className="rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"
              style={{ borderColor: "var(--border)" }}
            >
              {strategyInstances.length === 0 ? (
                <option value="">No Strategy1 instance</option>
              ) : (
                strategyInstances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    #{instance.id} · {instance.client_name || instance.client_id} · {instance.parameters?.symbol || "NIFTY 50"}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Trade Date
            <input
              type="date"
              value={tradeDate}
              onChange={(event) => setTradeDate(event.target.value)}
              className="rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"
              style={{ borderColor: "var(--border)" }}
            />
          </label>

          <button
            type="button"
            onClick={refreshValidation}
            className="btn btn-ghost"
            disabled={!selectedInstance?.id || refreshing}
          >
            {refreshing ? "Refreshing..." : "Refresh Validation"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card text-sm text-zinc-500">Loading validation surface...</div>
      ) : !selectedInstance ? (
        <div className="card text-sm text-zinc-500">
          No Strategy1 instance is configured yet. Validation opens once a Strategy1 paper instance exists.
        </div>
      ) : errorState ? (
        <div className="card">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">{errorState.title}</h2>
            {errorState.detail ? <span className="badge badge-amber">{errorState.detail}</span> : null}
          </div>
          <p className="mt-3 text-sm text-zinc-400">{errorState.message}</p>
        </div>
      ) : validation ? (
        <>
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Parity Board</h2>
                <p className="mt-1 text-xs text-zinc-600">
                  BUY/SELL parity, whole-day candle source, and recorded order flow for {validation.trade_date}.
                </p>
              </div>
              <span className={clsx("badge", verdictTone(validation.comparison?.verdict))}>
                {validation.comparison?.verdict || "—"}
              </span>
            </div>

            {candleSource.warning ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-100">
                Historical fetch warning: {candleSource.warning}. Replay used {formatSourceLabel(candleSource.selected)} for this validation run.
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6 stagger">
              <StatCard
                label="BUY Parity"
                value={`${actualBuyCount}/${replayBuyCount}`}
                detail={`${buyMismatchCount} BUY mismatches`}
                tone={parityTone(buyMismatchCount === 0)}
              />
              <StatCard
                label="SELL Parity"
                value={`${actualSellCount}/${replaySellCount}`}
                detail={`${sellMismatchCount} SELL mismatches`}
                tone={parityTone(sellMismatchCount === 0)}
              />
              <StatCard
                label="Orders Closed"
                value={`${completedOrders}/${summary.actualOrders || 0}`}
                detail={`${formatMetric(summary.failedOrders, 0)} failed · ${formatMetric(summary.missingOrders, 0)} missing`}
                tone={parityTone((summary.failedOrders || 0) === 0 && (summary.missingOrders || 0) === 0, completedOrders < (summary.actualOrders || 0))}
              />
              <StatCard
                label="Data Continuity"
                value={formatMetric(candleAudit.gapCount, 0)}
                detail={`${formatMetric(candleAudit.totalMissingMinutes, 0)} missing minutes · ${formatSourceLabel(candleSource.selected)}`}
                tone={parityTone((candleAudit.gapCount || 0) === 0)}
              />
              <StatCard
                label="Replay Source"
                value={formatSourceLabel(candleSource.selected)}
                detail={`Historical ${formatMetric(candleSource.historical_count, 0)} · Retained ${formatMetric(candleSource.retained_count, 0)}`}
                tone={sourceTone(candleSource.selected, candleSource.warning)}
              />
              <StatCard
                label="Verdict"
                value={validation.comparison?.verdict || "—"}
                detail={`Generated ${formatDateTime(validation.generated_at)}`}
                tone={
                  validation.comparison?.verdict === "PASS"
                    ? "text-emerald-400"
                    : validation.comparison?.verdict === "WARN"
                      ? "text-amber-400"
                      : "text-rose-400"
                }
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <div className="card">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Session Scope</h3>
                  <span className="text-xs text-zinc-600">{validation.strategy?.symbol || "—"}</span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="section-label">Strategy</div>
                    <div className="mt-1 text-sm text-zinc-300">
                      {validation.strategy?.strategy_name} · #{validation.strategy?.instance_id}
                    </div>
                    <div className="mt-1 text-xs text-zinc-600">
                      {validation.strategy?.client_name || "—"} · fixedMax {String(validation.strategy?.fixedMax)} · maxRed {formatMetric(validation.strategy?.maxRed, 0)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="section-label">Data Window</div>
                    <div className="mt-1 text-sm text-zinc-300">
                      {formatDateTime(candleAudit.firstBarTime)} to {formatDateTime(candleAudit.lastBarTime)}
                    </div>
                    <div className="mt-1 text-xs text-zinc-600">
                      {formatMetric(candleAudit.count, 0)} candles · available after {validation.available_after_ist} IST
                    </div>
                  </div>
                  <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="section-label">Replay Source</div>
                    <div className={clsx("mt-1 text-sm font-medium", sourceTone(candleSource.selected, candleSource.warning))}>
                      {formatSourceLabel(candleSource.selected)}
                    </div>
                    <div className="mt-1 text-xs text-zinc-600">
                      Historical {formatMetric(candleSource.historical_count, 0)} · Retained {formatMetric(candleSource.retained_count, 0)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Signal Split</h3>
                  <span className="text-xs text-zinc-600">Replay vs recorded</span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="section-label">Replay</div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="font-data text-2xl font-semibold text-white">{formatMetric(summary.replaySignals, 0)}</span>
                      <span className="text-xs text-zinc-600">signals</span>
                    </div>
                    <div className="mt-2 flex gap-2 text-xs text-zinc-500">
                      <span>BUY {replayBuyCount}</span>
                      <span>SELL {replaySellCount}</span>
                    </div>
                  </div>
                  <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="section-label">Recorded</div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="font-data text-2xl font-semibold text-white">{formatMetric(summary.actualSignals, 0)}</span>
                      <span className="text-xs text-zinc-600">signals</span>
                    </div>
                    <div className="mt-2 flex gap-2 text-xs text-zinc-500">
                      <span>BUY {actualBuyCount}</span>
                      <span>SELL {actualSellCount}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                  <span>Matched {formatMetric(summary.matchedSignals, 0)}</span>
                  <span>Missing {formatMetric(summary.missingSignals, 0)}</span>
                  <span>Extra {formatMetric(summary.extraSignals, 0)}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Session Replay</h2>
                <p className="mt-1 text-xs text-zinc-600">
                  Toggle the chart between replayed and recorded signals, then inspect whether whole-day replay came from Angel historical candles or retained feed candles.
                </p>
              </div>
              <div className="flex items-center gap-1 rounded-full border px-1 py-1" style={{ borderColor: "var(--border)" }}>
                <ModeButton active={chartMode === "replay"} onClick={() => setChartMode("replay")}>Replay Signals</ModeButton>
                <ModeButton active={chartMode === "recorded"} onClick={() => setChartMode("recorded")}>Recorded Signals</ModeButton>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <SignalChart
                candles={chartCandles}
                signals={chartSignals}
                symbol={`${validation.strategy?.symbol || "Strategy1"} · ${chartMode === "replay" ? "Replay" : "Recorded"}`}
              />

              <div className="space-y-4">
                <EventList
                  title="Replayed Signals"
                  events={replaySignals}
                  emptyLabel="No Strategy1 signals were replayed for this day."
                />
                <EventList
                  title="Recorded Signals"
                  events={actualSignals.map((signal) => ({
                    action: signal.action,
                    barTime: signal.trigger_bar_time || signal.timestamp,
                    reason: signal.reason,
                    price: signal.price,
                  }))}
                  emptyLabel="No recorded Strategy1 signals were found for this day."
                />
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="card-flush">
                <div className="flex items-center justify-between px-5 py-4">
                  <h2 className="text-sm font-semibold text-white">Actual Orders</h2>
                  <span className="text-xs text-zinc-600">{actualOrders.length} orders</span>
                </div>
                {actualOrders.length === 0 ? (
                  <div className="px-5 pb-5 text-sm text-zinc-500">No recorded orders were found for this validation session.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="table-header">Time</th>
                          <th className="table-header">Side</th>
                          <th className="table-header">Status</th>
                          <th className="table-header">Instrument</th>
                          <th className="table-header">Qty</th>
                          <th className="table-header">Price</th>
                          <th className="table-header">Event</th>
                        </tr>
                      </thead>
                      <tbody>
                        {actualOrders.map((order) => (
                          <tr key={order.id || `${order.event_id}-${order.created_at}`} className="group transition-colors hover:bg-white/[0.02]">
                            <td className="table-cell font-data text-xs text-zinc-400">
                              {formatDateTime(order.created_at)}
                            </td>
                            <td className="table-cell">
                              <span className={clsx("badge", String(order.side || "").toUpperCase() === "BUY" ? "badge-green" : "badge-rose")}>
                                {order.side || "—"}
                              </span>
                            </td>
                            <td className="table-cell text-sm text-zinc-300">
                              {order.status || "—"}
                            </td>
                            <td className="table-cell text-xs text-zinc-500">
                              {order.instrument || order.symbol || "—"}
                            </td>
                            <td className="table-cell font-data text-xs text-zinc-300">
                              {formatMetric(order.quantity, 0)}
                            </td>
                            <td className="table-cell font-data text-xs text-zinc-300">
                              {formatCurrency(order.avg_price ?? order.price)}
                            </td>
                            <td className="table-cell font-data text-[10px] text-zinc-600">
                              {order.event_id || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="card-flush">
                <div className="flex items-center justify-between px-5 py-4">
                  <h2 className="text-sm font-semibold text-white">Replay Timeline</h2>
                  <span className="text-xs text-zinc-600">{timeline.length} candles</span>
                </div>
                {timeline.length === 0 ? (
                  <div className="px-5 pb-5 text-sm text-zinc-500">No replay timeline available.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="table-header">Bar</th>
                          <th className="table-header">Action</th>
                          <th className="table-header">Red</th>
                          <th className="table-header">ATR</th>
                          <th className="table-header">Trail</th>
                          <th className="table-header">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeline.slice(-24).map((row) => (
                          <tr key={row.barTime} className="group transition-colors hover:bg-white/[0.02]">
                            <td className="table-cell font-data text-xs text-zinc-400">
                              {formatDateTime(row.barTime)}
                            </td>
                            <td className="table-cell">
                              <span
                                className={clsx(
                                  "badge",
                                  row.action === "BUY"
                                    ? "badge-green"
                                    : row.action === "SELL"
                                      ? "badge-rose"
                                      : "badge-neutral",
                                )}
                              >
                                {row.action || "NONE"}
                              </span>
                            </td>
                            <td className="table-cell font-data text-xs text-zinc-300">
                              {formatMetric(row.redCount, 0)}
                            </td>
                            <td className="table-cell font-data text-xs text-zinc-300">
                              {formatMetric(row.atr)}
                            </td>
                            <td className="table-cell font-data text-xs text-zinc-300">
                              {formatMetric(row.trailingStop)}
                            </td>
                            <td className="table-cell text-xs text-zinc-500">
                              {row.reason || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="card-flush">
              <div className="flex items-center justify-between px-5 py-4">
                <h2 className="text-sm font-semibold text-white">Mismatch Audit</h2>
                <span className="text-xs text-zinc-600">{mismatches.length} rows</span>
              </div>
              {mismatches.length === 0 ? (
                <div className="px-5 pb-5 text-sm text-zinc-500">No replay mismatch detected for the selected day.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="table-header">Kind</th>
                        <th className="table-header">Bar Time</th>
                        <th className="table-header">Expected</th>
                        <th className="table-header">Actual</th>
                        <th className="table-header">Order</th>
                        <th className="table-header">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mismatches.map((row, index) => (
                        <tr key={`${row.kind}-${row.barTime || index}`} className="group transition-colors hover:bg-white/[0.02]">
                          <td className="table-cell">
                            <span className="badge badge-neutral">{row.kind}</span>
                          </td>
                          <td className="table-cell font-data text-xs text-zinc-400">
                            {formatDateTime(row.barTime)}
                          </td>
                          <td className="table-cell text-sm text-zinc-300">
                            {row.expectedAction || "—"}
                          </td>
                          <td className="table-cell text-sm text-zinc-300">
                            {row.actualAction || "—"}
                          </td>
                          <td className="table-cell text-sm text-zinc-400">
                            {row.orderStatus || "—"}
                          </td>
                          <td className="table-cell text-xs text-zinc-500">
                            {row.note}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
