/**
 * Simple logging utility
 * In development: logs to console
 * In production: can be extended to log to external service
 */

const isDevelopment = process.env.NODE_ENV === "development";

export const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: (message: string, ...args: any[]) => {
    if (isDevelopment) {
      // eslint-disable-next-line no-console
      console.log(`[INFO] ${message}`, ...args);
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (message: string, ...args: any[]) => {
    if (isDevelopment) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (message: string, ...args: any[]) => {
    // Always log errors, even in production
    console.error(`[ERROR] ${message}`, ...args);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (message: string, ...args: any[]) => {
    // Only in development
    if (isDevelopment) {
      // eslint-disable-next-line no-console
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
};
