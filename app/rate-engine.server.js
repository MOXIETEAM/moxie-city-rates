/**
 * Rate engine — pipeline compartido de cálculo de tarifas.
 *
 * Única fuente de verdad para "dado un destino + carrito, qué rates aplican".
 * Usado por:
 *  - api.carrier-service.jsx (checkout real de Shopify)
 *  - app.quotes.jsx (simulador de tarifas del admin)
 *
 * El route del carrier service conserva lo que es propio del transporte:
 * HMAC, rate-limit, parseo del payload y formato de respuesta a Shopify.
 *
 * `trace` (opcional, ver quote-log.server.js) acumula las decisiones por regla
 * y los pasos globales para el quote log — si no se pasa, el pipeline se
 * comporta igual sin costo extra.
 */

import { getRatesForDestination, resolveCity, getZoneDefinedServiceCodes, resolveExistingZoneSlug } from "./mox-shipping-rules.server";
import { debug } from "./utils/logger.server";
import { provinceToZoneSlugCandidates, provinceDisplayName, defaultZoneSlugFor } from "./utils/geo";

export const CARRIER_SERVICE_CODES = new Set(["mox_express", "mox_envio", "mox_pickup"]);

/**
 * Normaliza un nombre de depto para comparación (uppercase, sin tildes, sin sufijo D.C.).
 */
