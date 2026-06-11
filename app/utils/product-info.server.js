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

/**
 * Set de productField usados por las rates activas con condición de producto.
 * Mapea valores legacy (include_tags/exclude_tags → "tags"). Vacío = ninguna
 * rate filtra por producto → no hace falta armar cartProducts.
 */
export async function getProductConditionFields(shop) {
  const rates = await prisma.shippingRate.findMany({
    where: {
      zone: { shop },
      enabled: true,
      productCondition: { not: "all" },
    },
    select: { productField: true },
  });
  return new Set(rates.map((r) => r.productField || "tags"));
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

/**
 * Mapa productId → { vendor, tags: [], productType, collections: [handles y títulos] }.
 * Falla silencioso (mapa vacío) — las condiciones quedan fail-open como siempre.
 */
export async function fetchProductInfoMap(shop, productIds) {
  try {
    const ids = [...new Set((productIds || []).filter(Boolean))];
    if (!ids.length) return {};

    const { admin } = await unauthenticated.admin(shop);
    const gids = ids.map((id) => `"gid://shopify/Product/${id}"`);
    const res = await admin.graphql(PRODUCT_INFO_QUERY(gids));
    const data = await res.json();
    const nodes = data.data?.nodes || [];

    const map = {};
    for (const node of nodes) {
      if (!node?.id) continue;
      const numericId = node.id.replace("gid://shopify/Product/", "");
      map[numericId] = {
        vendor: node.vendor || "",
        tags: (node.tags || []).map((t) => t.toLowerCase().trim()),
        productType: node.productType || "",
        collections: (node.collections?.nodes || []).flatMap((c) => [c.handle, c.title].filter(Boolean)),
      };
    }
    debug(`[product-info] Fetched info for ${ids.length} product(s)`);
    return map;
  } catch (err) {
    debug(`[product-info] Error fetching product info: ${err.message}`);
    return {};
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
