/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          900: "#111827",
          800: "#1f2937",
          700: "#374151",
          600: "#4b5563",
          400: "#9ca3af",
          300: "#d1d5db",
        },
      },
    },
  },
  plugins: [],
};
