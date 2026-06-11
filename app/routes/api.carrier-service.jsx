/**
 * Carrier Service Callback — POST endpoint que Shopify llama durante el checkout.
 *
 * Maneja TODOS los métodos de envío (express, envío estándar, pickup).
 *
 * Lógica (implementada en app/rate-engine.server.js, compartida con el
 * simulador del admin):
 * - Items con _mox_service_code pre-seleccionado → retorna solo esa tarifa
 * - Carrito mixto → retorna tarifa combinada (suma precios, pickup no suma)
 * - Sin pre-selección → retorna todas las tarifas aplicables al destino
 * - Sin zona configurada → aplica tarifa por defecto (_default)
 *
 * Cada request se persiste al quote log (fire-and-forget, nunca bloquea ni
 * demora la respuesta a Shopify) para diagnóstico del merchant en /app/quotes.
 *
 * Este endpoint es público (no usa authenticate.admin).
 * El shop se identifica via query param ?shop= incluido al registrar el carrier service.
 */

import { quoteShipping } from "../rate-engine.server";
import { debug, info, error as logError } from "../utils/logger.server";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { verifyCarrierServiceCallbackHmac } from "../utils/shopify-hmac.server";
import { consume, getClientIp } from "../utils/rate-limit.server";
import { toCarrierTotalPrice } from "../utils/geo";
import { getShopMeta } from "../utils/shop-record.server";
import { createQuoteTrace, saveQuote } from "../utils/quote-log.server";

/**
 * Verifica si hay rates con condiciones de producto activas para esta tienda.
 * Solo si las hay, vale la pena hacer el fetch de tags (evita latencia innecesaria).
 */
async function shopHasProductRates(shop) {
  const count = await prisma.shippingRate.count({
    where: {
      zone: { shop },
      enabled: true,
      productCondition: { not: "all" },
    },
  });
  return count > 0;
}

/**
 * Obtiene los tags de productos del carrito via Admin API.
 * Usa unauthenticated.admin() para acceder sin sesión OAuth activa.
 * Retorna un array de tags únicos (lowercase).
 */
async function fetchCartProductTags(shop, items) {
  try {
    const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
    if (!productIds.length) return [];

    const { admin } = await unauthenticated.admin(shop);

    const gids = productIds.map((id) => `"gid://shopify/Product/${id}"`);
    const query = `query { nodes(ids: [${gids.join(",")}]) { ... on Product { id tags } } }`;

    const res = await admin.graphql(query);
    const data = await res.json();
    const nodes = data.data?.nodes || [];

    const allTags = new Set();
    for (const node of nodes) {
      if (node?.tags) {
        for (const tag of node.tags) {
          allTags.add(tag.toLowerCase().trim());
        }
      }
    }

    debug(`[carrier-service] Fetched tags for ${productIds.length} product(s): [${[...allTags].join(", ")}]`);
    return [...allTags];
  } catch (err) {
    debug(`[carrier-service] Error fetching product tags: ${err.message}`);
    return [];
  }
}

