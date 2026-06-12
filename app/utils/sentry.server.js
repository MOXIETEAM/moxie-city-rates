/**
 * Sentry — monitoreo de errores del servidor.
 *
 * Activado solo si SENTRY_DSN está configurado (sin DSN = no-op total, cero
 * overhead en dev). Se inicializa perezosamente en el primer uso desde
 * logger.server.js, así que TODO el código que ya pasa por error()/warn()
 * queda cubierto sin tocar cada call site.
 *
 * También captura unhandledRejection/uncaughtException del proceso — el tipo
 * de error que mata un checkout sin dejar rastro en el quote log.
 */

import * as Sentry from "@sentry/node";

let initialized = false;
let enabled = false;

function ensureInit() {
  if (initialized) return enabled;
  initialized = true;

  const dsn = (process.env.SENTRY_DSN || "").trim();
  if (!dsn) return false;

  try {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "development",
      // Variante de marca (deliveryrules / fletix) para filtrar por deployment.
      initialScope: {
        tags: {
          app_variant: process.env.APP_VARIANT || "fletix",
          app_handle: process.env.APP_HANDLE || "",
        },
      },
      // Solo errores — sin tracing/performance para mantener el costo en cero.
      tracesSampleRate: 0,
    });
    enabled = true;
  } catch (e) {
    console.error("[sentry] init failed:", e?.message || e);
    enabled = false;
  }
  return enabled;
}

/**
 * Captura un error (o mensaje) en Sentry. Nunca lanza.
 * `args` es la lista cruda que recibió logger.error/warn — el primer Error
 * encontrado se captura como excepción (stack completo); si no hay Error,
 * se captura el mensaje concatenado.
 */
export function captureToSentry(level, args) {
  try {
    if (!ensureInit()) return;

    const err = args.find((a) => a instanceof Error);
    const message = args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 2000);

    if (err) {
      Sentry.captureException(err, { level, extra: { message } });
    } else {
      Sentry.captureMessage(message, level);
    }
  } catch {
    // El monitoreo jamás debe romper el flujo que está monitoreando.
  }
}
