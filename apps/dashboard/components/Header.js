"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";

const navigation = [
  { name: "Dashboard", href: "/" },
  { name: "Orders", href: "/orders" },
  { name: "Portfolio", href: "/portfolio" },
  { name: "Strategies", href: "/strategies" },
  { name: "Validation", href: "/validation" },
  { name: "Risk", href: "/risk" },
  { name: "Logs", href: "/ops" },
];

export default function Header() {
  const pathname = usePathname();
  const { user, logout, ws } = useAuth();

  if (!user) return null;

  const isActive = (href) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b" style={{ borderColor: "var(--border)", background: "rgba(9,9,11,0.92)", backdropFilter: "blur(12px)" }}>
      <div className="mx-auto flex h-14 max-w-[1360px] items-center justify-between gap-4 px-4 md:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold tracking-widest" style={{ background: "var(--border-strong)", color: "var(--text)" }}>
            AT
          </span>
          <span className="hidden text-sm font-semibold tracking-wide text-zinc-200 sm:block">
            AlgoTrading
          </span>
        </Link>

        {/* Nav */}
        <nav className="flex items-center gap-0.5">
          {navigation.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                isActive(item.href)
                  ? "bg-white/[0.08] text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {item.name}
            </Link>
          ))}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                ws.isConnected
                  ? "bg-emerald-400"
                  : "bg-zinc-600",
              )}
              style={ws.isConnected ? { animation: "pulse-dot 2s ease-in-out infinite" } : undefined}
            />
            <span className="hidden text-xs text-zinc-500 sm:block">
              {ws.isConnected ? "Live" : "Offline"}
            </span>
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          <button
            onClick={logout}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
