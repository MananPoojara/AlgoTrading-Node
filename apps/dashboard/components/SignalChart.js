"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";

const CHART_HEIGHT = 360;

function formatAxisLabel(value, axisMode = "intraday") {
  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      ...(axisMode === "daily"
        ? { day: "2-digit", month: "short" }
        : { hour: "2-digit", minute: "2-digit" }),
    });
  } catch {
    return String(value || "—");
  }
}

function formatDateTime(value, axisMode = "intraday") {
  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      ...(axisMode === "daily"
        ? { dateStyle: "medium" }
        : { dateStyle: "medium", timeStyle: "short" }),
    });
  } catch {
    return String(value || "—");
  }
}

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

function markerAppearance(marker = {}) {
  const kind = String(marker.kind || "signal").toLowerCase();
  const action = String(marker.action || "").toUpperCase();

  if (kind === "manual_override") {
    return {
      color: "#f59e0b",
      shape: "square",
      position: "aboveBar",
      label: "Manual override",
    };
  }

  if (kind === "strategy_order") {
    return {
      color: action === "BUY" ? "#38bdf8" : "#f43f5e",
      shape: action === "BUY" ? "circle" : "square",
      position: action === "BUY" ? "belowBar" : "aboveBar",
      label: `Order ${action || ""}`.trim(),
    };
  }

  if (kind === "manual_correction") {
    return {
      color: "#f97316",
      shape: "diamond",
      position: action === "BUY" ? "belowBar" : "aboveBar",
      label: "Manual correction",
    };
  }

  if (kind === "operator_activity") {
    return {
      color: "#8b5cf6",
      shape: "circle",
      position: "aboveBar",
      label: "Operator activity",
    };
  }

  if (kind === "candidate_signal") {
    return {
      color: action === "BUY" ? "#f59e0b" : "#fb7185",
      shape: action === "BUY" ? "arrowUp" : "arrowDown",
      position: action === "BUY" ? "belowBar" : "aboveBar",
      label: `Candidate ${action || ""}`.trim(),
    };
  }

  return {
    color: action === "BUY" ? "#10b981" : "#f43f5e",
    shape: action === "BUY" ? "arrowUp" : "arrowDown",
    position: action === "BUY" ? "belowBar" : "aboveBar",
    label: `Signal ${action || ""}`.trim(),
  };
}

function toChartTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.floor(timestamp / 1000);
}

