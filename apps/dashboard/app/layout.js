import "./globals.css";
import Header from "@/components/Header";
import { AuthProvider } from "@/context/AuthContext";

export const metadata = {
  title: "AlgoTrading",
  description: "Algorithmic Trading Platform",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <div className="min-h-screen">
            <Header />
            <main className="mx-auto max-w-[1360px] px-4 py-6 md:px-6 lg:px-8">
              {children}
            </main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
