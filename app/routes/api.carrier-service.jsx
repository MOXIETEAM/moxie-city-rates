/**
 * Carrier Service Callback — POST endpoint que Shopify llama durante el checkout.
 *
 * Maneja TODOS los métodos de envío (express, envío estándar, pickup).
 *
 * Lógica:
 * - Items con _mox_service_code pre-seleccionado → retorna solo esa tarifa
 * - Carrito mixto → retorna tarifa combinada (suma precios, pickup no suma)
 * - Sin pre-selección → retorna todas las tarifas aplicables al destino
 * - Sin zona configurada → aplica tarifa por defecto (_default)
 *
 * Este endpoint es público (no usa authenticate.admin).
 * El shop se identifica via query param ?shop= incluido al registrar el carrier service.
 */

import { getRatesForDestination, resolveCity, getZoneDefinedServiceCodes } from "../mox-shipping-rules.server";
import { debug, info, error as logError } from "../utils/logger.server";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { verifyCarrierServiceCallbackHmac } from "../utils/shopify-hmac.server";
import { consume, getClientIp } from "../utils/rate-limit.server";
import { provinceToSlug, provinceDisplayName, toCarrierTotalPrice } from "../utils/geo";
import { getShopMeta } from "../utils/shop-record.server";


const CARRIER_SERVICE_CODES = new Set(["mox_express", "mox_envio", "mox_pickup"]);

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

/**
 * Normaliza un nombre de depto para comparación (uppercase, sin tildes, sin sufijo D.C.).
 */
