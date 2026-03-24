"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { useAlerts } from "@/hooks/useWebSocket";

function formatRelativeTime(value) {
  if (!value) return "—";
  try {
    return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
  } catch {
    return "—";
  }
}

function DecisionBadge({ value }) {
  const tone =
    value === "allow" || value === "approved"
      ? "badge-green"
      : value === "soft_warn" || value === "pending"
        ? "badge-amber"
        : "badge-red";

  return <span className={clsx("badge", tone)}>{value}</span>;
}

export default function RiskPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busyApprovalId, setBusyApprovalId] = useState(null);
  const [data, setData] = useState({
    approvals: [],
    warnings: [],
    decisions: [],
  });
  const alerts = useAlerts(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchData = async () => {
      try {
        const [approvalsRes, warningsRes, decisionsRes] = await Promise.all([
          api.getRiskApprovals({ limit: 25 }),
          api.getRiskWarnings({ limit: 25 }),
          api.getRiskDecisions({ limit: 25 }),
        ]);

        setData({
          approvals: approvalsRes.success ? approvalsRes.data || [] : [],
          warnings: warningsRes.success ? warningsRes.data || [] : [],
          decisions: decisionsRes.success ? decisionsRes.data || [] : [],
        });
      } catch (error) {
        console.error("Failed to fetch risk desk data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 12000);
    return () => clearInterval(interval);
  }, [user, router]);

  const pendingApprovals = useMemo(
    () =>
      data.approvals.filter(
        (approval) => (approval.metadata?.status || "pending") === "pending",
      ),
    [data.approvals],
  );

  const handleApproval = async (approvalId, action) => {
    setBusyApprovalId(approvalId);
    try {
      if (action === "approve") {
        await api.approveRiskApproval(approvalId, { operator_username: "dashboard" });
      } else {
        await api.rejectRiskApproval(approvalId, { operator_username: "dashboard" });
      }

      setData((prev) => ({
        ...prev,
        approvals: prev.approvals.map((approval) =>
          approval.id === approvalId
            ? {
                ...approval,
                metadata: {
                  ...(approval.metadata || {}),
                  status: action === "approve" ? "approved" : "rejected",
                },
              }
            : approval,
        ),
      }));
    } catch (error) {
      console.error(`Failed to ${action} approval`, error);
    } finally {
      setBusyApprovalId(null);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-5 animate-in">
      <h1 className="text-lg font-semibold text-white">Risk Desk</h1>

      {/* Approvals + Alerts */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Approvals */}
        <div className="card">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Pending Approvals</h2>
            <span className="badge badge-amber">{pendingApprovals.length}</span>
          </div>

          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                Loading...
              </div>
            ) : pendingApprovals.length === 0 ? (
              <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                No pending approvals
              </div>
            ) : (
              pendingApprovals.map((approval) => {
                const metadata = approval.metadata || {};
                const signal = metadata.signal || {};
                const warnings = metadata.warnings || [];

                return (
                  <div
                    key={approval.id}
                    className="rounded-lg border p-4"
                    style={{ borderColor: "rgba(251,191,36,0.15)", background: "var(--amber-muted)" }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          {signal.action} {signal.instrument || signal.symbol || "Unknown"}
                        </div>
                        <div className="mt-1 font-data text-[10px] text-zinc-500">
                          {signal.event_id || "—"} · expires {formatRelativeTime(metadata.expires_at)}
                        </div>
                      </div>
                      <DecisionBadge value={metadata.status || "pending"} />
                    </div>

                    {warnings.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {warnings.map((warning, index) => (
                          <div
                            key={`${approval.id}-${warning.reason}-${index}`}
                            className="rounded-md px-3 py-2 text-xs"
                            style={{ background: "rgba(0,0,0,0.2)" }}
                          >
                            <span className="font-medium text-amber-200">{warning.reason}</span>
                            <span className="ml-2 text-zinc-500">
                              {JSON.stringify(warning.details || {})}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => handleApproval(approval.id, "approve")}
                        disabled={busyApprovalId === approval.id}
                        className="btn btn-success text-xs"
                      >
                        {busyApprovalId === approval.id ? "..." : "Approve"}
                      </button>
                      <button
                        onClick={() => handleApproval(approval.id, "reject")}
                        disabled={busyApprovalId === approval.id}
                        className="btn btn-danger text-xs"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Live Alerts + Warnings */}
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Live Alerts</h2>
              <span className="font-data text-xs text-zinc-600">{alerts.length} total</span>
            </div>
            <div className="mt-4 space-y-2">
              {alerts.length === 0 ? (
                <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                  Waiting for alerts
                </div>
              ) : (
                alerts.slice(0, 10).map((alert, index) => (
                  <div
                    key={`${alert.event_id || alert.message}-${index}`}
                    className="rounded-lg px-3 py-2.5"
                    style={{ background: "var(--bg)" }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-zinc-300">{alert.message}</span>
                      <span className="section-label">{alert.level || "INFO"}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-zinc-600">
                      {alert.instrument || alert.symbol || alert.service || "platform"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <h2 className="text-sm font-semibold text-white">Warning History</h2>
            <div className="mt-4 space-y-2">
              {data.warnings.length === 0 ? (
                <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
                  No warnings
                </div>
              ) : (
                data.warnings.map((warning) => (
                  <div
                    key={warning.id}
                    className="rounded-lg px-3 py-2.5"
                    style={{ background: "var(--bg)" }}
                  >
                    <div className="text-sm text-zinc-300">
                      {warning.metadata?.warning_reason || warning.message}
                    </div>
                    <div className="mt-1 font-data text-[10px] text-zinc-600">
                      {formatRelativeTime(warning.timestamp)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Decision Audit */}
      <div className="card">
        <h2 className="text-sm font-semibold text-white">Decision Audit</h2>
        <div className="mt-4 space-y-2">
          {data.decisions.length === 0 ? (
            <div className="rounded-lg py-6 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
              No decisions logged
            </div>
          ) : (
            data.decisions.map((decision) => {
              const metadata = decision.metadata || {};
              const reasons = metadata.reasons || [];

              return (
                <div
                  key={decision.id}
                  className="flex items-center justify-between gap-4 rounded-lg px-3 py-3"
                  style={{ background: "var(--bg)" }}
                >
                  <div className="flex items-center gap-3">
                    <DecisionBadge value={metadata.decision || "unknown"} />
                    <span className="text-sm text-zinc-300">
                      {metadata.action || "—"} {metadata.instrument || metadata.symbol || "—"}
                    </span>
                    <span className="font-data text-[10px] text-zinc-600">
                      {formatRelativeTime(decision.timestamp)}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {reasons[0]?.reason || "—"}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
