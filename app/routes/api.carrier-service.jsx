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

/**
 * toSlug — inlineado para evitar dependencia en mox-tags.server.
 */
function toSlug(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Shopify envía el código ISO de la provincia (ej: "ANT" para Antioquia).
 * Mapeamos a nuestro slug (ej: "antioquia").
 */
const PROVINCE_CODE_TO_SLUG = {
  AMA: "amazonas", ANT: "antioquia", ARA: "arauca", ATL: "atlantico",
  DC: "bogota_d_c", BOL: "bolivar", BOY: "boyaca", CAL: "caldas",
  CAQ: "caqueta", CAS: "casanare", CAU: "cauca", CES: "cesar",
  CHO: "choco", COR: "cordoba", CUN: "cundinamarca", GUA: "guainia",
  GUV: "guaviare", HUI: "huila", LAG: "la_guajira", MAG: "magdalena",
  MET: "meta", NAR: "narino", NSA: "norte_de_santander", PUT: "putumayo",
  QUI: "quindio", RIS: "risaralda", SAP: "san_andres_providencia_y_santa_catalina",
  SAN: "santander", SUC: "sucre", TOL: "tolima", VAC: "valle_del_cauca",
  VAU: "vaupes", VID: "vichada",
};

const SLUG_TO_DEPARTMENT = {
  amazonas: "Amazonas", antioquia: "Antioquia", arauca: "Arauca", atlantico: "Atlántico",
  bogota_d_c: "Bogotá D.C.", bolivar: "Bolívar", boyaca: "Boyacá", caldas: "Caldas",
  caqueta: "Caquetá", casanare: "Casanare", cauca: "Cauca", cesar: "Cesar",
  choco: "Chocó", cordoba: "Córdoba", cundinamarca: "Cundinamarca", guainia: "Guainía",
  guaviare: "Guaviare", huila: "Huila", la_guajira: "La Guajira", magdalena: "Magdalena",
  meta: "Meta", narino: "Nariño", norte_de_santander: "Norte de Santander", putumayo: "Putumayo",
  quindio: "Quindío", risaralda: "Risaralda", san_andres_providencia_y_santa_catalina: "San Andrés",
  santander: "Santander", sucre: "Sucre", tolima: "Tolima", valle_del_cauca: "Valle del Cauca",
  vaupes: "Vaupés", vichada: "Vichada",
};

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
function resolveRatePrice(rate, cartWeightKg, cartTotalCOP) {
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
      if (cartTotalCOP >= tier.minAmount && (hasNoLimit || cartTotalCOP < tier.maxAmount)) {
        return tier.price;
      }
    }

    const lastTier = tiers[tiers.length - 1];
    if (cartTotalCOP >= lastTier.minAmount) return lastTier.price;
    return null;
  }

  return rate.price;
}

/**
 * De un array de rates con el mismo serviceCode, retorna la de menor precio.
 */
