/**
 * Lógica compartida para reglas de envío por municipio.
 * Usado por:
 *  - Admin UI (CRUD de zonas y tarifas)
 *  - Carrier Service callback (cálculo de tarifas en checkout)
 *  - Sync al metafield de la tienda (para frontend/storefront)
 */

import prisma from "./db.server";
import { resolveCity, normalizeCityForRules } from "./utils/city-resolver.server";
import { debug, warn, error as logError } from "./utils/logger.server";

export { resolveCity };

const COLOMBIA_TZ = "America/Bogota";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// --- Slug helper (inlined — no dependency on mox-tags) ---

export function toSlug(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// --- City normalization ---

export function normalizeCity(city) {
  if (!city) return "";
  return city
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "") // Quitar sufijo D.C. (Bogotá D.C. → BOGOTA)
    .replace(/\s+/g, " ")
    .trim();
}

// --- Schedule helpers ---

/**
 * Obtiene la hora y día actual en Colombia (UTC-5).
 * Retorna { hour: 14, minute: 30, day: "mon" }
 */
function getNowColombia() {
  const now = new Date();
  const colombiaStr = now.toLocaleString("en-US", { timeZone: COLOMBIA_TZ });
  const colombiaDate = new Date(colombiaStr);
  return {
    hour: colombiaDate.getHours(),
    minute: colombiaDate.getMinutes(),
    day: DAY_NAMES[colombiaDate.getDay()],
  };
}

/**
 * Verifica si un rate está disponible según su horario.
 * - Si no tiene timeFrom/timeTo → siempre disponible
 * - Si tiene daysOfWeek y hoy no está → no disponible
 * - Si la hora actual está fuera del rango → no disponible
 */
function isWithinSchedule(rate) {
  const { timeFrom, timeTo, daysOfWeek } = rate;

  if (!timeFrom && !timeTo) return true;

  const now = getNowColombia();

  const days = JSON.parse(daysOfWeek || "[]");
  if (days.length > 0 && !days.includes(now.day)) {
    return false;
  }

  const currentMinutes = now.hour * 60 + now.minute;

  if (timeFrom) {
    const [fh, fm] = timeFrom.split(":").map(Number);
    if (currentMinutes < fh * 60 + fm) return false;
  }

  if (timeTo) {
    const [th, tm] = timeTo.split(":").map(Number);
    if (currentMinutes >= th * 60 + tm) return false;
  }

  return true;
}

// --- GraphQL ---

const METAFIELD_SET_MUTATION = `#graphql
  mutation setShippingRulesMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { message field }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation createFletixShippingRulesDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { message field code }
    }
  }
`;

// --- Queries ---

export async function getZonesWithRates(shop) {
  return prisma.shippingZone.findMany({
    where: { shop },
    include: { rates: { orderBy: { createdAt: "asc" } } },
    orderBy: { department: "asc" },
  });
}

/**
 * Busca las tarifas aplicables para un destino (departamento + ciudad).
 * Filtra por: enabled + ciudad + horario + tags de productos.
 * Usa el city resolver para manejar errores ortográficos y apodos.
 *
 * @param {string[]} [itemTags] - Tags de los productos en el carrito (todos combinados, sin duplicados).
 *                                 Si no se pasa, se ignora la restricción por tags.
 */
export async function getRatesForDestination(shop, departmentSlug, city, department, itemTags) {
  const zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: departmentSlug } },
    include: { rates: { where: { enabled: true } } },
  });

  if (!zone || !zone.enabled) return [];

  const deptName = department || zone.department;
  const resolved = resolveCity(city, deptName);
  const normalizedCity = normalizeCityForRules(city, deptName);

  if (resolved.method !== "exact" && resolved.method !== "none") {
    debug(`[city-resolver] "${city}" → "${resolved.resolved}" (${resolved.method}${resolved.distance ? `, dist=${resolved.distance}` : ""})`);
  }

  const normalizedItemTags = itemTags
    ? itemTags.map((t) => t.toLowerCase().trim())
    : null;

  // Honor the zone's enabledServices toggle: rates with a serviceCode the
  // merchant has disabled for this zone (e.g. legacy pickup rate kept after
  // pickup was turned off) must not appear at checkout. Default zone bypasses
  // this filter — it's the catch-all and always offers all 3 methods.
  let enabledServicesForZone = null;
  if (zone.slug !== DEFAULT_ZONE_SLUG) {
    try {
      const parsed = JSON.parse(zone.enabledServices || "[]");
      if (Array.isArray(parsed) && parsed.length > 0) {
        enabledServicesForZone = new Set(parsed);
      }
    } catch {
      // Invalid JSON — fail open (no filter) to avoid hiding rates from a
      // bad column write. Logger noise here would be high-cardinality, so skip.
    }
  }

  return zone.rates.filter((rate) => {
    if (enabledServicesForZone && !enabledServicesForZone.has(rate.serviceCode)) return false;

    if (rate.cityCondition !== "all") {
      const cities = JSON.parse(rate.cities || "[]").map((c) => normalizeCityForRules(c, deptName));
      if (rate.cityCondition === "include" && !cities.includes(normalizedCity)) return false;
      if (rate.cityCondition === "exclude" && cities.includes(normalizedCity)) return false;
    }

    if (rate.productCondition !== "all" && normalizedItemTags) {
      const rateTags = JSON.parse(rate.productTags || "[]").map((t) => t.toLowerCase().trim());
      const hasMatch = rateTags.some((rt) => normalizedItemTags.includes(rt));
      if (rate.productCondition === "include_tags" && !hasMatch) return false;
      if (rate.productCondition === "exclude_tags" && hasMatch) return false;
    }

    if (!isWithinSchedule(rate)) return false;

    return true;
  });
}

