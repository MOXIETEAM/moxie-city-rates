/**
 * Info de productos del carrito para condiciones de producto.
 *
 * vendor y sku vienen en el payload del carrier service (por item, gratis).
 * tags / product_type / collections requieren Admin API — se consultan solo
 * cuando la tienda tiene rates que los usan (ver getProductConditionFields).
 */

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { debug } from "./logger.server";

// --- Cachés en memoria (proceso único; mismo trade-off que rate-limit.server) ---
//
// Producto: tags/tipo/colecciones cambian poco — TTL 5 min evita pegarle a la
// Admin API en cada checkout (~200ms por request ahorrados en carritos repetidos).
// Fields: qué campos de producto usan las rates de la tienda — TTL 60s; peor
// caso tras un cambio de reglas: por <60s no se arma cartProducts y la
// condición queda fail-open (comportamiento histórico ante falta de datos).

const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000;
const PRODUCT_CACHE_MAX = 5000;
const productCache = new Map(); // key `${shop}:${productId}` → { value, expires }

const FIELDS_CACHE_TTL_MS = 60 * 1000;
const fieldsCache = new Map(); // key shop → { value: Set, expires }

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttl, max) {
  if (map.size >= max) {
    // Evict el 25% más viejo (Map conserva orden de inserción).
    const drop = Math.ceil(max / 4);
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++i >= drop) break;
    }
  }
  map.set(key, { value, expires: Date.now() + ttl });
}

/**
 * Set de productField usados por las rates activas con condición de producto.
 * Mapea valores legacy (include_tags/exclude_tags → "tags"). Vacío = ninguna
 * rate filtra por producto → no hace falta armar cartProducts.
 * Cacheado 60s por tienda (una query menos por checkout).
 */
export async function getProductConditionFields(shop) {
  const cached = cacheGet(fieldsCache, shop);
  if (cached !== undefined) return cached;

  const rates = await prisma.shippingRate.findMany({
    where: {
      zone: { shop },
      enabled: true,
      productCondition: { not: "all" },
    },
    select: { productField: true },
  });
  const fields = new Set(rates.map((r) => r.productField || "tags"));
  cacheSet(fieldsCache, shop, fields, FIELDS_CACHE_TTL_MS, 2000);
  return fields;
}

/** Invalida el caché de fields de una tienda (llamar al guardar/borrar rates). */
export function invalidateProductConditionFields(shop) {
  fieldsCache.delete(shop);
}

/** ¿Alguno de los campos usados requiere consulta a la Admin API? */
export function fieldsNeedApiFetch(fields) {
  return fields.has("tags") || fields.has("product_type") || fields.has("collection");
}

const PRODUCT_INFO_QUERY = (gids) => `query {
  nodes(ids: [${gids.join(",")}]) {
    ... on Product {
      id
      vendor
      tags
      productType
      collections(first: 20) { nodes { handle title } }
    }
  }
}`;

// nodes() de la Admin API acepta máximo ~250 IDs; 100 por tanda deja margen
// y mantiene cada query liviana.
const FETCH_CHUNK_SIZE = 100;

/**
 * Mapa productId → { vendor, tags: [], productType, collections: [handles y títulos] }.
 * Con caché por producto (TTL 5 min) y fetch en tandas para carritos grandes.
 * Falla silencioso (mapa parcial/vacío) — las condiciones quedan fail-open como siempre.
 */
export async function fetchProductInfoMap(shop, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!ids.length) return {};

  const map = {};
  const missing = [];
  for (const id of ids) {
    const cached = cacheGet(productCache, `${shop}:${id}`);
    if (cached !== undefined) {
      map[id] = cached;
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) {
    debug(`[product-info] Cache hit for all ${ids.length} product(s)`);
    return map;
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    for (let i = 0; i < missing.length; i += FETCH_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + FETCH_CHUNK_SIZE);
      const gids = chunk.map((id) => `"gid://shopify/Product/${id}"`);
      const res = await admin.graphql(PRODUCT_INFO_QUERY(gids));
      const data = await res.json();
      const nodes = data.data?.nodes || [];

      for (const node of nodes) {
        if (!node?.id) continue;
        const numericId = node.id.replace("gid://shopify/Product/", "");
        const info = {
          vendor: node.vendor || "",
          tags: (node.tags || []).map((t) => t.toLowerCase().trim()),
          productType: node.productType || "",
          collections: (node.collections?.nodes || []).flatMap((c) => [c.handle, c.title].filter(Boolean)),
        };
        map[numericId] = info;
        cacheSet(productCache, `${shop}:${numericId}`, info, PRODUCT_CACHE_TTL_MS, PRODUCT_CACHE_MAX);
      }
    }
    debug(`[product-info] Fetched ${missing.length} product(s), ${ids.length - missing.length} from cache`);
    return map;
  } catch (err) {
    debug(`[product-info] Error fetching product info: ${err.message}`);
    return map;
  }
}

/**
 * Arma cartProducts (un objeto por item del carrito, formato de
 * evaluateProductCondition) combinando payload del carrier + info de la API.
 * `infoMap` puede ser {} — vendor/sku del payload siguen funcionando.
 */
export function buildCartProducts(items, infoMap = {}) {
  return (items || []).map((item) => {
    const info = infoMap[String(item.product_id)] || {};
    return {
      sku: item.sku || "",
      // El payload trae vendor por item; si no viene, cae al vendor del producto.
      vendor: item.vendor || info.vendor || "",
      productType: info.productType || "",
      tags: info.tags || [],
      collections: info.collections || [],
    };
  });
}
