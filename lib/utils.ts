import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number, decimals: number = 2): string {
  if (num >= 1_000_000_000) {
    const value = num / 1_000_000_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "B";
  }
  if (num >= 1_000_000) {
    const value = num / 1_000_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "M";
  }
  if (num >= 1_000) {
    const value = num / 1_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "K";
  }
  return num.toFixed(decimals);
}

export function formatCurrency(num: number, decimals: number = 2): string {
  return "$" + formatNumber(num, decimals);
}

export function formatPercentage(num: number, decimals: number = 2): string {
  return num.toFixed(decimals) + "%";
}

export function formatNumberWithCommas(
  num: number,
  decimals: number = 0
): string {
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
