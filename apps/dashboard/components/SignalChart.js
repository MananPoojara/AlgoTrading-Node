"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatAxisTime(value) {
  try {
    return new Date(value).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  const candle = payload[0]?.payload;

  return (
    <div className="rounded-lg border px-3 py-2 shadow-xl" style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}>
      <div className="font-data text-[10px] text-zinc-500">
        {formatAxisTime(label)}
      </div>
      <div className="mt-1 font-data text-xs text-zinc-300">
        O {formatCurrency(candle.open)} · H {formatCurrency(candle.high)}
      </div>
      <div className="font-data text-xs text-zinc-300">
        L {formatCurrency(candle.low)} · C {formatCurrency(candle.close)}
      </div>
    </div>
  );
}

export default function SignalChart({ candles = [], signals = [], symbol = "—" }) {
  const chartData = candles.map((candle) => {
    const matchingSignal = signals.find((signal) => {
      const signalTime = new Date(signal.timestamp).getTime();
      const candleTime = new Date(candle.time).getTime();
      return Math.abs(signalTime - candleTime) < 60_000;
    });

    return {
      ...candle,
      close: Number(candle.close || 0),
      open: Number(candle.open || 0),
      high: Number(candle.high || 0),
      low: Number(candle.low || 0),
      buyMarker:
        matchingSignal?.action === "BUY" ? Number(candle.close || 0) : null,
      sellMarker:
        matchingSignal?.action === "SELL" ? Number(candle.close || 0) : null,
    };
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">{symbol}</h2>
          <span className="badge badge-neutral">1min</span>
        </div>
        <span className="font-data text-xs text-zinc-600">
          {signals.length} signals · {chartData.length} candles
        </span>
      </div>

      <div className="mt-4 h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="time"
              tickFormatter={formatAxisTime}
              tick={{ fill: "#52525b", fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={["dataMin - 5", "dataMax + 5"]}
              tick={{ fill: "#52525b", fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => Number(value).toFixed(0)}
            />
            <Tooltip content={<ChartTooltip />} />
            <Line
              type="monotone"
              dataKey="close"
              stroke="#a1a1aa"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: "#fafafa", stroke: "#fafafa" }}
            />
            <Scatter
              data={chartData.filter((entry) => entry.buyMarker !== null)}
              dataKey="buyMarker"
              fill="#34d399"
              shape="triangle"
            />
            <Scatter
              data={chartData.filter((entry) => entry.sellMarker !== null)}
              dataKey="sellMarker"
              fill="#fb7185"
              shape="diamond"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
