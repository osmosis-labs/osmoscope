import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        osmo: {
          purple: "#5E12A0",
          pink: "#FF66CC",
          // Bright purple used for headline/primary metric figures (matches the
          // circulating-supply accent in the charts).
          accent: "#7C4DFF",
          50: "#F5EAFA",
          100: "#EBD6F5",
          200: "#D7ADEB",
          300: "#C384E1",
          400: "#AF5BD7",
          500: "#9B32CD",
          600: "#7C28A4",
          700: "#5D1E7B",
          800: "#3E1452",
          900: "#1F0A29",
        },
      },
    },
  },
  plugins: [],
};
export default config;
