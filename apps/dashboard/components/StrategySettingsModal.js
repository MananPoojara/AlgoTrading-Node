"use client";

import { useEffect, useState } from "react";

const INITIAL_FORM = {
  symbol: "",
  quantity: "25",
  maxRed: "3",
  capital: "",
  stopLoss: "",
  maxDailyLoss: "",
  timeframe: "1day",
};

function toInputValue(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function toOptionalNumber(value) {
  if (value === "" || value === undefined || value === null) {
    return undefined;
  }

  return Number(value);
}

export default function StrategySettingsModal({
  isOpen,
  instance,
  onClose,
  onSave,
}) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!instance) {
      setForm(INITIAL_FORM);
      return;
    }

    const parameters = instance.parameters || {};
    const riskLimits = instance.risk_limits || {};

    setForm({
      symbol: parameters.symbol || "",
      quantity: toInputValue(parameters.quantity, "25"),
      maxRed: toInputValue(parameters.maxRed, "3"),
      capital: toInputValue(parameters.capital ?? riskLimits.capital, ""),
      stopLoss: toInputValue(parameters.stopLoss, ""),
      maxDailyLoss: toInputValue(
        parameters.maxDailyLoss ?? riskLimits.max_daily_loss,
        "",
      ),
      timeframe: parameters.timeframe || "1day",
    });
  }, [instance]);

  if (!isOpen || !instance) {
    return null;
  }

  const updateField = (field, value) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    try {
      await onSave(instance.id, {
        symbol: form.symbol,
        quantity: toOptionalNumber(form.quantity),
        maxRed: toOptionalNumber(form.maxRed),
        capital: toOptionalNumber(form.capital),
        stopLoss: toOptionalNumber(form.stopLoss),
        maxDailyLoss: toOptionalNumber(form.maxDailyLoss),
        timeframe: form.timeframe,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-10 backdrop-blur-sm">
      <div
        className="w-full max-w-lg animate-in-scale rounded-xl border p-6 shadow-2xl"
        style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">
              {instance.strategy_name}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Edit strategy parameters and risk limits
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Symbol</label>
              <input
                className="input"
                value={form.symbol}
                onChange={(event) => updateField("symbol", event.target.value)}
              />
            </div>
            <div>
              <label className="label">Quantity</label>
              <input
                type="number"
                className="input font-data"
                value={form.quantity}
                onChange={(event) => updateField("quantity", event.target.value)}
              />
            </div>
            <div>
              <label className="label">Max Red</label>
              <input
                type="number"
                className="input font-data"
                value={form.maxRed}
                onChange={(event) => updateField("maxRed", event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="label">Timeframe</label>
              <select
                className="input"
                value={form.timeframe}
                onChange={(event) => updateField("timeframe", event.target.value)}
              >
                <option value="1day">1day</option>
                <option value="1min">1min</option>
                <option value="5min">5min</option>
                <option value="15min">15min</option>
              </select>
              <p className="mt-2 text-[11px] text-amber-300">
                Timeframe changes save now and apply after stop/start.
              </p>
            </div>
            <div>
              <label className="label">Capital</label>
              <input
                type="number"
                className="input font-data"
                value={form.capital}
                onChange={(event) => updateField("capital", event.target.value)}
              />
            </div>
            <div>
              <label className="label">Stop Loss</label>
              <input
                type="number"
                className="input font-data"
                value={form.stopLoss}
                onChange={(event) => updateField("stopLoss", event.target.value)}
              />
            </div>
            <div>
              <label className="label">Max Daily Loss</label>
              <input
                type="number"
                className="input font-data"
                value={form.maxDailyLoss}
                onChange={(event) =>
                  updateField("maxDailyLoss", event.target.value)
                }
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
