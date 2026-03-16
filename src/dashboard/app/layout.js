import "./globals.css";
import Header from "@/components/Header";
import { AuthProvider } from "@/context/AuthContext";

export const metadata = {
  title: "AlgoTrading Dashboard",
  description: "Algorithmic Trading Platform Dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <AuthProvider>
          <div className="min-h-screen bg-gray-900">
            <Header />
            <main className="container mx-auto px-4 py-6">{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
