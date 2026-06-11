/**
 * Quote log — persistencia de cada request de tarifas (checkout o simulador).
 *
 * Diseño: el carrier service NUNCA debe pagar latencia ni fallar por culpa
 * del log. `saveQuote` es fire-and-forget (el caller no hace await) y todo
 * error se traga con un warn. La limpieza de retención corre muestreada
 * (1 de cada CLEANUP_EVERY escrituras por proceso) para no agregar un
 * deleteMany a cada checkout.
 */

import prisma from "../db.server";
import { warn } from "./logger.server";

export const QUOTE_RETENTION_DAYS = 30;
const CLEANUP_EVERY = 50;
// Caps por registro: con cientos de reglas, decisions/steps crecerían sin
// límite y engordan la DB en cada checkout. 200 decisiones cubren cualquier
// tienda razonable; el resto se trunca con un marcador.
const MAX_DECISIONS = 200;
const MAX_STEPS = 50;
let writesSinceCleanup = 0;

/**
 * Crea el colector de trace que viaja por el pipeline de cálculo.
 * - `steps`: decisiones globales (resolución de ciudad, zona, selección final).
 * - `rules`: una entrada por regla evaluada con matched + razón de descarte.
 */
export function createQuoteTrace() {
  return { steps: [], rules: [] };
}

/** Snapshot reducido de items del carrito — solo lo útil para diagnóstico. */
export function summarizeItems(items) {
  return (items || []).slice(0, 50).map((i) => ({
    name: i.name || i.title || "",
    quantity: i.quantity || 1,
    grams: i.grams || 0,
    price: i.price || 0,
    serviceCode: i.properties?.["_mox_service_code"] || null,
  }));
}

/**
 * Persiste un quote. Llamar SIN await desde el carrier service:
 *   void saveQuote({...})
 * Nunca lanza.
 */
export async function saveQuote({
  shop,
  source = "checkout",
  country = "",
  province = "",
  city = "",
  resolvedCity = "",
  resolveMethod = "",
  departmentSlug = "",
  items = [],
  cartWeightKg = 0,
  cartTotal = 0,
  currency = "",
  trace,
  ratesReturned = [],
}) {
  try {
    let decisions = trace?.rules || [];
    if (decisions.length > MAX_DECISIONS) {
      const dropped = decisions.length - MAX_DECISIONS;
      decisions = decisions.slice(0, MAX_DECISIONS);
      decisions.push({ rateId: "_truncated", name: `… +${dropped}`, serviceCode: "", zone: "", matched: false, reason: "truncated" });
    }
    const steps = (trace?.steps || []).slice(0, MAX_STEPS);

    await prisma.rateQuote.create({
      data: {
        shop,
        source,
        country,
        province,
        city,
        resolvedCity,
        resolveMethod,
        departmentSlug,
        itemCount: (items || []).length,
        cartWeightKg,
        cartTotal,
        currency,
        items: JSON.stringify(summarizeItems(items)),
        decisions: JSON.stringify(decisions),
        steps: JSON.stringify(steps),
        ratesReturned: JSON.stringify(ratesReturned),
        rateCount: ratesReturned.length,
      },
    });

    writesSinceCleanup += 1;
    if (writesSinceCleanup >= CLEANUP_EVERY) {
      writesSinceCleanup = 0;
      const cutoff = new Date(Date.now() - QUOTE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await prisma.rateQuote.deleteMany({ where: { createdAt: { lt: cutoff } } });
    }
  } catch (err) {
    warn("[quote-log] saveQuote failed:", err?.message || err);
  }
}

/**
 * Lista quotes para la página de admin, con filtros simples.
 * @param {{ onlyEmpty?: boolean, search?: string, page?: number, pageSize?: number }} opts
 */
export async function getQuotes(shop, opts = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize || 25, 1), 100);
  const page = Math.max(opts.page || 1, 1);

  const where = { shop };
  if (opts.onlyEmpty) where.rateCount = 0;
  if (opts.search) {
    const q = opts.search.trim();
    where.OR = [
      { city: { contains: q, mode: "insensitive" } },
      { resolvedCity: { contains: q, mode: "insensitive" } },
      { province: { contains: q, mode: "insensitive" } },
      { departmentSlug: { contains: q, mode: "insensitive" } },
    ];
  }

  const [total, quotes] = await Promise.all([
    prisma.rateQuote.count({ where }),
    prisma.rateQuote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, quotes, page, pageSize };
}
