"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { useAuth } from "@/context/AuthContext";
import api from "@/lib/api";

const CORE_SERVICE_KEYS = [
  "market-data-service",
  "strategy-engine",
  "order-manager",
  "api-server",
  "market-scheduler",
];

const LEVEL_OPTIONS = ["warn", "error", "info", "debug"];

function formatRelativeTime(value) {
  if (!value) return "—";
  try {
    return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
  } catch {
    return "—";
  }
}

function formatAbsoluteTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return value;
  }
}

function ServiceCard({ service, selected, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(service.service)}
      className={clsx(
        "rounded-lg border p-3 text-left transition-all",
        selected
          ? "border-zinc-700 bg-zinc-900"
          : "hover:bg-white/[0.02]",
      )}
      style={{ borderColor: selected ? undefined : "var(--border)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-300">{service.label}</span>
        <span
          className={clsx(
            "h-1.5 w-1.5 rounded-full",
            service.healthy ? "bg-emerald-400" : service.running ? "bg-amber-400" : "bg-zinc-700",
          )}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-700">Last log</div>
          <div className="mt-0.5 font-data text-[10px] text-zinc-500">{formatRelativeTime(service.last_seen_log_at)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-700">Last error</div>
          <div className="mt-0.5 font-data text-[10px] text-zinc-500">{formatRelativeTime(service.last_error_at)}</div>
        </div>
      </div>
    </button>
  );
}

function LogRow({ record }) {
  const levelColor = {
    error: "text-rose-400",
    warn: "text-amber-400",
    info: "text-zinc-400",
    debug: "text-zinc-600",
  }[record.level] || "text-zinc-500";

  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--bg)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-neutral font-data text-[10px]">{record.service}</span>
        <span className={clsx("font-data text-[10px] font-semibold uppercase", levelColor)}>
          {record.level}
        </span>
        <span className="ml-auto font-data text-[10px] text-zinc-700">
          {formatAbsoluteTime(record.timestamp)}
        </span>
      </div>
      <div className="mt-2 font-data text-xs leading-5 text-zinc-300">{record.message}</div>
      {record.raw && (
        <div className="mt-1 truncate font-data text-[10px] text-zinc-700">{record.raw}</div>
      )}
    </div>
  );
}

