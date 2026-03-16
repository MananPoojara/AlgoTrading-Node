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
];

export default function Header() {
  const pathname = usePathname();
  const { user, logout, ws } = useAuth();

  if (!user) return null;

  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-8">
            <Link href="/" className="text-xl font-bold text-white">
              AlgoTrading
            </Link>
            <nav className="flex space-x-4">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
                  className={clsx(
                    "px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    pathname === item.href
                      ? "bg-gray-700 text-white"
                      : "text-gray-300 hover:bg-gray-700 hover:text-white",
                  )}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <span
                className={clsx(
                  "w-2 h-2 rounded-full",
                  ws.isConnected ? "bg-green-500" : "bg-red-500",
                )}
              />
              <span className="text-sm text-gray-400">
                {ws.isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>

            <button
              onClick={logout}
              className="px-3 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
