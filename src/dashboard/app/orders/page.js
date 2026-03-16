"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";
import { useOrders } from "@/hooks/useWebSocket";
import { format } from "date-fns";
import clsx from "clsx";

function OrderRow({ order }) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!confirm("Cancel this order?")) return;

    setCancelling(true);
    try {
      await api.cancelOrder(order.order_id);
    } catch (err) {
      console.error("Failed to cancel order:", err);
    } finally {
      setCancelling(false);
    }
  };

  const statusClass =
    {
      open: "status-open",
      completed: "status-completed",
      cancelled: "status-cancelled",
      rejected: "status-cancelled",
    }[order.status] || "status-pending";

  const typeLabel = order.transaction_type === "BUY" ? "BUY" : "SELL";

  return (
    <tr className="border-b border-gray-700">
      <td className="py-3 px-4">{order.order_id}</td>
      <td className="py-3 px-4">{order.tradingsymbol}</td>
      <td className="py-3 px-4">
        <span
          className={clsx(
            "px-2 py-1 text-xs font-medium rounded",
            order.transaction_type === "BUY"
              ? "bg-green-900 text-green-300"
              : "bg-red-900 text-red-300",
          )}
        >
          {typeLabel}
        </span>
      </td>
      <td className="py-3 px-4 text-right">₹{order.price?.toLocaleString()}</td>
      <td className="py-3 px-4 text-right">{order.quantity}</td>
      <td className="py-3 px-4 text-right">
        ₹{(order.price * order.quantity)?.toLocaleString()}
      </td>
      <td className="py-3 px-4">
        <span className={clsx("status-badge", statusClass)}>
          {order.status}
        </span>
      </td>
      <td className="py-3 px-4 text-gray-400">
        {order.order_timestamp
          ? format(new Date(order.order_timestamp), "yyyy-MM-dd HH:mm:ss")
          : "-"}
      </td>
      <td className="py-3 px-4">
        {order.status === "open" && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
          >
            {cancelling ? "..." : "Cancel"}
          </button>
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
      } catch (err) {
        console.error("Failed to fetch orders:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchOrders();
  }, [user, router]);

  useEffect(() => {
    if (wsOrders.length > 0) {
      setOrders((prev) => {
        const merged = [...wsOrders];
        prev.forEach((o) => {
          if (!merged.find((m) => m.order_id === o.order_id)) {
            merged.push(o);
          }
        });
        return merged;
      });
    }
  }, [wsOrders]);

  const filteredOrders = orders.filter((order) => {
    if (filter === "all") return true;
    return order.status === filter;
  });

  if (!user) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Orders</h1>

      <div className="flex space-x-2">
        {["all", "open", "completed", "cancelled"].map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={clsx(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              filter === status
                ? "bg-blue-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600",
            )}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden p-0">
        {loading ? (
          <div className="p-6 text-center text-gray-400">Loading orders...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-6 text-center text-gray-400">No orders found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-700/50">
                <tr>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Order ID
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Symbol
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Type
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Price
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Qty
                  </th>
                  <th className="py-3 px-4 text-right text-sm font-medium text-gray-300">
                    Value
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Status
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Time
                  </th>
                  <th className="py-3 px-4 text-left text-sm font-medium text-gray-300">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <OrderRow key={order.order_id} order={order} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
