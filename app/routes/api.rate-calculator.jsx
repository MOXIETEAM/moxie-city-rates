/**
 * Rate Calculator API — Endpoint público para la calculadora de tarifas del storefront.
 *
 * Acepta GET con query params o POST con JSON body:
 *   - shop (requerido): dominio de la tienda
 *   - province: código de departamento (ej: "ANT") o nombre
 *   - city: nombre de la ciudad
 *   - weight_kg (opcional): peso del carrito en kg
 *   - cart_total (opcional): total del carrito en COP
 *   - product_ids (opcional): comma-separated product IDs para filtrar por tags
 *
 * Cuando se pasan product_ids, obtiene los tags via Admin API y filtra
 * las tarifas con condiciones de producto.
 */

import { getRatesForDestination, resolveCity, getZoneDefinedServiceCodes } from "../mox-shipping-rules.server";
import { unauthenticated } from "../shopify.server";
import { debug } from "../utils/logger.server";
import { checkLimit, getShopPlanForStorefront } from "../utils/billing.server";
import prisma from "../db.server";
import { verifyAppProxyOrUnauthorized } from "../utils/app-proxy-auth.server";
import { consume, getClientIp, rateLimitedResponse } from "../utils/rate-limit.server";

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

function toSlug(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function resolveProvinceSlug(province) {
  if (!province) return null;
  const fromCode = PROVINCE_CODE_TO_SLUG[province.toUpperCase()];
  if (fromCode) return fromCode;
  return toSlug(province);
}

function resolveRatePrice(rate, weightKg, cartTotal) {
  if (rate.pricingMode === "weight_tiers" && weightKg !== null) {
    const tiers = JSON.parse(rate.weightTiers || "[]");
    if (!tiers.length) return rate.price;
    for (const tier of tiers) {
      if (weightKg >= tier.minKg && weightKg < tier.maxKg) return tier.price;
    }
    const lastTier = tiers[tiers.length - 1];
    if (weightKg >= lastTier.minKg) return lastTier.price;
    return null;
  }

  if (rate.pricingMode === "cart_total" && cartTotal !== null) {
    const tiers = JSON.parse(rate.cartTotalTiers || "[]");
    if (!tiers.length) return rate.price;
    for (const tier of tiers) {
      const noLimit = !tier.maxAmount || tier.maxAmount === 0;
      if (cartTotal >= tier.minAmount && (noLimit || cartTotal < tier.maxAmount)) return tier.price;
    }
    const lastTier = tiers[tiers.length - 1];
    if (cartTotal >= lastTier.minAmount) return lastTier.price;
    return null;
  }

  return rate.price;
}

async function fetchProductTags(shop, productIds) {
  if (!productIds.length) return null;

  const hasTagRates = await prisma.shippingRate.count({
    where: { zone: { shop }, enabled: true, productCondition: { not: "all" } },
  });
  if (!hasTagRates) return null;

  try {
    const { admin } = await unauthenticated.admin(shop);
    const gids = productIds.map((id) => `"gid://shopify/Product/${id}"`);
    const query = `query { nodes(ids: [${gids.join(",")}]) { ... on Product { id tags } } }`;
    const res = await admin.graphql(query);
    const data = await res.json();
    const nodes = data.data?.nodes || [];

    const allTags = new Set();
    for (const node of nodes) {
      if (node?.tags) {
        for (const tag of node.tags) allTags.add(tag.toLowerCase().trim());
      }
    }
    debug(`[rate-calc] Tags for ${productIds.length} product(s): [${[...allTags].join(", ")}]`);
    return [...allTags];
  } catch (err) {
    debug(`[rate-calc] Error fetching product tags: ${err.message}`);
    return null;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function calculateRates({ shop, province, city, weightKg, cartTotal, productIds }) {
  if (!shop) {
    return Response.json(
      { error: "Missing required parameter: shop" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const planInfo = await getShopPlanForStorefront(shop);
  if (!checkLimit(planInfo, "storefrontRateCalculator", 0)) {
    return Response.json(
      {
        error: "pro_required",
        storefront_calculator: false,
        rates: [],
      },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  if (!province) {
    return Response.json(
      { error: "Missing required parameters: shop, province" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const departmentSlug = resolveProvinceSlug(province);
  const departmentName = SLUG_TO_DEPARTMENT[departmentSlug] || province;
  const cityResolution = resolveCity(city || "", departmentName);
  const resolvedCity = cityResolution.resolved;

  debug(`[rate-calc] ${shop} | ${province} → ${departmentSlug} | city: "${city}" → "${resolvedCity}" | weight: ${weightKg}kg | total: $${cartTotal}`);

  const itemTags = productIds ? await fetchProductTags(shop, productIds) : null;

  // Merge por serviceCode: zona autoritativa para códigos que define,
  // _default llena huecos para códigos no definidos (o todo si no hay zona).
  const zoneDefinedCodes = await getZoneDefinedServiceCodes(shop, departmentSlug);
  const zoneRates = zoneDefinedCodes.size
    ? await getRatesForDestination(shop, departmentSlug, resolvedCity, departmentName, itemTags)
    : [];
  const defaultRates = await getRatesForDestination(shop, "_default", "", null, itemTags);
  const defaultFillIn = defaultRates.filter((r) => !zoneDefinedCodes.has(r.serviceCode));
  const rates = [...zoneRates, ...defaultFillIn];

  const byCode = {};
  for (const rate of rates) {
    const price = resolveRatePrice(rate, weightKg, cartTotal);
    if (price === null) continue;
    if (!byCode[rate.serviceCode] || price < byCode[rate.serviceCode].price) {
      byCode[rate.serviceCode] = {
        name: rate.name,
        service_code: rate.serviceCode,
        price,
        price_formatted: price > 0 ? `$${price.toLocaleString("es-CO")}` : "Gratis",
        currency: "COP",
        description: rate.description || "",
      };
    }
  }

  return Response.json(
    {
      rates: Object.values(byCode),
      destination: { department: departmentName, city: resolvedCity || city },
      cart: { weight_kg: weightKg, total: cartTotal, products: productIds?.length || 0 },
      city_resolution: {
        input: city,
        resolved: cityResolution.resolved,
        method: cityResolution.method,
      },
    },
    { headers: CORS_HEADERS },
  );
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const unauthorized = await verifyAppProxyOrUnauthorized(request, CORS_HEADERS);
  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop") || "unknown";
  if (!consume(`rate-calc:${shopParam}:${getClientIp(request)}`, { capacity: 30, refillPerSec: 1 })) {
    return rateLimitedResponse(30, CORS_HEADERS);
  }

  if (url.searchParams.get("plan_check") === "1") {
    const shop = url.searchParams.get("shop");
    const planInfo = await getShopPlanForStorefront(shop);
    return Response.json(
      {
        storefront_calculator: checkLimit(planInfo, "storefrontRateCalculator", 0),
      },
      { headers: CORS_HEADERS },
    );
  }

  const productIdsRaw = url.searchParams.get("product_ids");

  return calculateRates({
    shop: url.searchParams.get("shop"),
    province: url.searchParams.get("province"),
    city: url.searchParams.get("city") || "",
    weightKg: url.searchParams.get("weight_kg") ? parseFloat(url.searchParams.get("weight_kg")) : null,
    cartTotal: url.searchParams.get("cart_total") ? parseFloat(url.searchParams.get("cart_total")) : null,
    productIds: productIdsRaw ? productIdsRaw.split(",").filter(Boolean) : null,
  });
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const unauthorized = await verifyAppProxyOrUnauthorized(request, CORS_HEADERS);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body = await request.json();
    const shopForLimit = body?.shop || "unknown";
    if (!consume(`rate-calc:${shopForLimit}:${getClientIp(request)}`, { capacity: 30, refillPerSec: 1 })) {
      return rateLimitedResponse(30, CORS_HEADERS);
    }
    if (body.plan_check) {
      const planInfo = await getShopPlanForStorefront(body.shop);
      return Response.json(
        {
          storefront_calculator: checkLimit(planInfo, "storefrontRateCalculator", 0),
        },
        { headers: CORS_HEADERS },
      );
    }
    return calculateRates({
      shop: body.shop,
      province: body.province,
      city: body.city || "",
      weightKg: body.weight_kg ? parseFloat(body.weight_kg) : null,
      cartTotal: body.cart_total ? parseFloat(body.cart_total) : null,
      productIds: body.product_ids || null,
    });
  } catch (err) {
    return Response.json(
      { error: "Invalid request body" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
};