function normalizeDeptName(name) {
  if (!name) return "";
  return String(name)
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta si el carrito tiene items de pickup cuya `_mox_department` (depto
 * donde está la sucursal elegida) no matchea el depto del destino del
 * checkout. Devuelve el depto del carrito cuando hay mismatch, o null.
 * Usado para bloquear pedidos tipo "pickup Medellín + envío a Bogotá".
 */
function detectPickupDeptMismatch(items, destDeptName) {
  const destNorm = normalizeDeptName(destDeptName);
  for (const item of items) {
    const props = item.properties || {};
    if (props["_mox_service_code"] !== "mox_pickup") continue;
    const cartDept = props["_mox_department"];
    if (!cartDept) continue;
    if (normalizeDeptName(cartDept) !== destNorm) return cartDept;
  }
  return null;
}

/**
 * Analiza los service codes de los items del carrito.
 * Retorna:
 *   { type: "single", code: "mox_express" }
 *   { type: "mixed", codes: ["mox_express", "mox_pickup"] }
 *   { type: "none" }
 */
function analyzeCartMethods(items) {
  const codeCount = {};

  for (let i = 0; i < items.length; i++) {
    const props = items[i].properties || {};
    const code = props["_mox_service_code"];
    if (code && CARRIER_SERVICE_CODES.has(code)) {
      codeCount[code] = (codeCount[code] || 0) + items[i].quantity;
    }
  }

  const codes = Object.keys(codeCount);
  if (codes.length === 0) return { type: "none" };
  if (codes.length === 1) return { type: "single", code: codes[0] };
  return { type: "mixed", codes, codeCount };
}

/**
 * Calcula el peso total del carrito en kg.
 */
function calculateCartWeightKg(items) {
  let totalGrams = 0;
  for (const item of items) {
    totalGrams += (item.grams || 0) * (item.quantity || 1);
  }
  return totalGrams / 1000;
}

/**
 * Calcula el precio total de los items del carrito en la moneda de la tienda.
 * Shopify envía `price` en centavos por cada item.
 */
function calculateCartTotal(items) {
  let totalSubunits = 0;
  for (const item of items) {
    totalSubunits += (Number(item.price) || 0) * (item.quantity || 1);
  }
  return totalSubunits / 100;
}

/**
 * Resuelve el precio de una tarifa considerando su modo de pricing.
 */
function resolveRatePrice(rate, cartWeightKg, cartTotal) {
  if (rate.pricingMode === "weight_tiers") {
    const tiers = JSON.parse(rate.weightTiers || "[]");
    if (!tiers.length) return rate.price;

    for (const tier of tiers) {
      if (cartWeightKg >= tier.minKg && cartWeightKg < tier.maxKg) {
        return tier.price;
      }
    }

    const lastTier = tiers[tiers.length - 1];
    if (cartWeightKg >= lastTier.minKg) return lastTier.price;
    return null;
  }

  if (rate.pricingMode === "cart_total") {
    const tiers = JSON.parse(rate.cartTotalTiers || "[]");
    if (!tiers.length) return rate.price;

    for (const tier of tiers) {
      const hasNoLimit = !tier.maxAmount || tier.maxAmount === 0;
      if (cartTotal >= tier.minAmount && (hasNoLimit || cartTotal < tier.maxAmount)) {
        return tier.price;
      }
    }

    const lastTier = tiers[tiers.length - 1];
    if (cartTotal >= lastTier.minAmount) return lastTier.price;
    return null;
  }

  return rate.price;
}

/**
 * De un array de rates con el mismo serviceCode, retorna la de menor precio.
 */
function pickBestRate(rates, cartWeightKg, cartTotal) {
  let best = null;
  for (const rate of rates) {
    const price = resolveRatePrice(rate, cartWeightKg, cartTotal);
    if (price === null) continue;
    if (best === null || price < best.price) {
      best = { rate, price };
    }
  }
  return best;
}

/**
 * De un array de rates (posiblemente con serviceCodes repetidos),
 * retorna la mejor tarifa por serviceCode.
 */
function deduplicateBestRates(rates, cartWeightKg, cartTotal) {
  const byCode = {};
  for (const rate of rates) {
    if (!byCode[rate.serviceCode]) byCode[rate.serviceCode] = [];
    byCode[rate.serviceCode].push(rate);
  }

  const result = [];
  for (const code in byCode) {
    const best = pickBestRate(byCode[code], cartWeightKg, cartTotal);
    if (best) result.push(best);
  }
  return result;
}

/**
 * Calcula una tarifa combinada cuando hay mezcla de métodos en el carrito.
 * Items de pickup (mox_pickup) no suman al precio de envío.
 */
function buildCombinedRate(items, allRates, cartWeightKg, cartTotal) {
  const codeToRates = {};
  for (const rate of allRates) {
    if (!codeToRates[rate.serviceCode]) codeToRates[rate.serviceCode] = [];
    codeToRates[rate.serviceCode].push(rate);
  }

  let totalPrice = 0;
  const methodNames = [];
  const seenCodes = new Set();

  for (let i = 0; i < items.length; i++) {
    const props = items[i].properties || {};
    const code = props["_mox_service_code"];
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);

    // Si cualquier item del carrito requiere un método que no existe para el
    // destino, la tarifa combinada es inválida: no podemos cumplir ese item.
    // Retornar null → Shopify muestra "No hay métodos de envío" y el checkout
    // queda bloqueado hasta que cambien la dirección o eliminen el item.
    const candidates = codeToRates[code];
    if (!candidates || !candidates.length) {
      debug(`[carrier-service] Combined rate inválida: carrito requiere "${code}" pero el destino no tiene rates para ese método`);
      return null;
    }

    const best = pickBestRate(candidates, cartWeightKg, cartTotal);
    if (!best) {
      debug(`[carrier-service] Combined rate inválida: "${code}" sin best rate (pickBestRate retornó null)`);
      return null;
    }

    if (code !== "mox_pickup") {
      totalPrice += best.price;
    }
    methodNames.push(best.rate.name);
  }

  if (methodNames.length === 0) return null;

  return {
    name: methodNames.join(" + "),
    serviceCode: "mox_combined",
    price: totalPrice,
    description: "Envío combinado según métodos seleccionados",
  };
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

    const departmentSlug = provinceToSlug(destCountry, province);
    const departmentName = provinceDisplayName(destCountry, province);

    const cityResolution = resolveCity(city || "", departmentName, destCountry);
    const resolvedCity = cityResolution.resolved;

    info(`[carrier-service] ${shop} | ${destCountry} province="${province}" (${departmentSlug}) | city="${city || ""}" → resolved="${resolvedCity}" (${cityResolution.method}${cityResolution.distance ? `, dist=${cityResolution.distance}` : ""})`);

    const items = body?.rate?.items || [];
    const cartWeightKg = calculateCartWeightKg(items);
    // Cart total stays in the shop currency — cart_total tier thresholds are
    // configured by the merchant in their own currency, so no conversion.
    const cartTotal = calculateCartTotal(items);

    const cartMethods = analyzeCartMethods(items);

    // Corta-circuito: pickup con `_mox_department` distinto al destino → no cumplible.
    // Shopify cobrará una "combined rate" que silencia el pickup si no bloqueamos acá.
    const pickupMismatchDept = detectPickupDeptMismatch(items, departmentName);
    if (pickupMismatchDept) {
      debug(`[carrier-service] Pickup dept mismatch: carrito tiene pickup en "${pickupMismatchDept}" pero destino es "${departmentName}" → 0 rates`);
      return Response.json({ rates: [] });
    }

    for (const item of items) {
      const props = item.properties || {};
      const code = props["_mox_service_code"] || "(sin código)";
      debug(`[carrier-service]   item: ${item.name || item.title || "?"} | _mox_service_code=${code} | price=${item.price} ${shopCurrency}`);
    }

    debug(`[carrier-service] Cart: ${items.length} items, ${cartWeightKg.toFixed(2)} kg, ${cartTotal.toLocaleString()} ${shopCurrency}, methods: ${cartMethods.type}`, cartMethods.type !== "none" ? JSON.stringify(cartMethods) : "");

    let itemTags = null;
    const hasProductRates = await shopHasProductRates(shop);
    if (hasProductRates) {
      itemTags = await fetchCartProductTags(shop, items);
    }

    // Fletix como única fuente de verdad, con merge por serviceCode:
    //   - Si la zona del depto define un serviceCode → solo sus rules aplican para ese código.
    //   - Si la zona NO define un serviceCode → _default lo cubre (fill-in por código).
    //   - Si no hay zona para el depto → todo viene de _default.
    const zoneDefinedCodes = await getZoneDefinedServiceCodes(shop, departmentSlug);
    const rateOpts = { country: destCountry, timezone: shopMeta.ianaTimezone, threshold: shopMeta.cityMatchThreshold };
    const zoneRates = zoneDefinedCodes.size
      ? await getRatesForDestination(shop, departmentSlug, resolvedCity, departmentName, itemTags, rateOpts)
      : [];
    const defaultRates = await getRatesForDestination(shop, "_default", "", null, itemTags, rateOpts);
    const defaultFillIn = defaultRates.filter((r) => !zoneDefinedCodes.has(r.serviceCode));
    const matchingRates = [...zoneRates, ...defaultFillIn];

    info(`[carrier-service] ${departmentSlug}/${resolvedCity} | zoneDefines=[${[...zoneDefinedCodes].join(",") || "none"}] | zoneRates=${zoneRates.length} defaultRates=${defaultRates.length} matching=${matchingRates.length} | rates: ${matchingRates.map(r => `${r.serviceCode}=$${r.price}(${r.pricingMode})`).join(", ") || "(ninguna)"}`);

    if (!matchingRates.length) {
      debug(`[carrier-service] Sin rates para ${departmentSlug}/${resolvedCity}`);
      return Response.json({ rates: [] });
    }

    let finalRates;

    if (cartMethods.type === "single") {
      const candidates = matchingRates.filter((r) => r.serviceCode === cartMethods.code);
      const best = pickBestRate(candidates, cartWeightKg, cartTotal);
      finalRates = best ? [best] : [];
      debug(`[carrier-service] Single method "${cartMethods.code}" → ${finalRates.length ? `$${best.price}` : "none"} (${candidates.length} candidate(s))`);

    } else if (cartMethods.type === "mixed") {
      const combined = buildCombinedRate(items, matchingRates, cartWeightKg, cartTotal);
      finalRates = combined ? [combined] : [];
      debug(`[carrier-service] Mixed methods ${cartMethods.codes.join("+")} → ${finalRates.length ? `$${combined.price}` : "none"}`);

    } else {
      finalRates = deduplicateBestRates(matchingRates, cartWeightKg, cartTotal);
      debug(`[carrier-service] Sin preselección → ${finalRates.length} rate(s)`);
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
