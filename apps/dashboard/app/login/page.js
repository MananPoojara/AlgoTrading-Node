"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

export default function LoginPage() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthUrl, setOauthUrl] = useState("");
  const { user, login } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.push("/");
    }
  }, [user, router]);

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_SMARTAPI_CLIENT_ID;
    const redirectUri = encodeURIComponent(
      process.env.NEXT_PUBLIC_OAUTH_CALLBACK_URL ||
        "http://localhost:3000/api/auth/callback",
    );

    if (clientId) {
      setOauthUrl(
        `https://angelone.io/smart-api/?client_code=${clientId}&response_type=code&redirect_uri=${redirectUri}`,
      );
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await login({ email: identifier, username: identifier, password });
      if (result.success) {
        router.push("/");
      } else {
        setError(result.error || "Login failed");
      }
    } catch (err) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = () => {
    window.location.href = oauthUrl;
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm animate-in">
        {/* Logo */}
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold tracking-widest" style={{ background: "var(--border-strong)", color: "var(--text)" }}>
            AT
          </div>
          <h1 className="text-xl font-semibold text-white">AlgoTrading</h1>
          <p className="mt-1 text-sm text-zinc-500">Sign in to continue</p>
        </div>

        <div className="card">
          {oauthUrl && (
            <>
              <button
                onClick={handleOAuthLogin}
                className="btn btn-ghost w-full gap-2"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                </svg>
                Continue with Angel One
              </button>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-zinc-800" />
                </div>
                <div className="relative flex justify-center">
                  <span className="px-3 text-xs text-zinc-600" style={{ background: "var(--bg-card)" }}>
                    or
                  </span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Username or Email</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="input"
                placeholder="admin"
                required
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder="Enter password"
                required
              />
            </div>

            {error && (
              <div className="rounded-lg px-3 py-2 text-sm" style={{ color: "var(--red)", background: "var(--red-muted)" }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="mt-5 text-center text-xs text-zinc-600">
            Demo: admin / admin123
          </p>
        </div>
      </div>
    </div>
  );
}