export function normalizeDeptName(name) {
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
export function detectPickupDeptMismatch(items, destDeptName) {
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
export function analyzeCartMethods(items) {
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
export function calculateCartWeightKg(items) {
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
export function calculateCartTotal(items) {
  let totalSubunits = 0;
  for (const item of items) {
    totalSubunits += (Number(item.price) || 0) * (item.quantity || 1);
  }
  return totalSubunits / 100;
}

/**
 * Resuelve el precio de una tarifa considerando su modo de pricing.
 * Retorna null cuando el peso/monto cae en un hueco entre tiers.
 */
export function resolveRatePrice(rate, cartWeightKg, cartTotal) {
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
export function pickBestRate(rates, cartWeightKg, cartTotal) {
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

/** Llave de oferta: mismo serviceCode + mismo nombre = misma oferta. */
function rateOfferKey(rate) {
  return `${rate.serviceCode}::${String(rate.name || "").trim().toLowerCase()}`;
}

/**
 * De un array de rates, retorna la mejor tarifa por OFERTA (serviceCode +
 * nombre). Reglas con el mismo nombre son variantes de precio de la misma
 * oferta (ej. por ciudad) → gana la más barata. Reglas con nombres distintos
 * son ofertas distintas → todas se muestran y el cliente elige en checkout.
 */
export function deduplicateBestRates(rates, cartWeightKg, cartTotal) {
  const byKey = {};
  for (const rate of rates) {
    const key = rateOfferKey(rate);
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(rate);
  }

  const result = [];
  for (const key in byKey) {
    const best = pickBestRate(byKey[key], cartWeightKg, cartTotal);
    if (best) result.push(best);
  }
  return result;
}

/**
 * Calcula una tarifa combinada cuando hay mezcla de métodos en el carrito.
 * Items de pickup (mox_pickup) no suman al precio de envío.
 */
export function buildCombinedRate(items, allRates, cartWeightKg, cartTotal) {
  const codeToRates = {};
  for (const rate of allRates) {
    if (!codeToRates[rate.serviceCode]) codeToRates[rate.serviceCode] = [];
    codeToRates[rate.serviceCode].push(rate);
  }

  let totalPrice = 0;
  const methodNames = [];
  const seenCodes = new Set();
  // Estimado de la combinada: el rango más conservador entre los métodos de
  // envío que la componen (pickup no aplica — el cliente recoge).
  let minDeliveryDays = null;
  let maxDeliveryDays = null;

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
      debug(`[rate-engine] Combined rate inválida: carrito requiere "${code}" pero el destino no tiene rates para ese método`);
      return null;
    }

    const best = pickBestRate(candidates, cartWeightKg, cartTotal);
    if (!best) {
      debug(`[rate-engine] Combined rate inválida: "${code}" sin best rate (pickBestRate retornó null)`);
      return null;
    }

    if (code !== "mox_pickup") {
      totalPrice += best.price;
      if (best.rate.minDeliveryDays != null) {
        minDeliveryDays = Math.max(minDeliveryDays ?? 0, best.rate.minDeliveryDays);
      }
      if (best.rate.maxDeliveryDays != null) {
        maxDeliveryDays = Math.max(maxDeliveryDays ?? 0, best.rate.maxDeliveryDays);
      }
    }
    methodNames.push(best.rate.name);
  }

  if (methodNames.length === 0) return null;

  return {
    name: methodNames.join(" + "),
    serviceCode: "mox_combined",
    price: totalPrice,
    description: "Envío combinado según métodos seleccionados",
    minDeliveryDays,
    maxDeliveryDays,
  };
}

/**
 * Anota en el trace el resultado de la fase de selección de precio:
 *  - "tier_gap": la regla matcheó condiciones pero su peso/monto cae en un
 *    hueco entre tiers → sin precio.
 *  - "selected": la regla ganó (precio más bajo de su serviceCode) y su
 *    código quedó en la respuesta final.
 *  - "lost_price": matcheó pero otra regla del mismo serviceCode fue más barata.
 *  - "method_not_selected": matcheó pero el carrito preseleccionó otro método.
 */
function annotateSelection(trace, matchingRates, finalCodes, cartWeightKg, cartTotal) {
  if (!trace) return;

  const winnersByKey = {};
  for (const entry of deduplicateBestRates(matchingRates, cartWeightKg, cartTotal)) {
    winnersByKey[rateOfferKey(entry.rate)] = entry;
  }

  const byId = new Map(trace.rules.map((r) => [r.rateId, r]));
  for (const rate of matchingRates) {
    const ruleTrace = byId.get(rate.id);
    if (!ruleTrace || !ruleTrace.matched) continue;

    const price = resolveRatePrice(rate, cartWeightKg, cartTotal);
    if (price === null) {
      ruleTrace.reason = "tier_gap";
      continue;
    }
    ruleTrace.price = price;

    const winner = winnersByKey[rateOfferKey(rate)];
    if (winner && winner.rate.id === rate.id) {
      ruleTrace.reason = finalCodes.has(rate.serviceCode) ? "selected" : "method_not_selected";
    } else {
      ruleTrace.reason = "lost_price";
    }
  }
}

/**
 * Pipeline completo: destino + carrito → rates finales.
 *
 * @param {object} params
 * @param {string} params.shop
 * @param {string} params.destCountry — ISO 3166-1 alpha-2 del destino
 * @param {string} params.province — código o nombre de provincia que envía Shopify
 * @param {string} params.city — ciudad cruda digitada por el cliente
 * @param {Array}  params.items — items del carrito (formato carrier service)
 * @param {object} params.shopMeta — { currency, ianaTimezone, country, cityMatchThreshold }
 * @param {string[]|null} [params.itemTags] — tags de productos del carrito (legacy, null = sin filtro)
 * @param {Array|null} [params.cartProducts] — un objeto por item del carrito
 *        ({ sku, vendor, productType, tags, collections }) para condiciones de
 *        producto generalizadas. Tiene prioridad sobre itemTags.
 * @param {object|null} [params.trace] — colector de createQuoteTrace()
 *
 * @returns {Promise<{
 *   finalRates: Array<{rate?: object, price: number, name?: string, serviceCode?: string, description?: string}>,
 *   departmentSlug: string, departmentName: string,
 *   cityResolution: object, resolvedCity: string,
 *   cartWeightKg: number, cartTotal: number, cartMethods: object,
 *   pickupMismatchDept: string|null,
 * }>}
 */
export async function quoteShipping({ shop, destCountry, province, city, items, shopMeta, itemTags = null, cartProducts = null, trace = null, originWarehouseId = null }) {
  // Zonas no-CO usan slug prefijado ("mx_jalisco"); el candidato legacy sin
  // prefijo cubre zonas creadas antes del esquema multi-país.
  const slugCandidates = provinceToZoneSlugCandidates(destCountry, province);
  const departmentSlug = await resolveExistingZoneSlug(shop, slugCandidates);
  const departmentName = provinceDisplayName(destCountry, province);

  const cityResolution = resolveCity(city || "", departmentName, destCountry);
  const resolvedCity = cityResolution.resolved;

  const cartWeightKg = calculateCartWeightKg(items);
  // Cart total stays in the shop currency — cart_total tier thresholds are
  // configured by the merchant in their own currency, so no conversion.
  const cartTotal = calculateCartTotal(items);
  const cartMethods = analyzeCartMethods(items);

  trace?.steps.push({
    step: "city_resolution",
    input: city || "",
    resolved: resolvedCity,
    method: cityResolution.method,
    distance: cityResolution.distance ?? null,
  });

  const base = { departmentSlug, departmentName, cityResolution, resolvedCity, cartWeightKg, cartTotal, cartMethods };

  // Corta-circuito: pickup con `_mox_department` distinto al destino → no cumplible.
  const pickupMismatchDept = detectPickupDeptMismatch(items, departmentName);
  if (pickupMismatchDept) {
    trace?.steps.push({ step: "pickup_mismatch", cartDept: pickupMismatchDept, destDept: departmentName });
    return { ...base, finalRates: [], pickupMismatchDept };
  }

  // Fletix como única fuente de verdad, con merge por serviceCode:
  //   - Si la zona del depto define un serviceCode → solo sus rules aplican para ese código.
  //   - Si la zona NO define un serviceCode → _default lo cubre (fill-in por código).
  //   - Si no hay zona para el depto → todo viene de _default.
  const zoneDefinedCodes = await getZoneDefinedServiceCodes(shop, departmentSlug);
  const rateOpts = { country: destCountry, timezone: shopMeta.ianaTimezone, threshold: shopMeta.cityMatchThreshold, cartProducts, trace, originWarehouseId };
  const zoneRates = zoneDefinedCodes.size
    ? await getRatesForDestination(shop, departmentSlug, resolvedCity, departmentName, itemTags, rateOpts)
    : [];
  // Default del PAÍS destino: `_default` solo aplica al país de la tienda;
  // otros países usan su propio `_default_{cc}` (sin fuga de tarifas entre países).
  const defaultSlug = defaultZoneSlugFor(destCountry, shopMeta.country);
  const defaultRates = await getRatesForDestination(shop, defaultSlug, "", null, itemTags, rateOpts);
  const defaultFillIn = defaultRates.filter((r) => !zoneDefinedCodes.has(r.serviceCode));
  const matchingRates = [...zoneRates, ...defaultFillIn];

  if (trace) {
    // Rates del default cuyo serviceCode está cubierto por la zona: matchearon
    // condiciones pero la zona es autoritativa para ese método.
    const byId = new Map(trace.rules.map((r) => [r.rateId, r]));
    for (const r of defaultRates) {
      if (zoneDefinedCodes.has(r.serviceCode)) {
        const ruleTrace = byId.get(r.id);
        if (ruleTrace) {
          ruleTrace.matched = false;
          ruleTrace.reason = "zone_overrides_default";
        }
      }
    }
    trace.steps.push({
      step: "zone_merge",
      zoneDefines: [...zoneDefinedCodes],
      zoneRates: zoneRates.length,
      defaultRates: defaultRates.length,
      matching: matchingRates.length,
    });
  }

  if (!matchingRates.length) {
    return { ...base, finalRates: [], pickupMismatchDept: null };
  }

  let finalRates;

  if (cartMethods.type === "single") {
    const candidates = matchingRates.filter((r) => r.serviceCode === cartMethods.code);
    const best = pickBestRate(candidates, cartWeightKg, cartTotal);
    finalRates = best ? [best] : [];
    debug(`[rate-engine] Single method "${cartMethods.code}" → ${finalRates.length ? `$${best.price}` : "none"} (${candidates.length} candidate(s))`);

  } else if (cartMethods.type === "mixed") {
    const combined = buildCombinedRate(items, matchingRates, cartWeightKg, cartTotal);
    finalRates = combined ? [combined] : [];
    debug(`[rate-engine] Mixed methods ${cartMethods.codes.join("+")} → ${finalRates.length ? `$${combined.price}` : "none"}`);

  } else {
    finalRates = deduplicateBestRates(matchingRates, cartWeightKg, cartTotal);
    debug(`[rate-engine] Sin preselección → ${finalRates.length} rate(s)`);
  }

  if (trace) {
    const finalCodes = new Set();
    if (cartMethods.type === "mixed" && finalRates.length) {
      // La combined rate usa el ganador de cada método requerido por el carrito.
      for (const code of cartMethods.codes) finalCodes.add(code);
    } else {
      for (const entry of finalRates) {
        finalCodes.add(entry.rate ? entry.rate.serviceCode : entry.serviceCode);
      }
    }
    annotateSelection(trace, matchingRates, finalCodes, cartWeightKg, cartTotal);
    trace.steps.push({
      step: "selection",
      mode: cartMethods.type,
      returned: finalRates.map((e) => ({
        name: e.rate ? e.rate.name : e.name,
        serviceCode: e.rate ? e.rate.serviceCode : e.serviceCode,
        price: e.price,
      })),
    });
  }

  return { ...base, finalRates, pickupMismatchDept: null };
}
