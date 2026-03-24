"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";

function StatusBadge({ status }) {
  const tone =
    status === "running"
      ? "badge-green"
      : status === "paused"
        ? "badge-amber"
        : "badge-neutral";

  return <span className={clsx("badge", tone)}>{status}</span>;
}

export default function StrategiesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [instances, setInstances] = useState([]);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      try {
        const response = await api.getStrategyInstances({ limit: 50 });
        if (response.success) {
          setInstances(response.data || []);
        }
      } catch (error) {
        console.error("Failed to fetch strategy instances:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [user, router]);

  const handleAction = async (instanceId, currentStatus) => {
    setBusyId(instanceId);
    try {
      if (currentStatus === "running") {
        await api.stopStrategy(instanceId);
        setInstances((prev) =>
          prev.map((instance) =>
            instance.id === instanceId
              ? { ...instance, status: "stopped" }
              : instance,
          ),
        );
      } else {
        await api.startStrategy(instanceId);
        setInstances((prev) =>
          prev.map((instance) =>
            instance.id === instanceId
              ? { ...instance, status: "running" }
              : instance,
          ),
        );
      }
    } catch (error) {
      console.error("Failed to update strategy state:", error);
    } finally {
      setBusyId(null);
    }
  };

  if (!user) return null;

  const running = instances.filter((i) => i.status === "running").length;
  const inactive = instances.filter((i) => ["paused", "stopped"].includes(i.status)).length;

  return (
    <div className="space-y-5 animate-in">
      <h1 className="text-lg font-semibold text-white">Strategies</h1>

      {/* Metrics */}
      <div className="grid gap-3 sm:grid-cols-3 stagger">
        <div className="card animate-in">
          <div className="section-label">Instances</div>
          <div className="mt-2 metric-value text-white">{instances.length}</div>
          <div className="mt-1 text-xs text-zinc-600">configured</div>
        </div>
        <div className="card animate-in">
          <div className="section-label">Running</div>
          <div className="mt-2 metric-value text-emerald-400">{running}</div>
          <div className="mt-1 text-xs text-zinc-600">active</div>
        </div>
        <div className="card animate-in">
          <div className="section-label">Inactive</div>
          <div className="mt-2 metric-value text-zinc-400">{inactive}</div>
          <div className="mt-1 text-xs text-zinc-600">paused / stopped</div>
        </div>
      </div>

      {/* Table */}
      <div className="card-flush">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-sm font-semibold text-white">Instance Table</h2>
          <span className="text-xs text-zinc-600">{instances.length} instances</span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-zinc-600">Loading...</div>
        ) : instances.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">No strategy instances</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-header">Strategy</th>
                  <th className="table-header">Client</th>
                  <th className="table-header">Symbol</th>
                  <th className="table-header">Status</th>
                  <th className="table-header">Worker</th>
                  <th className="table-header text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance) => (
                  <tr key={instance.id} className="group transition-colors hover:bg-white/[0.02]">
                    <td className="table-cell">
                      <div className="text-sm font-medium text-white">
                        {instance.strategy_name}
                      </div>
                      <div className="mt-0.5 font-data text-[10px] text-zinc-600">
                        #{instance.id} · {instance.strategy_type}
                      </div>
                    </td>
                    <td className="table-cell text-sm text-zinc-400">
                      {instance.client_name || instance.client_id}
                    </td>
                    <td className="table-cell font-data text-sm text-zinc-400">
                      {instance.parameters?.symbol || "—"}
                    </td>
                    <td className="table-cell">
                      <StatusBadge status={instance.status} />
                    </td>
                    <td className="table-cell font-data text-xs text-zinc-600">
                      {instance.worker_id || "unassigned"}
                    </td>
                    <td className="table-cell text-right">
                      <button
                        onClick={() => handleAction(instance.id, instance.status)}
                        disabled={busyId === instance.id}
                        className={clsx(
                          "btn text-xs",
                          instance.status === "running" ? "btn-danger" : "btn-success",
                        )}
                      >
                        {busyId === instance.id
                          ? "..."
                          : instance.status === "running"
                            ? "Stop"
                            : "Start"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
