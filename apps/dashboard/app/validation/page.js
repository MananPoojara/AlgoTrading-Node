"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  return `₹${numeric.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value, axisMode = "intraday") {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      ...(axisMode === "daily"
        ? { dateStyle: "medium" }
        : { dateStyle: "medium", timeStyle: "short" }),
    });
  } catch {
    return String(value);
  }
}

function formatSourceLabel(source) {
  if (source === "angel_historical") return "Angel Historical";
  if (source === "angel_historical_daily") return "Angel Daily Historical";
  if (source === "angel_historical_intraday") return "Angel Intraday Historical";
  if (source === "market_ohlc_1m") return "Retained Feed";
  if (source === "market_ohlc_1m_daily") return "Retained Daily";
  if (source === "market_ohlc_1m_intraday") return "Retained Intraday";
  return "Unknown";
}

function formatSourceQuality(sourceQuality) {
  if (sourceQuality === "complete") return "Complete";
  if (sourceQuality === "partial") return "Partial";
  if (sourceQuality === "empty") return "Empty";
  return "Unknown";
}

function sourceTone(source, warning) {
  if (warning) return "text-amber-400";
  if (String(source || "").startsWith("angel_historical")) {
    return "text-emerald-400";
  }
  return "text-zinc-200";
}

function verdictTone(verdict) {
  if (verdict === "PASS") return "text-emerald-400";
  if (verdict === "WARN") return "text-amber-400";
  if (verdict === "FAIL") return "text-rose-400";
  return "text-white";
}

function normalizeValidationMode(instance) {
  const raw = String(instance?.parameters?.timeframe || "")
    .trim()
    .toLowerCase();
  if (["1day", "1d", "day", "daily", ""].includes(raw)) {
    return "daily_30d";
  }
  return "session_day";
}

function formatTimeframeLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1d", "1day", "daily", "day"].includes(normalized)) return "1day";
  if (["1m", "1min"].includes(normalized)) return "1min";
  if (["5m", "5min"].includes(normalized)) return "5min";
  if (["15m", "15min"].includes(normalized)) return "15min";
  return value || "—";
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

function buildDailyMarkers(validation) {
  const finalMarkers = (validation?.replay?.events || []).map((event) => ({
    timestamp: event.barTime,
    action: event.action,
    price: event.price,
    kind: "signal",
    label: event.reason || null,
  }));

  const candidateMarkers = (validation?.replay?.candidate_events || [])
    .filter((event) => event.blockedByVwap)
    .map((event) => ({
      timestamp: event.barTime,
      action: event.action,
      price: event.price,
      kind: "candidate_signal",
      label: `Base ${event.action || "signal"} · ${event.gateReason || "VWAP blocked"}`,
    }));

  return [...finalMarkers, ...candidateMarkers];
}

function buildSessionMarkers(sessionValidation) {
  if (!sessionValidation) {
    return [];
  }

  const replayCandidateMarkers = (
    sessionValidation.replay?.candidate_events || []
  )
    .filter((signal) => signal.blockedByVwap)
    .map((signal) => ({
      timestamp: signal.barTime || signal.timestamp,
      action: signal.action,
      price: signal.price,
      kind: "candidate_signal",
      label: `Base ${signal.action || "signal"}${signal.gateReason ? ` · ${signal.gateReason}` : ""}`,
    }));

  const replaySignalMarkers = (sessionValidation.replay?.events || []).map(
    (signal) => ({
      timestamp: signal.barTime || signal.timestamp,
      action: signal.action,
      price: signal.price,
      kind: "signal",
      label: `Replay ${signal.action || "signal"}${signal.reason ? ` · ${signal.reason}` : ""}`,
    }),
  );

  const strategySignalMarkers = (
    sessionValidation.actual?.strategy_signals || []
  ).map((signal) => ({
    timestamp: signal.trigger_bar_time || signal.timestamp,
    action: signal.action,
    price: signal.price,
    kind: "signal",
    label: `Recorded ${signal.action || "signal"}${signal.reason ? ` · ${signal.reason}` : ""}`,
  }));

  const strategyOrderMarkers = (
    sessionValidation.actual?.strategy_orders || []
  ).map((order) => ({
    timestamp: order.created_at,
    action: order.side,
    price: order.average_fill_price || order.average_price || order.price,
    kind: "strategy_order",
    label: order.status || null,
  }));

  const manualOverrideMarkers = (
    sessionValidation.actual?.manual_overrides || []
  ).map((override) => ({
    timestamp: override.timestamp,
    action: override.action,
    price: override.price,
    kind: "manual_override",
    label: override.reason || null,
  }));

  const manualCorrectionMarkers = (
    sessionValidation.actual?.manual_corrections || []
  ).map((correction) => ({
    timestamp: correction.timestamp,
    action:
      Number(correction.metadata?.corrected_quantity || 0) >=
      Number(correction.metadata?.previous_quantity || 0)
        ? "BUY"
        : "SELL",
    price: correction.metadata?.corrected_average_price,
    kind: "manual_correction",
    label: correction.metadata?.reason || "Manual correction",
  }));

  return [
    ...replayCandidateMarkers,
    ...replaySignalMarkers,
    ...strategySignalMarkers,
    ...strategyOrderMarkers,
    ...manualOverrideMarkers,
    ...manualCorrectionMarkers,
  ];
}

function ModeButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-white/[0.10] text-white"
          : "text-zinc-500 hover:text-zinc-300",
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
      <div className={clsx("mt-2 font-data text-2xl font-semibold", tone)}>
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-600">{detail}</div>
    </div>
  );
}

function SectionHeader({ title, description, badge = null }) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-zinc-600">{description}</p>
        ) : null}
      </div>
      {badge}
    </div>
  );
}

function EmptyCard({ message }) {
  return <div className="card text-sm text-zinc-500">{message}</div>;
}

function MessageCard({ title, message, detail = null, tone = "neutral" }) {
  const toneClasses =
    tone === "warning"
      ? "border-amber-500/30 bg-amber-500/[0.08] text-amber-100"
      : "border-[var(--border)] bg-transparent text-zinc-300";

  return (
    <div className={clsx("rounded-lg border px-4 py-4", toneClasses)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {detail ? <span className="badge badge-amber">{detail}</span> : null}
      </div>
      <p className="mt-2 text-sm">{message}</p>
    </div>
  );
}

function SignalTable({ title, rows = [], emptyLabel, axisMode = "intraday" }) {
  return (
    <div className="card-flush">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-zinc-500">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-header">Time</th>
                <th className="table-header">Action</th>
                <th className="table-header">Reason</th>
                <th className="table-header">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${title}-${row.event_id || row.barTime || row.timestamp || index}`}
                >
                  <td className="table-cell font-data text-xs text-zinc-400">
                    {formatDateTime(
                      row.barTime || row.trigger_bar_time || row.timestamp,
                      axisMode,
                    )}
                  </td>
                  <td className="table-cell">
                    <span
                      className={clsx(
                        "badge",
                        String(row.action || "").toUpperCase() === "BUY"
                          ? "badge-green"
                          : "badge-rose",
                      )}
                    >
                      {row.action || "—"}
                    </span>
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {row.reason || row.exit_reason || "—"}
                  </td>
                  <td className="table-cell font-data text-xs text-zinc-300">
                    {formatCurrency(row.price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrdersTable({ title, rows = [], emptyLabel, dailyMode = false }) {
  return (
    <div className="card-flush">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-zinc-500">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-header">{dailyMode ? "Entry" : "Time"}</th>
                <th className="table-header">{dailyMode ? "Exit" : "Side"}</th>
                <th className="table-header">
                  {dailyMode ? "Entry Price" : "Status"}
                </th>
                <th className="table-header">
                  {dailyMode ? "Exit Price" : "Instrument"}
                </th>
                <th className="table-header">{dailyMode ? "PnL" : "Qty"}</th>
                <th className="table-header">
                  {dailyMode ? "Reason" : "Price"}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${title}-${row.id || row.event_id || row.entry_date || index}`}
                >
                  <td className="table-cell font-data text-xs text-zinc-400">
                    {formatDateTime(
                      dailyMode ? row.entry_date : row.created_at,
                      dailyMode ? "daily" : "intraday",
                    )}
                  </td>
                  <td className="table-cell text-xs text-zinc-300">
                    {dailyMode ? (
                      formatDateTime(row.exit_date, "daily")
                    ) : (
                      <span
                        className={clsx(
                          "badge",
                          String(row.side || "").toUpperCase() === "BUY"
                            ? "badge-green"
                            : "badge-rose",
                        )}
                      >
                        {row.side || "—"}
                      </span>
                    )}
                  </td>
                  <td className="table-cell font-data text-xs text-zinc-300">
                    {dailyMode
                      ? formatCurrency(row.entry_price)
                      : row.status || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {dailyMode
                      ? formatCurrency(row.exit_price)
                      : row.instrument || row.symbol || "—"}
                  </td>
                  <td
                    className={clsx(
                      "table-cell font-data text-xs",
                      dailyMode
                        ? Number(row.pnl) >= 0
                          ? "text-emerald-300"
                          : "text-rose-300"
                        : "text-zinc-300",
                    )}
                  >
                    {dailyMode
                      ? formatCurrency(row.pnl)
                      : formatMetric(row.quantity, 0)}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {dailyMode
                      ? row.exit_reason || row.entry_reason || "—"
                      : formatCurrency(
                          row.average_fill_price ||
                            row.average_price ||
                            row.price,
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityTable({ title, rows = [], emptyLabel }) {
  return (
    <div className="card-flush">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-zinc-500">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-header">Time</th>
                <th className="table-header">Action</th>
                <th className="table-header">Operator</th>
                <th className="table-header">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${title}-${row.id || row.timestamp || index}`}>
                  <td className="table-cell font-data text-xs text-zinc-400">
                    {formatDateTime(row.timestamp)}
                  </td>
                  <td className="table-cell text-xs text-zinc-300">
                    {row.action || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {row.operator_username || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {row.metadata?.reason || row.metadata?.event_type || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function ManualCorrectionsTable({ rows = [], emptyLabel }) {
  return (
    <div className="card-flush">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-sm font-semibold text-white">Manual Position Corrections</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-zinc-500">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-header">Time</th>
                <th className="table-header">Operator</th>
                <th className="table-header">Instrument</th>
                <th className="table-header">Quantity</th>
                <th className="table-header">Avg Price</th>
                <th className="table-header">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`manual-correction-${row.id || row.timestamp || index}`}>
                  <td className="table-cell font-data text-xs text-zinc-400">
                    {formatDateTime(row.timestamp)}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {row.operator_username || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-300">
                    {row.metadata?.instrument || row.metadata?.symbol || "—"}
                  </td>
                  <td className="table-cell font-data text-xs text-zinc-300">
                    {formatMetric(row.metadata?.corrected_quantity, 0)}
                  </td>
                  <td className="table-cell font-data text-xs text-zinc-300">
                    {formatCurrency(row.metadata?.corrected_average_price)}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
                    {row.metadata?.reason || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MismatchTable({ rows = [] }) {
  return (
    <div className="card-flush">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-sm font-semibold text-white">Mismatch Audit</h2>
        <span className="text-xs text-zinc-600">{rows.length} rows</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-zinc-500">
          No replay mismatch detected for the selected session.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-header">Kind</th>
                <th className="table-header">Bar</th>
                <th className="table-header">Expected</th>
                <th className="table-header">Actual</th>
                <th className="table-header">Order</th>
                <th className="table-header">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.kind}-${row.barTime || index}`}>
                  <td className="table-cell">
                    <span className="badge badge-neutral">{row.kind}</span>
                  </td>
                  <td className="table-cell font-data text-xs text-zinc-400">
                    {formatDateTime(row.barTime)}
                  </td>
                  <td className="table-cell text-xs text-zinc-300">
                    {row.expectedAction || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-300">
                    {row.actualAction || "—"}
                  </td>
                  <td className="table-cell text-xs text-zinc-500">
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
  );
}

function ValidationPageContent() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedInstanceId = searchParams.get("instance_id");
  const requestedTradeDate = searchParams.get("trade_date") || getTodayIstDate();
  const requestedMode = searchParams.get("mode");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [instances, setInstances] = useState([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState(null);
  const [validationMode, setValidationMode] = useState(
    requestedMode === "session_day" || requestedMode === "daily_30d"
      ? requestedMode
      : "daily_30d",
  );
  const [tradeDate, setTradeDate] = useState(requestedTradeDate);
  const [validation, setValidation] = useState(null);
  const [errorState, setErrorState] = useState(null);
  const [selectedSessionDate, setSelectedSessionDate] = useState(null);
  const [drilldown, setDrilldown] = useState(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState(null);

  const strategyInstances = useMemo(
    () =>
      instances.filter(
        (instance) =>
          String(instance.strategy_name || "").toUpperCase() ===
          "STRATEGY1_LIVE",
      ),
    [instances],
  );

  const selectedInstance = useMemo(
    () =>
      strategyInstances.find(
        (instance) => Number(instance.id) === Number(selectedInstanceId),
      ) ||
      strategyInstances[0] ||
      null,
    [selectedInstanceId, strategyInstances],
  );

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    let active = true;

    const fetchInstances = async () => {
      try {
        const response = await api.getStrategyInstances({ limit: 50 });
        if (!active || !response.success) {
          return;
        }

        const nextInstances = response.data || [];
        const nextStrategyInstances = nextInstances.filter(
          (instance) =>
            String(instance.strategy_name || "").toUpperCase() ===
            "STRATEGY1_LIVE",
        );

        setInstances(nextInstances);
        setSelectedInstanceId((current) => {
          if (
            requestedInstanceId &&
            nextStrategyInstances.some(
              (instance) => Number(instance.id) === Number(requestedInstanceId),
            )
          ) {
            return Number(requestedInstanceId);
          }
          if (
            current &&
            nextStrategyInstances.some(
              (instance) => Number(instance.id) === Number(current),
            )
          ) {
            return current;
          }
          return nextStrategyInstances[0]?.id || null;
        });
      } catch (error) {
        if (!active) return;
        setErrorState({
          title: "Strategy instances unavailable",
          message: error.message,
        });
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchInstances();

    return () => {
      active = false;
    };
  }, [requestedInstanceId, router, user]);

  useEffect(() => {
    if (!selectedInstance?.id) {
      return;
    }

    if (requestedMode === "session_day" || requestedMode === "daily_30d") {
      setValidationMode(requestedMode);
      return;
    }

    setValidationMode(normalizeValidationMode(selectedInstance));
  }, [requestedMode, selectedInstance?.id]);

  useEffect(() => {
    if (!selectedInstance?.id) {
      setValidation(null);
      return;
    }

    let active = true;

    const fetchValidation = async () => {
      setLoading(true);
      try {
        const params = { mode: validationMode };
        if (validationMode === "session_day") {
          params.trade_date = tradeDate;
        }

        const response = await api.getStrategyValidation(
          selectedInstance.id,
          params,
        );
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
                ? "Today’s session validation opens after 16:15 IST so the intraday candle set is finalized."
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
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchValidation();

    return () => {
      active = false;
    };
  }, [selectedInstance?.id, tradeDate, validationMode]);

  useEffect(() => {
    if (validationMode !== "daily_30d" || !validation) {
      setSelectedSessionDate(null);
      setDrilldown(null);
      setDrilldownError(null);
      return;
    }

    const nextDate =
      selectedSessionDate &&
      (validation.candles || []).some(
        (candle) => candle.date === selectedSessionDate,
      )
        ? selectedSessionDate
        : validation.default_session_date ||
          validation.window?.last_bar_date ||
          validation.candles?.[validation.candles.length - 1]?.date ||
          null;

    setSelectedSessionDate(nextDate);
  }, [selectedSessionDate, validation, validationMode]);

  useEffect(() => {
    if (
      validationMode !== "daily_30d" ||
      !selectedInstance?.id ||
      !selectedSessionDate
    ) {
      return;
    }

    let active = true;

    const fetchDrilldown = async () => {
      setDrilldownLoading(true);
      try {
        const response = await api.getStrategyValidation(selectedInstance.id, {
          mode: "session_day",
          trade_date: selectedSessionDate,
        });
        if (!active) return;
        setDrilldown(response.data || null);
        setDrilldownError(null);
      } catch (error) {
        if (!active) return;
        setDrilldown(null);
        setDrilldownError({
          title: "Intraday drill-down unavailable",
          message: error.message,
        });
      } finally {
        if (active) {
          setDrilldownLoading(false);
        }
      }
    };

    fetchDrilldown();

    return () => {
      active = false;
    };
  }, [selectedInstance?.id, selectedSessionDate, validationMode]);

  const refreshValidation = async () => {
    if (!selectedInstance?.id) {
      return;
    }

    setRefreshing(true);
    try {
      const params = { mode: validationMode };
      if (validationMode === "session_day") {
        params.trade_date = tradeDate;
      }
      const response = await api.getStrategyValidation(
        selectedInstance.id,
        params,
      );
      setValidation(response.data || null);
      setErrorState(null);
    } catch (error) {
      setValidation(null);
      setErrorState({
        title:
          error.status === 409
            ? "Validation window not open"
            : "Validation unavailable",
        message:
          error.status === 409
            ? "Today’s session validation opens after 16:15 IST so the intraday candle set is finalized."
            : error.message,
        detail: error.data?.data?.available_after_ist
          ? `Available after ${error.data.data.available_after_ist} IST`
          : null,
      });
    } finally {
      setRefreshing(false);
    }
  };

  const isDailyMode = validationMode === "daily_30d";
  const sessionView = isDailyMode ? drilldown : validation;

  const replaySignals = validation?.replay?.events || [];
  const replayCandidateSignals = validation?.replay?.candidate_events || [];
  const replayStats = validation?.replay?.stats || {};
  const syntheticOrders = validation?.replay?.synthetic_orders || [];
  const dailyMarkers = useMemo(
    () => buildDailyMarkers(validation),
    [validation],
  );

  const sessionActualSignals = sessionView?.actual?.strategy_signals || [];
  const sessionStrategyOrders = sessionView?.actual?.strategy_orders || [];
  const sessionManualOverrides = sessionView?.actual?.manual_overrides || [];
  const sessionManualCorrections = sessionView?.actual?.manual_corrections || [];
  const sessionOperatorTrades = sessionView?.actual?.operator_trades || [];
  const sessionOperatorActivity = sessionView?.actual?.operator_activity || [];
  const sessionPositionMismatch = sessionView?.position_mismatch || validation?.position_mismatch || null;
  const sessionVwapSeries =
    sessionView?.replay?.vwapSeries || sessionView?.replay?.vwap_series || [];
  const sessionMarkers = useMemo(
    () => buildSessionMarkers(sessionView),
    [sessionView],
  );
  const sessionReplayCandidateSignals =
    sessionView?.replay?.candidate_events || [];

  const mismatches = sessionView?.comparison?.mismatches || [];
  const summary = sessionView?.comparison?.summary || {};
  const candleAudit = sessionView?.candle_audit || {};
  const dailyCandleSource = validation?.candle_source || {};
  const sessionCandleSource = sessionView?.candle_source || dailyCandleSource;
  const dailyVwapGateSummary = validation?.replay?.vwap_gate_summary || {};
  const missingVolumeDays = dailyCandleSource.days_with_missing_volume || [];
  const missingCandleDays = dailyCandleSource.days_with_missing_candles || [];
  const vwapAvailableDays = dailyCandleSource.vwap_available_days || [];
  const sourceQuality = dailyCandleSource.source_quality || "unknown";
  const replayBuyCount = replaySignals.filter(
    (event) => event.action === "BUY",
  ).length;
  const replayCandidateBuyCount = replayCandidateSignals.filter(
    (event) => event.action === "BUY",
  ).length;
  const replaySellCount = replaySignals.filter(
    (event) => event.action === "SELL",
  ).length;
  const sessionReplayCandidateBuyCount = sessionReplayCandidateSignals.filter(
    (event) => event.action === "BUY",
  ).length;
  const sessionBuyCount = sessionActualSignals.filter(
    (event) => event.action === "BUY",
  ).length;
  const sessionSellCount = sessionActualSignals.filter(
    (event) => event.action === "SELL",
  ).length;
  const completedOrders = sessionStrategyOrders.filter((order) =>
    ["filled", "completed"].includes(String(order.status || "").toLowerCase()),
  ).length;
  const buyMismatchCount = countMismatches(mismatches, "BUY");
  const sellMismatchCount = countMismatches(mismatches, "SELL");

  if (!user) {
    return null;
  }

  return (
    <div className="space-y-5 animate-in">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Validation</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Strategy1 daily replay, intraday drill-down, and backend-truth order
            visibility.
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
                    #{instance.id} ·{" "}
                    {instance.client_name || instance.client_id} ·{" "}
                    {instance.parameters?.symbol || "NIFTY 50"}
                  </option>
                ))
              )}
            </select>
          </label>

          <div
            className="flex items-center gap-1 rounded-full border px-1 py-1"
            style={{ borderColor: "var(--border)" }}
          >
            <ModeButton
              active={validationMode === "daily_30d"}
              onClick={() => setValidationMode("daily_30d")}
            >
              30D Daily Validation
            </ModeButton>
            <ModeButton
              active={validationMode === "session_day"}
              onClick={() => setValidationMode("session_day")}
            >
              Session Validation
            </ModeButton>
          </div>

          {validationMode === "session_day" ? (
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
          ) : null}

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
        <EmptyCard message="Loading validation surface..." />
      ) : !selectedInstance ? (
        <EmptyCard message="No Strategy1 instance is configured yet. Validation opens once a Strategy1 paper instance exists." />
      ) : errorState ? (
        <MessageCard
          title={errorState.title}
          message={errorState.message}
          detail={errorState.detail}
          tone={errorState.detail ? "warning" : "neutral"}
        />
      ) : !validation ? null : (
        <>
          {isDailyMode ? (
            <section className="space-y-4">
              <SectionHeader
                title="Performance Board"
                description={`Replay-only Strategy1 performance from the last ${validation.window?.lookback_trading_days || 30} completed trading days on daily bars.`}
                badge={
                  <div className="flex items-center gap-2">
                    <span className="badge badge-neutral">
                      {formatTimeframeLabel(validation.strategy?.timeframe)}
                    </span>
                    <span
                      className={clsx(
                        "badge",
                        sourceTone(
                          dailyCandleSource.selected,
                          dailyCandleSource.warning,
                        ),
                      )}
                    >
                      {formatSourceLabel(dailyCandleSource.selected)}
                    </span>
                  </div>
                }
              />

              {dailyCandleSource.warning ? (
                <MessageCard
                  title="Historical fetch warning"
                  message={`Replay used ${formatSourceLabel(dailyCandleSource.selected)} because the broker daily history call reported: ${dailyCandleSource.warning}`}
                  tone="warning"
                />
              ) : null}

              {sourceQuality !== "complete" ? (
                <MessageCard
                  title="Replay data quality degraded"
                  message={`Daily replay rebuilt ${formatMetric(dailyCandleSource.minute_days_loaded, 0)} of ${formatMetric(dailyCandleSource.minute_days_requested, 0)} requested sessions. Missing candle days: ${missingCandleDays.length || 0}. VWAP-unavailable days: ${missingVolumeDays.length || 0}.`}
                  detail={formatSourceQuality(sourceQuality)}
                  tone="warning"
                />
              ) : null}

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6 stagger">
                <StatCard
                  label="Total Trades"
                  value={formatMetric(replayStats.totalTrades, 0)}
                  detail={`${formatMetric(replayBuyCount, 0)} BUY · ${formatMetric(replaySellCount, 0)} SELL`}
                />
                <StatCard
                  label="Base BUY Candidates"
                  value={formatMetric(replayCandidateBuyCount, 0)}
                  detail="Signals before the VWAP gate was applied"
                  tone={
                    replayCandidateBuyCount > replayBuyCount
                      ? "text-amber-400"
                      : "text-zinc-200"
                  }
                />
                <StatCard
                  label="Win Rate"
                  value={`${formatMetric(replayStats.winRate)}%`}
                  detail={`${formatMetric(replayStats.wins, 0)} wins · ${formatMetric(replayStats.losses, 0)} losses`}
                  tone={
                    Number(replayStats.winRate) >= 50
                      ? "text-emerald-400"
                      : "text-amber-400"
                  }
                />
                <StatCard
                  label="Net PnL"
                  value={formatCurrency(replayStats.netPnl)}
                  detail={`Avg ${formatCurrency(replayStats.averagePnlPerTrade)} per trade`}
                  tone={
                    Number(replayStats.netPnl) >= 0
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }
                />
                <StatCard
                  label="Gross Profit / Loss"
                  value={`${formatCurrency(replayStats.grossProfit)} / ${formatCurrency(replayStats.grossLoss)}`}
                  detail={`Max win ${formatCurrency(replayStats.maxWin)} · Max loss ${formatCurrency(replayStats.maxLoss)}`}
                />
                <StatCard
                  label="Max Drawdown"
                  value={formatCurrency(replayStats.maxDrawdown)}
                  detail={`Ending equity ${formatCurrency(replayStats.endingEquity)}`}
                  tone={
                    Number(replayStats.maxDrawdown) > 0
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }
                />
                <StatCard
                  label="Window"
                  value={`${validation.window?.lookback_trading_days || 30} days`}
                  detail={`${validation.window?.first_bar_date || "—"} to ${validation.window?.last_bar_date || "—"}`}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 stagger">
                <StatCard
                  label="VWAP Ready Days"
                  value={formatMetric(vwapAvailableDays.length, 0)}
                  detail={`${formatMetric(dailyVwapGateSummary.passedDays, 0)} passed · ${formatMetric(dailyVwapGateSummary.unavailableDays, 0)} unavailable`}
                  tone={
                    missingVolumeDays.length > 0
                      ? "text-amber-400"
                      : "text-sky-300"
                  }
                />
                <StatCard
                  label="Missing Candle Days"
                  value={formatMetric(missingCandleDays.length, 0)}
                  detail={`${formatMetric(dailyCandleSource.minute_days_loaded, 0)} loaded of ${formatMetric(dailyCandleSource.minute_days_requested, 0)}`}
                  tone={
                    missingCandleDays.length > 0
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }
                />
                <StatCard
                  label="Missing Volume Days"
                  value={formatMetric(missingVolumeDays.length, 0)}
                  detail="VWAP unavailable because volume was missing"
                  tone={
                    missingVolumeDays.length > 0
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }
                />
                <StatCard
                  label="Replay Quality"
                  value={formatSourceQuality(sourceQuality)}
                  detail={`${formatMetric(dailyVwapGateSummary.signalDays, 0)} signal days across ${formatMetric(dailyVwapGateSummary.totalDays, 0)} replayed sessions`}
                  tone={
                    sourceQuality === "complete"
                      ? "text-emerald-400"
                      : sourceQuality === "partial"
                        ? "text-amber-400"
                        : "text-rose-400"
                  }
                />
              </div>
            </section>
          ) : (
            <section className="space-y-4">
              <SectionHeader
                title="Parity Board"
                description={`Replay parity and recorded order flow for ${validation.trade_date}.`}
                badge={
                  <span
                    className={clsx(
                      "badge",
                      verdictTone(validation.comparison?.verdict),
                    )}
                  >
                    {validation.comparison?.verdict || "—"}
                  </span>
                }
              />

              {sessionCandleSource.warning ? (
                <MessageCard
                  title="Historical fetch warning"
                  message={`Replay used ${formatSourceLabel(sessionCandleSource.selected)} because the intraday historical call reported: ${sessionCandleSource.warning}`}
                  tone="warning"
                />
              ) : null}

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6 stagger">
                <StatCard
                  label="BUY Parity"
                  value={`${sessionBuyCount}/${formatMetric(summary.replaySignals ? replaySignals.filter((event) => event.action === "BUY").length : replayBuyCount, 0)}`}
                  detail={`${buyMismatchCount} BUY mismatches`}
                  tone={parityTone(buyMismatchCount === 0)}
                />
                <StatCard
                  label="SELL Parity"
                  value={`${sessionSellCount}/${formatMetric(replaySignals.filter((event) => event.action === "SELL").length, 0)}`}
                  detail={`${sellMismatchCount} SELL mismatches`}
                  tone={parityTone(sellMismatchCount === 0)}
                />
                <StatCard
                  label="Orders Closed"
                  value={`${completedOrders}/${summary.actualOrders || 0}`}
                  detail={`${formatMetric(summary.failedOrders, 0)} failed · ${formatMetric(summary.missingOrders, 0)} missing`}
                  tone={parityTone(
                    (summary.failedOrders || 0) === 0 &&
                      (summary.missingOrders || 0) === 0,
                    completedOrders < (summary.actualOrders || 0),
                  )}
                />
                <StatCard
                  label="Data Continuity"
                  value={formatMetric(candleAudit.gapCount, 0)}
                  detail={`${formatMetric(candleAudit.totalMissingMinutes, 0)} missing minutes`}
                  tone={parityTone((candleAudit.gapCount || 0) === 0)}
                />
                <StatCard
                  label="Replay Source"
                  value={formatSourceLabel(sessionCandleSource.selected)}
                  detail={`Historical ${formatMetric(sessionCandleSource.historical_count, 0)} · Retained ${formatMetric(sessionCandleSource.retained_count, 0)}`}
                  tone={sourceTone(sessionCandleSource.selected, sessionCandleSource.warning)}
                />
                <StatCard
                  label="Verdict"
                  value={validation.comparison?.verdict || "—"}
                  detail={`Generated ${formatDateTime(validation.generated_at)}`}
                  tone={verdictTone(validation.comparison?.verdict)}
                />
              </div>
            </section>
          )}

          <section className="space-y-4">
            <SectionHeader
              title="Daily Replay Chart"
              description="Completed daily candles with Strategy1 replay BUY/SELL markers. Click a daily candle to load intraday drill-down."
            />
            {(validation.candles || []).length === 0 ? (
              <MessageCard
                title="Daily replay chart unavailable"
                message="No completed minute-backed daily candles could be reconstructed for the selected window. Check the source diagnostics above to see whether minute candles or usable volume were missing."
                detail={formatSourceQuality(sourceQuality)}
                tone="warning"
              />
            ) : (
              <SignalChart
                candles={validation.candles || []}
                markers={dailyMarkers}
                symbol={`${validation.strategy?.symbol || "Strategy1"} · 30D Daily Replay`}
                timeframeLabel="1day"
                axisMode="daily"
                selectedDate={selectedSessionDate}
                onSelectCandle={(candle) => setSelectedSessionDate(candle.date)}
                subtitle={`Source: ${formatSourceLabel(dailyCandleSource.selected)} · ${formatSourceQuality(sourceQuality)} minute replay · Today excluded · Default strategy timeframe ${formatTimeframeLabel(validation.strategy?.timeframe)}`}
              />
            )}
            <div className="grid gap-4 xl:grid-cols-3">
              <OrdersTable
                title="Synthetic Replay Trades"
                rows={syntheticOrders}
                emptyLabel="No replay trades were generated for this monthly daily window."
                dailyMode
              />
              <SignalTable
                title="Replay Base Signals"
                rows={replayCandidateSignals.map((row) => ({
                  ...row,
                  timestamp: row.barTime,
                  reason: row.gateReason
                    ? `${row.reason || "signal"} · ${row.gateReason}`
                    : row.reason,
                }))}
                emptyLabel="No replay candidate signals were generated before VWAP gating."
                axisMode="daily"
              />
              <SignalTable
                title="Replay Signals"
                rows={replaySignals.map((row) => ({
                  ...row,
                  timestamp: row.barTime,
                }))}
                emptyLabel="No replay signals were generated for this monthly daily window."
                axisMode="daily"
              />
            </div>
          </section>

          <section className="space-y-4">
            <SectionHeader
              title="Intraday Drill-down"
              description={
                selectedSessionDate
                  ? `1-minute session view for ${selectedSessionDate}. Strategy-generated activity and manual overrides are shown separately.`
                  : "Select a daily candle to load the matching 1-minute session."
              }
              badge={
                selectedSessionDate ? (
                  <span className="badge badge-neutral">
                    Selected {selectedSessionDate}
                  </span>
                ) : null
              }
            />

            {drilldownLoading ? (
              <EmptyCard message="Loading intraday drill-down..." />
            ) : drilldownError ? (
              <MessageCard
                title={drilldownError.title}
                message={drilldownError.message}
              />
            ) : !sessionView ? (
              <EmptyCard message="Select a daily candle to inspect the matching intraday session." />
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5 stagger">
                <StatCard
                  label="Strategy Signals"
                  value={formatMetric(sessionActualSignals.length, 0)}
                  detail={`${formatMetric(sessionBuyCount, 0)} BUY · ${formatMetric(sessionSellCount, 0)} SELL`}
                />
                <StatCard
                  label="Base BUY Candidates"
                  value={formatMetric(sessionReplayCandidateBuyCount, 0)}
                  detail="Replay entries before VWAP gating"
                  tone={
                    sessionReplayCandidateBuyCount > 0
                      ? "text-amber-400"
                      : "text-zinc-200"
                  }
                />
                <StatCard
                  label="Manual Overrides"
                  value={formatMetric(sessionManualOverrides.length, 0)}
                    detail="Operator-forced Strategy1 exits"
                    tone={
                      sessionManualOverrides.length > 0
                        ? "text-amber-400"
                        : "text-emerald-400"
                    }
                  />
                  <StatCard
                    label="Recorded Orders"
                    value={formatMetric(sessionStrategyOrders.length, 0)}
                    detail={`${completedOrders} completed`}
                  />
                  <StatCard
                    label="Operator Activity"
                    value={formatMetric(sessionOperatorActivity.length, 0)}
                    detail="Approvals and review actions"
                  />
                  <StatCard
                    label="Session Verdict"
                    value={sessionView.comparison?.verdict || "—"}
                    detail={`Source ${formatSourceLabel(sessionView.candle_source?.selected)}`}
                    tone={verdictTone(sessionView.comparison?.verdict)}
                  />
                </div>

                {sessionPositionMismatch?.has_mismatch ? (
                  <MessageCard
                    title="Position mismatch detected"
                    message={`Runtime state and persisted position state diverged: ${sessionPositionMismatch.reasons?.join(", ") || "unknown reason"}. Review the recent orders and manual corrections before trusting parity.`}
                    detail={`Active qty ${formatMetric(sessionPositionMismatch.active_position?.quantity, 0)} · Runtime entry ${sessionPositionMismatch.runtime_state?.entryContext ? "present" : "absent"}`}
                    tone="warning"
                  />
                ) : null}

                {sessionView?.candles?.length === 0 ? (
                  <MessageCard
                    title="Intraday chart unavailable"
                    message="The selected session did not return a replayable 1-minute candle set. This usually means the historical fetch failed or the retained feed is incomplete for that day."
                    tone="warning"
                  />
                ) : null}

                {sessionView?.candles?.length > 0 && sessionVwapSeries.length === 0 ? (
                  <MessageCard
                    title="VWAP unavailable for this session"
                    message="The session replay has candles, but no positive-volume minute bars were available to build VWAP. Strategy1 replay can still show the day, but the VWAP gate cannot be trusted for that session."
                    tone="warning"
                  />
                ) : null}

                {sessionView?.candles?.length > 0 ? (
                  <SignalChart
                    candles={sessionView.candles || []}
                    markers={sessionMarkers}
                    lineSeries={sessionVwapSeries}
                    symbol={`${sessionView.strategy?.symbol || "Strategy1"} · ${selectedSessionDate || sessionView.trade_date}`}
                    timeframeLabel="1min"
                    axisMode="intraday"
                    selectedDate={selectedSessionDate || sessionView.trade_date}
                    subtitle="Cyan line is session VWAP. Replay signals, recorded strategy orders, manual override exits, and manual corrections are overlaid on the same 1-minute session."
                  />
                ) : null}

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6 stagger">
                  <StatCard
                    label="VWAP Samples"
                    value={formatMetric(sessionVwapSeries.length, 0)}
                    detail="Session VWAP overlay points"
                  />
                  <StatCard
                    label="Manual Corrections"
                    value={formatMetric(sessionManualCorrections.length, 0)}
                    detail="Audited platform-state corrections"
                    tone={sessionManualCorrections.length > 0 ? "text-amber-400" : "text-emerald-400"}
                  />
                  <StatCard
                    label="Operator Trades"
                    value={formatMetric(sessionOperatorTrades.length, 0)}
                    detail="Non-strategy operator order flow"
                  />
                  <StatCard
                    label="Mismatch Status"
                    value={sessionPositionMismatch?.has_mismatch ? "OPEN" : "CLEAR"}
                    detail={(sessionPositionMismatch?.reasons || []).join(", ") || "Runtime and DB positions aligned"}
                    tone={sessionPositionMismatch?.has_mismatch ? "text-amber-400" : "text-emerald-400"}
                  />
                  <StatCard
                    label="Replay Source"
                    value={formatSourceLabel(sessionView.candle_source?.selected)}
                    detail={`Historical ${formatMetric(sessionView.candle_source?.historical_count, 0)} · Retained ${formatMetric(sessionView.candle_source?.retained_count, 0)}`}
                    tone={sourceTone(sessionView.candle_source?.selected, sessionView.candle_source?.warning)}
                  />
                  <StatCard
                    label="VWAP Gate"
                    value={formatMetric(
                      (sessionView.replay?.timeline || []).filter((row) => row.vwapGatePassed === true).length,
                      0,
                    )}
                    detail="Replay bars where VWAP gate passed"
                    tone="text-sky-300"
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-3">
                  <SignalTable
                    title="Replay Base Signals"
                    rows={sessionReplayCandidateSignals.map((row) => ({
                      ...row,
                      timestamp: row.barTime,
                      reason: row.gateReason
                        ? `${row.reason || "signal"} · ${row.gateReason}`
                        : row.reason,
                    }))}
                    emptyLabel="No replay candidate signals were generated before VWAP gating."
                  />
                  <SignalTable
                    title="Recorded Strategy Signals"
                    rows={sessionActualSignals}
                    emptyLabel="No recorded strategy signals were found for this session."
                  />
                  <SignalTable
                    title="Manual Override Exits"
                    rows={sessionManualOverrides.map((row) => ({
                      ...row,
                      timestamp: row.timestamp,
                    }))}
                    emptyLabel="No manual override exits were recorded for this session."
                  />
                  <ActivityTable
                    title="Operator Activity"
                    rows={sessionOperatorActivity}
                    emptyLabel="No operator review activity was recorded for this session."
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <OrdersTable
                    title="Recorded Strategy Orders"
                    rows={sessionStrategyOrders}
                    emptyLabel="No recorded strategy orders were found for this session."
                  />
                  <OrdersTable
                    title="Operator Trades"
                    rows={sessionOperatorTrades}
                    emptyLabel="No discretionary operator trades were recorded for this session."
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <ManualCorrectionsTable
                    rows={sessionManualCorrections}
                    emptyLabel="No manual position corrections were recorded for this session."
                  />
                  <MismatchTable rows={mismatches} />
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ValidationPageFallback() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">
            Strategy1 Validation
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Loading validation workspace...
          </p>
        </div>
      </div>
      <div className="card text-sm text-zinc-500">
        Preparing validation data and URL state.
      </div>
    </div>
  );
}

export default function ValidationPage() {
  return (
    <Suspense fallback={<ValidationPageFallback />}>
      <ValidationPageContent />
    </Suspense>
  );
}