export const action = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");

    if (!shop) {
      logError("[carrier-service] No shop param in callback URL");
      return Response.json({ rates: [] });
    }

    // Rate-limit per shop. Shopify itself is the only legitimate caller and
    // checkout traffic stays well under this. Burst of 120 covers Shopify's
    // parallel calls during a single checkout (multiple shipping options).
    if (!consume(`carrier:${shop}`, { capacity: 120, refillPerSec: 4 })) {
      return Response.json({ rates: [] });
    }

    const rawBody = await request.text();
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET || "";
    if (!secret) {
      logError("[carrier-service] SHOPIFY_API_SECRET is not configured");
      return Response.json({ rates: [] });
    }
    if (!verifyCarrierServiceCallbackHmac(rawBody, hmac, secret)) {
      logError("[carrier-service] Invalid or missing HMAC for shop param", shop);
      // Tighter limit on HMAC failures — repeated invalid HMAC attempts are
      // probably abuse, so demote the bucket aggressively per source IP.
      consume(`carrier-bad:${getClientIp(request)}`, { capacity: 10, refillPerSec: 0.1 });
      return Response.json({ rates: [] });
    }

    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      logError("[carrier-service] Invalid JSON body");
      return Response.json({ rates: [] });
    }
    const destination = body?.rate?.destination;

    if (!destination) {
      logError("[carrier-service] No destination in payload");
      return Response.json({ rates: [] });
    }

    const { province, city, country } = destination;

    if (!province) {
      return Response.json({ rates: [] });
    }

    // Shop metadata (currency / timezone / country). Currency from the payload
    // is the shop currency at checkout; meta is the fallback for older rows.
    const shopMeta = await getShopMeta(shop);
    const shopCurrency = body?.rate?.currency || shopMeta.currency || "COP";

    // Destination country gates the Colombian city catalog and drives province
    // resolution. Defaults to the shop country when Shopify omits it.
    const destCountry = country || shopMeta.country || "CO";

    const items = body?.rate?.items || [];

    for (const item of items) {
      const props = item.properties || {};
      const code = props["_mox_service_code"] || "(sin código)";
      debug(`[carrier-service]   item: ${item.name || item.title || "?"} | _mox_service_code=${code} | price=${item.price} ${shopCurrency}`);
    }

    let itemTags = null;
    const hasProductRates = await shopHasProductRates(shop);
    if (hasProductRates) {
      itemTags = await fetchCartProductTags(shop, items);
    }

    const trace = createQuoteTrace();
    const result = await quoteShipping({
      shop,
      destCountry,
      province,
      city: city || "",
      items,
      shopMeta,
      itemTags,
      trace,
    });

    const {
      finalRates,
      departmentSlug,
      departmentName,
      cityResolution,
      resolvedCity,
      cartWeightKg,
      cartTotal,
      cartMethods,
      pickupMismatchDept,
    } = result;

    info(`[carrier-service] ${shop} | ${destCountry} province="${province}" (${departmentSlug}) | city="${city || ""}" → resolved="${resolvedCity}" (${cityResolution.method}${cityResolution.distance ? `, dist=${cityResolution.distance}` : ""})`);
    debug(`[carrier-service] Cart: ${items.length} items, ${cartWeightKg.toFixed(2)} kg, ${cartTotal.toLocaleString()} ${shopCurrency}, methods: ${cartMethods.type}`, cartMethods.type !== "none" ? JSON.stringify(cartMethods) : "");

    if (pickupMismatchDept) {
      debug(`[carrier-service] Pickup dept mismatch: carrito tiene pickup en "${pickupMismatchDept}" pero destino es "${departmentName}" → 0 rates`);
    }

    const rates = finalRates
      .map((entry) => {
        if (entry.rate) {
          return {
            service_name: entry.rate.name,
            service_code: entry.rate.serviceCode,
            total_price: toCarrierTotalPrice(entry.price),
            currency: shopCurrency,
            description: entry.rate.description || "",
          };
        }
        return {
          service_name: entry.name,
          service_code: entry.serviceCode,
          total_price: toCarrierTotalPrice(entry.price),
          currency: shopCurrency,
          description: entry.description || "",
        };
      })
      .filter(Boolean);

    info(`[carrier-service] ${shop} | ${departmentSlug}/${city} → ${rates.length} rate(s)`);
    info(`[carrier-service] RESPONSE shopCurrency=${shopCurrency} payload=${JSON.stringify({ rates })}`);

    // Quote log — fire-and-forget: no await, nunca afecta la respuesta a Shopify.
    void saveQuote({
      shop,
      source: "checkout",
      country: destCountry,
      province: province || "",
      city: city || "",
      resolvedCity,
      resolveMethod: cityResolution.method,
      departmentSlug,
      items,
      cartWeightKg,
      cartTotal,
      currency: shopCurrency,
      trace,
      ratesReturned: rates.map((r) => ({
        name: r.service_name,
        serviceCode: r.service_code,
        totalPrice: r.total_price,
        currency: r.currency,
      })),
    });

    return Response.json({ rates });
  } catch (err) {
    logError("[carrier-service] Error:", err);
    return Response.json({ rates: [] });
  }
};

// GET para health check
export const loader = async () => {
  const variant = process.env.APP_VARIANT === "cityrates" ? "cityrates" : "fletix";
  return Response.json({ status: "ok", service: `${variant}-carrier-service` });
};
