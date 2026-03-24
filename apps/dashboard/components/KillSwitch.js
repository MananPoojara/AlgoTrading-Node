"use client";

import { useState } from "react";
import api from "@/lib/api";

export default function KillSwitch() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleKill = async () => {
    if (
      !confirm(
        "Are you sure you want to kill all active trades? This will close all open positions.",
      )
    ) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await api.post("/api/orders/kill-switch", {});
      if (response.success) {
        setSuccess("All trades killed");
      } else {
        setError(response.error || "Failed to execute kill switch");
      }
    } catch (err) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-rose-400">{error}</span>}
      {success && <span className="text-xs text-emerald-400">{success}</span>}
      <button
        onClick={handleKill}
        disabled={loading}
        className="btn btn-danger text-xs font-semibold uppercase tracking-wide disabled:opacity-50"
      >
        {loading ? "Executing..." : "Kill All"}
      </button>
    </div>
  );
}
