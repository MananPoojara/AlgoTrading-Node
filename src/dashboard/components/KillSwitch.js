"use client";

import { useState } from "react";
import api from "@/lib/api";
import clsx from "clsx";

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
        setSuccess("All trades have been killed successfully");
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
    <div className="flex items-center space-x-4">
      {error && <span className="text-red-400 text-sm">{error}</span>}
      {success && <span className="text-green-400 text-sm">{success}</span>}
      <button
        onClick={handleKill}
        disabled={loading}
        className={clsx(
          "btn font-bold transition-all",
          loading
            ? "bg-gray-600 cursor-not-allowed"
            : "bg-red-600 hover:bg-red-700 animate-pulse",
          "text-white",
        )}
      >
        {loading ? "Executing..." : "KILL ALL TRADES"}
      </button>
    </div>
  );
}