// --- CRUD ---

const DEFAULT_ZONE_SLUG = "_default";
const DEFAULT_ZONE_NAME = "Tarifa por defecto";

/**
 * Retorna el Set de serviceCodes que la zona del depto define (al menos una rate habilitada).
 * Usado por el carrier service para decidir el fallback a _default por serviceCode:
 *   - Si el código está en el set → la zona es autoritativa para ese método (sin _default).
 *   - Si el código NO está en el set → _default llena el hueco para ese método.
 *   - Si no hay zona → retorna Set vacío, todos los métodos caen a _default.
 */
export async function getZoneDefinedServiceCodes(shop, departmentSlug) {
  const empty = new Set();
  if (!departmentSlug || departmentSlug === DEFAULT_ZONE_SLUG) return empty;
  const zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: departmentSlug } },
    include: { rates: { where: { enabled: true }, select: { serviceCode: true } } },
  });
  if (!zone || !zone.enabled) return empty;

  let enabledServicesForZone = null;
  try {
    const parsed = JSON.parse(zone.enabledServices || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      enabledServicesForZone = new Set(parsed);
    }
  } catch {
    // Fail open — see getRatesForDestination.
  }

  return new Set(
    zone.rates
      .filter((r) => !enabledServicesForZone || enabledServicesForZone.has(r.serviceCode))
      .map((r) => r.serviceCode),
  );
}

export async function getOrCreateDefaultZone(shop) {
  let zone = await prisma.shippingZone.findUnique({
    where: { shop_slug: { shop, slug: DEFAULT_ZONE_SLUG } },
    include: { rates: { orderBy: { createdAt: "asc" } } },
  });

  if (!zone) {
    zone = await prisma.shippingZone.create({
      data: { shop, department: DEFAULT_ZONE_NAME, slug: DEFAULT_ZONE_SLUG },
      include: { rates: true },
    });
  }

  return zone;
}

export async function createZone(shop, department, enabledServices) {
  const slug = toSlug(department);
  const data = { shop, department, slug };
  if (Array.isArray(enabledServices) && enabledServices.length > 0) {
    data.enabledServices = JSON.stringify(enabledServices);
  }
  return prisma.shippingZone.create({ data });
}

export async function updateZoneEnabledServices(shop, zoneId, enabledServices) {
  if (!Array.isArray(enabledServices) || enabledServices.length === 0) {
    throw new Error("enabledServices must be a non-empty array");
  }
  const zone = await prisma.shippingZone.findFirst({ where: { id: zoneId, shop } });
  if (!zone) throw new Error("Zone not found or unauthorized");
  return prisma.shippingZone.update({
    where: { id: zoneId },
    data: { enabledServices: JSON.stringify(enabledServices) },
  });
}

export async function deleteZone(id, shop) {
  const zone = await prisma.shippingZone.findFirst({ where: { id, shop } });
  if (!zone) throw new Error("Zone not found or unauthorized");
  return prisma.shippingZone.delete({ where: { id } });
}

export async function saveRate({
  id,
  zoneId,
  shop,
  name,
  serviceCode,
  price,
  description,
  cityCondition,
  cities,
  timeFrom,
  timeTo,
  daysOfWeek,
  pricingMode,
  weightTiers,
  cartTotalTiers,
  productCondition,
  productTags,
}) {
  const parsedPrice = parseInt(price, 10);

  const fields = {
    name,
    serviceCode,
    price: isNaN(parsedPrice) ? 0 : parsedPrice,
    description: description || "",
    cityCondition: cityCondition || "all",
    cities: cities || "[]",
    timeFrom: timeFrom || null,
    timeTo: timeTo || null,
    daysOfWeek: daysOfWeek || "[]",
    pricingMode: pricingMode || "flat",
    weightTiers: weightTiers || "[]",
    cartTotalTiers: cartTotalTiers || "[]",
    productCondition: productCondition || "all",
    productTags: productTags || "[]",
  };

  if (id) {
    const existing = await prisma.shippingRate.findFirst({
      where: { id, zone: { shop } },
    });
    if (!existing) throw new Error("Rate not found or unauthorized");
    return prisma.shippingRate.update({ where: { id }, data: fields });
  }

  if (shop) {
    const zone = await prisma.shippingZone.findFirst({ where: { id: zoneId, shop } });
    if (!zone) throw new Error("Zone not found or unauthorized");
  }

  return prisma.shippingRate.create({
    data: {
      ...fields,
      zone: { connect: { id: zoneId } },
    },
  });
}