export default function OpsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selectedServices, setSelectedServices] = useState(CORE_SERVICE_KEYS);
  const [selectedLevels, setSelectedLevels] = useState(["warn", "error"]);
  const [streamPaused, setStreamPaused] = useState(false);
  const [streamState, setStreamState] = useState("connecting");
  const [socketAvailable, setSocketAvailable] = useState(true);

  useEffect(() => {
    if (!user) {
      router.push("/login");
    }
  }, [user, router]);

  useEffect(() => {
    if (!user) return;

    let isCancelled = false;

    const fetchSnapshot = async () => {
      try {
        const [servicesRes, logsRes] = await Promise.all([
          api.getOpsServices(),
          api.getOpsLogs({
            services: selectedServices.join(","),
            levels: selectedLevels.join(","),
            limit: 180,
          }),
        ]);

        if (isCancelled) return;

        if (servicesRes.success) {
          setServices(servicesRes.data || []);
          setSocketAvailable(servicesRes.meta?.docker_socket_available !== false);
        }

        if (logsRes.success) {
          setLogs(logsRes.data || []);
        }
      } catch (error) {
        console.error("Failed to fetch ops snapshot:", error);
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 15000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [user, selectedServices, selectedLevels]);

  useEffect(() => {
    if (!user || streamPaused) {
      setStreamState(streamPaused ? "paused" : "idle");
      return undefined;
    }

    const controller = new AbortController();
    let isClosed = false;

    const runStream = async () => {
      try {
        setStreamState("connecting");
        const response = await fetch(
          api.getOpsLogStreamUrl({
            services: selectedServices.join(","),
            levels: selectedLevels.join(","),
            limit: 180,
            since: Math.max(Math.floor(Date.now() / 1000) - 30, 0),
          }),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${api.getToken()}`,
            },
            signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error("Failed to connect log stream");
        }

        setStreamState("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!isClosed) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const eventChunk of events) {
            const lines = eventChunk.split("\n");
            const eventName =
              lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ||
              "message";
            const dataLine = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");

            if (!dataLine) {
              continue;
            }

            const payload = JSON.parse(dataLine);

            if (eventName === "connected") {
              setSocketAvailable(payload.docker_socket_available !== false);
              continue;
            }

            if (eventName === "error") {
              setStreamState("degraded");
              continue;
            }

            if (eventName === "log") {
              setLogs((prev) => {
                const next = [payload, ...prev.filter((record) => record.id !== payload.id)];
                return next.slice(0, 220);
              });
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Ops stream failed:", error);
          setStreamState("degraded");
        }
      }
    };

    runStream();

    return () => {
      isClosed = true;
      controller.abort();
    };
  }, [user, streamPaused, selectedServices, selectedLevels]);

  const visibleLogs = useMemo(
    () =>
      logs.filter(
        (record) =>
          selectedServices.includes(record.service) &&
          selectedLevels.includes(record.level),
      ),
    [logs, selectedServices, selectedLevels],
  );

  const toggleService = (serviceKey) => {
    setSelectedServices((prev) => {
      if (prev.includes(serviceKey)) {
        if (prev.length === 1) {
          return prev;
        }
        return prev.filter((service) => service !== serviceKey);
      }

      return [...prev, serviceKey];
    });
  };

  const toggleLevel = (level) => {
    setSelectedLevels((prev) => {
      if (prev.includes(level)) {
        if (prev.length === 1) {
          return prev;
        }
        return prev.filter((entry) => entry !== level);
      }

      return [...prev, level];
    });
  };

  if (!user) return null;

  return (
    <div className="space-y-5 animate-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-white">Logs</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={clsx(
              "h-1.5 w-1.5 rounded-full",
              streamState === "live" ? "bg-emerald-400" : streamState === "degraded" ? "bg-amber-400" : "bg-zinc-700",
            )} />
            <span className="font-data text-xs text-zinc-500">{streamState}</span>
          </div>
          <button
            type="button"
            onClick={() => setStreamPaused((prev) => !prev)}
            className="btn btn-ghost text-xs"
          >
            {streamPaused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={() => setLogs([])}
            className="btn btn-ghost text-xs"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Service cards */}
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {(services.length > 0 ? services : CORE_SERVICE_KEYS.map((service) => ({
          service,
          label: service,
          running: false,
          healthy: false,
        }))).map((service) => (
          <ServiceCard
            key={service.service}
            service={service}
            selected={selectedServices.includes(service.service)}
            onToggle={toggleService}
          />
        ))}
      </div>

      {/* Level filters */}
      <div className="flex items-center gap-2">
        <span className="section-label mr-2">Level</span>
        {LEVEL_OPTIONS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => toggleLevel(level)}
            className={clsx(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              selectedLevels.includes(level)
                ? "bg-white/[0.08] text-white"
                : "text-zinc-600 hover:text-zinc-400",
            )}
          >
            {level}
          </button>
        ))}
      </div>

      {/* Log stream */}
      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Output</h2>
          <span className="font-data text-xs text-zinc-600">
            {loading ? "Loading..." : `${visibleLogs.length} lines`}
          </span>
        </div>

        <div className="mt-4 space-y-1.5">
          {visibleLogs.length === 0 ? (
            <div className="rounded-lg py-8 text-center text-sm text-zinc-600" style={{ background: "var(--bg)" }}>
              No logs match current filters
            </div>
          ) : (
            visibleLogs.map((record) => <LogRow key={record.id} record={record} />)
          )}
        </div>
      </div>
    </div>
  );
}
