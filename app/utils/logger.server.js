import { captureToSentry } from "./sentry.server";

const isDev = process.env.NODE_ENV !== "production";

export function debug(...args) {
  if (isDev) console.log(...args);
}

export function info(...args) {
  if (isDev) console.log(...args);
}

export function warn(...args) {
  console.warn(...args);
  // Desde warn solo van a Sentry los que traen un Error real adjunto —
  // mensajes de texto plano en warn son ruido operativo esperado.
  if (args.some((a) => a instanceof Error)) {
    captureToSentry("warning", args);
  }
}

export function error(...args) {
  console.error(...args);
  captureToSentry("error", args);
}
