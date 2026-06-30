/**
 * Resolución origen→bodega para el carrier service (checkout), con caché.
 *
 * El payload del carrier trae `rate.origin` con dirección pero SIN id de
 * Location, así que se matchea por dirección contra las Locations de la tienda.
 * Para no pegarle a la Admin API en cada checkout, se cachea la lista de
 * bodegas por shop con TTL corto (las Locations cambian rara vez).
 *
 * Nunca lanza: ante cualquier error devuelve null (sin match) → la rate con
 * bodega asignada igual pasa (ver getRatesForDestination: origin null = no
 * filtra), priorizando mostrar de más antes que ocultar una tarifa válida.
 */

import { unauthenticated } from "../shopify.server";
import { getWarehouses } from "./warehouse.server";
import { matchOriginWarehouseId } from "./warehouse";
import { warn } from "./logger.server";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // shop → { at, warehouses }

async function getWarehousesCached(shop) {
  const hit = cache.get(shop);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.warehouses;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const warehouses = await getWarehouses(admin);
    cache.set(shop, { at: now, warehouses });
    return warehouses;
  } catch (e) {
    warn("[warehouse-cache] fetch failed:", e?.message || e);
    return hit?.warehouses || [];
  }
}

/** @returns {Promise<string|null>} Shopify Location id, o null si no hay match. */
export async function resolveOriginWarehouseId(shop, origin) {
  if (!origin) return null;
  try {
    const warehouses = await getWarehousesCached(shop);
    return matchOriginWarehouseId(origin, warehouses);
  } catch (e) {
    warn("[warehouse-cache] resolve failed:", e?.message || e);
    return null;
  }
}
