const isDev = process.env.NODE_ENV !== "production";

export function debug(...args) {
  if (isDev) console.log(...args);
}

export function info(...args) {
  if (isDev) console.log(...args);
}

export function warn(...args) {
  console.warn(...args);
}

export function error(...args) {
  console.error(...args);
}