function nearestCandleIndex(candles, markerTime) {
  const target = toChartTime(markerTime);
  if (!candles.length || target == null) {
    return -1;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  candles.forEach((candle, index) => {
    const distance = Math.abs(Number(candle.chartTime) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export default function SignalChart({
  candles = [],
  signals = [],
  markers = null,
  lineSeries = [],
  symbol = "—",
  timeframeLabel = "1min",
  axisMode = "intraday",
  selectedDate = null,
  onSelectCandle = null,
  subtitle = null,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const lineSeriesRef = useRef(null);
  const markerPluginRef = useRef(null);
  const candlesRef = useRef([]);
  const [hoveredCandle, setHoveredCandle] = useState(null);
  const [width, setWidth] = useState(920);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const node = containerRef.current;
    const resizeObserver = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect?.width;
      if (nextWidth) {
        setWidth(nextWidth);
      }
    });

    resizeObserver.observe(node);
    setWidth(node.getBoundingClientRect().width || 920);

    return () => resizeObserver.disconnect();
  }, []);

  const normalizedCandles = useMemo(
    () =>
      [...candles]
        .map((candle) => {
          const time = candle.time || candle.barTime;
          const chartTime = toChartTime(time);
          return {
            ...candle,
            time,
            chartTime,
            date: candle.date || String(time || "").slice(0, 10),
            open: Number(candle.open || 0),
            high: Number(candle.high || 0),
            low: Number(candle.low || 0),
            close: Number(candle.close || 0),
          };
        })
        .filter((candle) => candle.chartTime != null)
        .sort((left, right) => left.chartTime - right.chartTime),
    [candles],
  );

  const normalizedMarkers = useMemo(() => {
    const source = Array.isArray(markers)
      ? markers
      : (signals || []).map((signal) => ({
          timestamp: signal.timestamp || signal.barTime,
          action: signal.action,
          price: signal.price,
          kind: "signal",
          label: signal.reason || null,
        }));

    return source
      .map((marker) => {
        const candleIndex = nearestCandleIndex(
          normalizedCandles,
          marker.timestamp || marker.barTime,
        );
        if (candleIndex < 0) {
          return null;
        }

        const candle = normalizedCandles[candleIndex];
        return {
          ...marker,
          candleIndex,
          candle,
          timestamp: marker.timestamp || marker.barTime || candle.time,
          price: Number.isFinite(Number(marker.price))
            ? Number(marker.price)
            : Number(candle.close || 0),
        };
      })
      .filter(Boolean);
  }, [markers, normalizedCandles, signals]);

  useEffect(() => {
    candlesRef.current = normalizedCandles;
  }, [normalizedCandles]);

  const markerCounts = useMemo(() => {
    const counts = new Map();
    normalizedMarkers.forEach((marker) => {
      const appearance = markerAppearance(marker);
      const key = `${appearance.label}:${appearance.color}`;
      counts.set(key, {
        label: appearance.label,
        color: appearance.color,
        count: (counts.get(key)?.count || 0) + 1,
      });
    });
    return Array.from(counts.values());
  }, [normalizedMarkers]);

  useEffect(() => {
    if (!containerRef.current || chartRef.current || width <= 0) {
      return undefined;
    }

    const chart = createChart(containerRef.current, {
      width,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#71717a",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      crosshair: {
        mode: CrosshairMode.MagnetOHLC,
        vertLine: { color: "rgba(255,255,255,0.18)", width: 1, style: 2 },
        horzLine: { color: "rgba(255,255,255,0.12)", width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: axisMode !== "daily",
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
      localization: {
        locale: "en-IN",
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(52, 211, 153, 0.85)",
      downColor: "rgba(251, 113, 133, 0.9)",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#fb7185",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const overlayLineSeries = chart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    lineSeriesRef.current = overlayLineSeries;
    markerPluginRef.current = createSeriesMarkers(series, []);

    const handleCrosshairMove = (param) => {
      if (!param?.time) {
        setHoveredCandle(null);
        return;
      }

      const match = candlesRef.current.find(
        (candle) => Number(candle.chartTime) === Number(param.time),
      );
      setHoveredCandle(match || null);
    };

    const handleClick = (param) => {
      if (!param?.time || typeof onSelectCandle !== "function") {
        return;
      }

      const match = candlesRef.current.find(
        (candle) => Number(candle.chartTime) === Number(param.time),
      );
      if (match) {
        onSelectCandle(match);
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.subscribeClick(handleClick);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeClick(handleClick);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineSeriesRef.current = null;
      markerPluginRef.current = null;
    };
  }, [axisMode, onSelectCandle, width]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    chartRef.current.applyOptions({
      width,
      height: CHART_HEIGHT,
      timeScale: {
        timeVisible: axisMode !== "daily",
        secondsVisible: false,
      },
    });
  }, [axisMode, width]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) {
      return;
    }

    const data = normalizedCandles.map((candle) => ({
      time: candle.chartTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    seriesRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [normalizedCandles]);

  useEffect(() => {
    if (!lineSeriesRef.current) {
      return;
    }

    const data = (lineSeries || [])
      .map((point) => ({
        time: toChartTime(point.time || point.barTime || point.timestamp),
        value: Number(point.value ?? point.vwap ?? point.close ?? 0),
      }))
      .filter((point) => point.time != null && Number.isFinite(point.value));

    lineSeriesRef.current.setData(data);
  }, [lineSeries]);

  useEffect(() => {
    if (!markerPluginRef.current) {
      return;
    }

    const data = normalizedMarkers.map((marker, index) => {
      const appearance = markerAppearance(marker);
      const base = {
        time: marker.candle.chartTime,
        color: appearance.color,
        shape: appearance.shape,
        text: marker.label || appearance.label,
        id: `${marker.kind || "signal"}-${marker.timestamp || marker.candle.time}-${index}`,
      };

      if (Number.isFinite(Number(marker.price))) {
        return {
          ...base,
          position: "atPriceMiddle",
          price: Number(marker.price),
        };
      }

      return {
        ...base,
        position: appearance.position,
      };
    });

    if (selectedDate) {
      const selectedCandle = normalizedCandles.find(
        (candle) => candle.date === selectedDate,
      );
      if (selectedCandle) {
        data.push({
          time: selectedCandle.chartTime,
          position: "aboveBar",
          color: "#38bdf8",
          shape: "circle",
          text: "Selected",
          id: `selected-${selectedDate}`,
        });
      }
    }

    markerPluginRef.current.setMarkers(data);
  }, [normalizedCandles, normalizedMarkers, selectedDate]);

  return (
    <div className="card">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">{symbol}</h2>
            <span className="badge badge-neutral">{timeframeLabel}</span>
          </div>
          {subtitle ? (
            <p className="mt-1 text-xs text-zinc-600">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{normalizedCandles.length} candles</span>
          {markerCounts.map((entry) => (
            <span
              key={`${entry.label}-${entry.color}`}
              className="inline-flex items-center gap-1"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.label} {entry.count}
            </span>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="mt-4 h-[360px] w-full overflow-hidden rounded-xl">
        {normalizedCandles.length === 0 ? (
          <div
            className="flex h-[360px] items-center justify-center rounded-xl border border-dashed text-sm text-zinc-500"
            style={{ borderColor: "var(--border)" }}
          >
            No candle data available.
          </div>
        ) : null}
      </div>

      {hoveredCandle ? (
        <div
          className="mt-3 rounded-xl border px-4 py-3 text-xs text-zinc-400"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-data text-zinc-300">
              {formatDateTime(hoveredCandle.time, axisMode)}
            </span>
            <span>O {formatCurrency(hoveredCandle.open)}</span>
            <span>H {formatCurrency(hoveredCandle.high)}</span>
            <span>L {formatCurrency(hoveredCandle.low)}</span>
            <span>C {formatCurrency(hoveredCandle.close)}</span>
            <span className="text-zinc-500">
              {formatAxisLabel(hoveredCandle.time, axisMode)}
            </span>
          </div>
        </div>
      ) : null}

      {selectedDate ? (
        <div className="mt-3 text-xs text-zinc-500">
          Selected day: <span className="font-data text-zinc-300">{selectedDate}</span>
        </div>
      ) : null}
    </div>
  );
}