export async function deleteRate(id, shop) {
  const rate = await prisma.shippingRate.findFirst({
    where: { id, zone: { shop } },
  });
  if (!rate) throw new Error("Rate not found or unauthorized");
  return prisma.shippingRate.delete({ where: { id } });
}

// --- Sync to shop metafield ---

/**
 * Namespace canónico de Fletix. El storefront debe leer desde acá.
 * El namespace `mox_store_promise` se sigue escribiendo transitoriamente para no
 * romper instalaciones del theme que aún no migraron — ver TODO-NAMESPACE-MIGRATION.md.
 */
const FLETIX_NAMESPACE = "fletix";
const LEGACY_NAMESPACE = "mox_store_promise";
const METAFIELD_KEY = "shipping_rules";

/**
 * Registra la metafield definition de `fletix.shipping_rules` con
 * acceso público de storefront. Idempotente: ignora el error si ya existe.
 *
 * Esto permite que cualquier theme (incluyendo el de mox-store-promise) lea
 * `shop.metafields.fletix.shipping_rules` desde Liquid, y que el merchant vea
 * el metafield en Settings → Custom data del admin con descripción.
 */
async function ensureFletixMetafieldDefinition(admin) {
  try {
    const res = await admin.graphql(METAFIELD_DEFINITION_CREATE_MUTATION, {
      variables: {
        definition: {
          namespace: FLETIX_NAMESPACE,
          key: METAFIELD_KEY,
          name: "Fletix Shipping Rules",
          description: "Reglas de envío publicadas por Fletix para consumo de temas.",
          type: "json",
          ownerType: "SHOP",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    });
    const data = await res.json();
    const errors = data.data?.metafieldDefinitionCreate?.userErrors || [];
    // TAKEN_BY_OTHER significa que ya existe — esperado en deploys subsecuentes.
    const realErrors = errors.filter((e) => e.code !== "TAKEN" && e.code !== "TAKEN_BY_OTHER");
    if (realErrors.length > 0) {
      warn("[shipping-rules] metafieldDefinitionCreate errors:", realErrors);
    }
  } catch (err) {
    // No bloqueante: el sync del metafield puede continuar aún sin la definition.
    warn("[shipping-rules] No se pudo crear metafield definition:", err?.message || err);
  }
}

/**
 * Serializa reglas a JSON y las publica al metafield del shop.
 *
 * Escribe al namespace canónico `fletix.shipping_rules` y simultáneamente al
 * legacy `mox_store_promise.shipping_rules` para retrocompatibilidad con el
 * theme de mox-store-promise mientras se migra a leer del namespace nuevo.
 *
 * Plan de remoción del legacy: una vez que todos los themes consumidores
 * lean exclusivamente de `fletix.shipping_rules`, eliminar la entrada legacy
 * del array de metafields y borrar el metafield viejo de la tienda.
 */
export async function syncRulesToMetafield(admin, shop) {
  await ensureFletixMetafieldDefinition(admin);

  const zones = await getZonesWithRates(shop);
  const rules = {};

  for (const zone of zones) {
    if (!zone.enabled) continue;
    rules[zone.slug] = {};

    let enabledServicesForZone = null;
    if (zone.slug !== DEFAULT_ZONE_SLUG) {
      try {
        const parsed = JSON.parse(zone.enabledServices || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) {
          enabledServicesForZone = new Set(parsed);
        }
      } catch {
        // Fail open.
      }
    }

    for (const rate of zone.rates) {
      if (!rate.enabled) continue;
      if (enabledServicesForZone && !enabledServicesForZone.has(rate.serviceCode)) continue;
      const cities = JSON.parse(rate.cities || "[]").map(normalizeCity);
      const rule = {
        condition: rate.cityCondition,
        cities,
      };

      if (rate.productCondition !== "all") {
        rule.productCondition = rate.productCondition;
        rule.productTags = JSON.parse(rate.productTags || "[]");
      }

      if (rate.timeFrom) rule.timeFrom = rate.timeFrom;
      if (rate.timeTo) rule.timeTo = rate.timeTo;
      const days = JSON.parse(rate.daysOfWeek || "[]");
      if (days.length > 0) rule.days = days;

      if (!rules[zone.slug][rate.serviceCode]) {
        rules[zone.slug][rate.serviceCode] = [];
      }
      rules[zone.slug][rate.serviceCode].push(rule);
    }
  }

  const json = JSON.stringify(rules);
  const ownerId = `gid://shopify/Shop/${await getShopId(admin)}`;

  const res = await admin.graphql(METAFIELD_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: FLETIX_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: json,
        },
        {
          ownerId,
          namespace: LEGACY_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: json,
        },
      ],
    },
  });

  const data = await res.json();
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    logError("[shipping-rules] Metafield errors:", errors);
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  debug(`[shipping-rules] Synced ${Object.keys(rules).length} zones to metafield (fletix + legacy)`);
  return rules;
}

// --- Helpers ---

async function getShopId(admin) {
  const res = await admin.graphql(`query { shop { id } }`);
  const data = await res.json();
  return data.data.shop.id.replace("gid://shopify/Shop/", "");
}
