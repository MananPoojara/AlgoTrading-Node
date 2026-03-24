"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { useOrders } from "@/hooks/useWebSocket";

const OPEN_STATUSES = [
  "created",
  "validated",
  "queued",
  "sent_to_broker",
  "acknowledged",
  "partially_filled",
];

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

function getStatusBadge(status) {
  const map = {
    created: "badge-amber",
    validated: "badge-amber",
    queued: "badge-amber",
    sent_to_broker: "badge-amber",
    acknowledged: "badge-neutral",
    partially_filled: "badge-neutral",
    filled: "badge-green",
    cancelled: "badge-red",
    rejected: "badge-red",
    failed: "badge-red",
  };
  return map[status] || "badge-neutral";
}

function mergeOrders(baseOrders, incomingOrders) {
  const merged = new Map();

  [...baseOrders, ...incomingOrders].forEach((order) => {
    if (!order?.id) {
      return;
    }

    const existing = merged.get(order.id);
    if (!existing) {
      merged.set(order.id, order);
      return;
    }

    const existingTime = new Date(existing.updated_at || existing.created_at || 0).getTime();
    const nextTime = new Date(order.updated_at || order.created_at || 0).getTime();
    merged.set(order.id, nextTime >= existingTime ? order : existing);
  });

  return Array.from(merged.values()).sort(
    (left, right) =>
      new Date(right.created_at || 0).getTime() -
      new Date(left.created_at || 0).getTime(),
  );
}

function OrderRow({ order, onCancel }) {
  const [cancelling, setCancelling] = useState(false);
  const isOpenState = OPEN_STATUSES.includes(order.status);

  const handleCancel = async () => {
    if (!confirm("Cancel this order?")) return;

    setCancelling(true);
    try {
      await onCancel(order.id);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <tr className="group transition-colors hover:bg-white/[0.02]">
      <td className="table-cell">
        <div className="font-data text-sm text-white">{order.id}</div>
        <div className="font-data text-[10px] text-zinc-600">{order.event_id || "—"}</div>
      </td>
      <td className="table-cell">
        <div className="text-sm text-white">
          {order.instrument || order.symbol || "—"}
        </div>
        <div className="text-[10px] text-zinc-600">
          {order.execution_mode || "paper"}
        </div>
      </td>
      <td className="table-cell">
        <span className={clsx("badge", order.side === "BUY" ? "badge-green" : "badge-red")}>
          {order.side || "—"}
        </span>
      </td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">{formatCurrency(order.price)}</td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">{order.quantity}</td>
      <td className="table-cell text-right font-data text-sm text-zinc-300">
        {formatCurrency(Number(order.price || 0) * Number(order.quantity || 0))}
      </td>
      <td className="table-cell">
        <span className={clsx("badge", getStatusBadge(order.status))}>
          {order.status}
        </span>
      </td>
      <td className="table-cell font-data text-xs text-zinc-500">
        {order.created_at
          ? format(new Date(order.created_at), "yyyy-MM-dd HH:mm:ss")
          : "—"}
      </td>
      <td className="table-cell">
        {isOpenState ? (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="text-xs font-medium text-rose-400 transition-colors hover:text-rose-300 disabled:opacity-50"
          >
            {cancelling ? "..." : "Cancel"}
          </button>
        ) : (
          <span className="text-[10px] text-zinc-700">—</span>
        )}
      </td>
    </tr>
  );
}

export default function OrdersPage() {
  const { user, ws } = useAuth();
  const router = useRouter();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const wsOrders = useOrders(ws);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    const fetchOrders = async () => {
      try {
        const response = await api.getOrders({ limit: 100 });
        if (response.success) {
          setOrders(response.data || []);
        }
      } catch (error) {
        console.error("Failed to fetch orders:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchOrders();
  }, [user, router]);

  useEffect(() => {
    if (wsOrders.length > 0) {
      setOrders((prev) => mergeOrders(prev, wsOrders));
    }
  }, [wsOrders]);

  const filteredOrders = useMemo(
    () =>
      orders.filter((order) => {
        if (filter === "all") return true;
        if (filter === "open") return OPEN_STATUSES.includes(order.status);
        if (filter === "completed") return order.status === "filled";
        if (filter === "cancelled") {
          return ["cancelled", "rejected", "failed"].includes(order.status);
        }
        return order.status === filter;
      }),
    [orders, filter],
  );

  const handleCancelOrder = async (orderId) => {
    try {
      const response = await api.cancelOrder(orderId);
      if (response.success && response.data) {
        setOrders((prev) => mergeOrders(prev, [response.data]));
      }
    } catch (error) {
      console.error("Failed to cancel order:", error);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-5 animate-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-white">Orders</h1>
        <div className="flex gap-1">
          {["all", "open", "completed", "cancelled"].map((status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={clsx(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                filter === status
                  ? "bg-white/[0.08] text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="card-flush">
        {loading ? (
          <div className="p-8 text-center text-sm text-zinc-600">Loading orders...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">No orders found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-header">Order</th>
                  <th className="table-header">Instrument</th>
                  <th className="table-header">Side</th>
                  <th className="table-header text-right">Price</th>
                  <th className="table-header text-right">Qty</th>
                  <th className="table-header text-right">Value</th>
                  <th className="table-header">Status</th>
                  <th className="table-header">Created</th>
                  <th className="table-header">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <OrderRow
                    key={order.id}
                    order={order}
                    onCancel={handleCancelOrder}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