function pickBestRate(rates, cartWeightKg, cartTotalCOP) {
  let best = null;
  for (const rate of rates) {
    const price = resolveRatePrice(rate, cartWeightKg, cartTotalCOP);
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
function deduplicateBestRates(rates, cartWeightKg, cartTotalCOP) {
  const byCode = {};
  for (const rate of rates) {
    if (!byCode[rate.serviceCode]) byCode[rate.serviceCode] = [];
    byCode[rate.serviceCode].push(rate);
  }

  const result = [];
  for (const code in byCode) {
    const best = pickBestRate(byCode[code], cartWeightKg, cartTotalCOP);
    if (best) result.push(best);
  }
  return result;
}

/**
 * Calcula una tarifa combinada cuando hay mezcla de métodos en el carrito.
 * Items de pickup (mox_pickup) no suman al precio de envío.
 */
function buildCombinedRate(items, allRates, cartWeightKg, cartTotalCOP) {
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

    const best = pickBestRate(candidates, cartWeightKg, cartTotalCOP);
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

function resolveProvinceSlug(province) {
  if (!province) return null;
  const fromCode = PROVINCE_CODE_TO_SLUG[province.toUpperCase()];
  if (fromCode) return fromCode;
  return toSlug(province);
}

export const action = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");

    if (!shop) {
      logError("[carrier-service] No shop param in callback URL");
      return Response.json({ rates: [] });
    }

    const rawBody = await request.text();
    const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET || "";
    if (!secret) {
      logError("[carrier-service] SHOPIFY_API_SECRET is not configured");
      return Response.json({ rates: [] }, { status: 500 });
    }
    if (!verifyCarrierServiceCallbackHmac(rawBody, hmac, secret)) {
      logError("[carrier-service] Invalid or missing HMAC for shop param", shop);
      return Response.json({ rates: [] }, { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      logError("[carrier-service] Invalid JSON body");
      return Response.json({ rates: [] }, { status: 400 });
    }
    const destination = body?.rate?.destination;

    if (!destination) {
      logError("[carrier-service] No destination in payload");
      return Response.json({ rates: [] });
    }

    const { province, city, country } = destination;

    if (country && country !== "CO") {
      return Response.json({ rates: [] });
    }

    if (!province) {
      return Response.json({ rates: [] });
    }

    const departmentSlug = resolveProvinceSlug(province);
    const departmentName = SLUG_TO_DEPARTMENT[departmentSlug] || province;

    const cityResolution = resolveCity(city || "", departmentName);
    const resolvedCity = cityResolution.resolved;

    debug(`[carrier-service] ${shop} | ${province} (${departmentSlug}) → city: "${city || ""}" → "${resolvedCity}" (${cityResolution.method}${cityResolution.distance ? `, dist=${cityResolution.distance}` : ""})`);

    const items = body?.rate?.items || [];
    const cartWeightKg = calculateCartWeightKg(items);
    const shopCurrency = body?.rate?.currency || "COP";
    const cartTotalShopCurrency = calculateCartTotal(items);

    let cartTotalCOP;
    if (shopCurrency === "COP") {
      cartTotalCOP = cartTotalShopCurrency;
    } else {
      const firstItem = items[0];
      if (firstItem && firstItem.price > 0) {
        const FALLBACK_RATES = { USD: 4200, EUR: 4600 };
        const rate = FALLBACK_RATES[shopCurrency] || 1;
        cartTotalCOP = cartTotalShopCurrency * rate;
        debug(`[carrier-service] Currency: ${shopCurrency} → COP (rate ~${rate}), cart: $${cartTotalShopCurrency.toFixed(2)} ${shopCurrency} ≈ $${cartTotalCOP.toLocaleString()} COP`);
      } else {
        cartTotalCOP = cartTotalShopCurrency;
      }
    }

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

    debug(`[carrier-service] Cart: ${items.length} items, ${cartWeightKg.toFixed(2)} kg, $${cartTotalCOP.toLocaleString()} COP, methods: ${cartMethods.type}`, cartMethods.type !== "none" ? JSON.stringify(cartMethods) : "");

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
    const zoneRates = zoneDefinedCodes.size
      ? await getRatesForDestination(shop, departmentSlug, resolvedCity, departmentName, itemTags)
      : [];
    const defaultRates = await getRatesForDestination(shop, "_default", "", null, itemTags);
    const defaultFillIn = defaultRates.filter((r) => !zoneDefinedCodes.has(r.serviceCode));
    const matchingRates = [...zoneRates, ...defaultFillIn];

    debug(`[carrier-service] ${departmentSlug}/${resolvedCity} | zoneDefines=[${[...zoneDefinedCodes].join(",") || "none"}] | rates: ${matchingRates.map(r => `${r.serviceCode}=$${r.price}`).join(", ") || "(ninguna)"}`);

    if (!matchingRates.length) {
      debug(`[carrier-service] Sin rates para ${departmentSlug}/${resolvedCity}`);
      return Response.json({ rates: [] });
    }

    let finalRates;

    if (cartMethods.type === "single") {
      const candidates = matchingRates.filter((r) => r.serviceCode === cartMethods.code);
      const best = pickBestRate(candidates, cartWeightKg, cartTotalCOP);
      finalRates = best ? [best] : [];
      debug(`[carrier-service] Single method "${cartMethods.code}" → ${finalRates.length ? `$${best.price}` : "none"} (${candidates.length} candidate(s))`);

    } else if (cartMethods.type === "mixed") {
      const combined = buildCombinedRate(items, matchingRates, cartWeightKg, cartTotalCOP);
      finalRates = combined ? [combined] : [];
      debug(`[carrier-service] Mixed methods ${cartMethods.codes.join("+")} → ${finalRates.length ? `$${combined.price}` : "none"}`);

    } else {
      finalRates = deduplicateBestRates(matchingRates, cartWeightKg, cartTotalCOP);
      debug(`[carrier-service] Sin preselección → ${finalRates.length} rate(s)`);
    }

    const rates = finalRates
      .map((entry) => {
        if (entry.rate) {
          return {
            service_name: entry.rate.name,
            service_code: entry.rate.serviceCode,
            total_price: String(entry.price * 100),
            currency: "COP",
            description: entry.rate.description || "",
          };
        }
        return {
          service_name: entry.name,
          service_code: entry.serviceCode,
          total_price: String(entry.price * 100),
          currency: "COP",
          description: entry.description || "",
        };
      })
      .filter(Boolean);

    info(`[carrier-service] ${shop} | ${departmentSlug}/${city} → ${rates.length} rate(s)`);

    return Response.json({ rates });
  } catch (err) {
    logError("[carrier-service] Error:", err);
    return Response.json({ rates: [] });
  }
};

// GET para health check
export const loader = async () => {
  return Response.json({ status: "ok", service: "fletix-carrier-service" });
};
