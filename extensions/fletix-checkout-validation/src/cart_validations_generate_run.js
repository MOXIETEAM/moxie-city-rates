// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const NO_ERRORS = { operations: [] };

/**
 * Mapeo de códigos ISO de provincia a slug del metafield.
 * Mantener en sync con api.carrier-service.jsx.
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

const METHOD_LABELS = {
  mox_express: "Envío Express",
  mox_envio: "Envío Estándar",
  mox_pickup: "Recoger en Tienda",
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

function normalizeForCompare(str) {
  if (!str) return "";
  return str
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCity(city) {
  if (!city) return "";
  return city
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveProvinceSlug(code) {
  if (!code) return null;
  return PROVINCE_CODE_TO_SLUG[code.toUpperCase()] || null;
}

function getAttribute(line, key) {
  if (!line) return null;
  // El input usa aliases (attribute, deptAttribute, cityAttribute) por GraphQL.
  // El tipado los expone directamente; recorremos para ser robustos al shape.
  const candidates = [line.attribute, line.deptAttribute, line.cityAttribute];
  for (const attr of candidates) {
    if (attr && attr.key === key) return attr.value;
  }
  return null;
}

function cityPassesRule(rule, normalizedCity) {
  const condition = rule.condition || "all";
  if (condition === "all") return true;
  const ruleCities = (rule.cities || []).map((c) => normalizeCity(c));
  if (condition === "include") return ruleCities.includes(normalizedCity);
  if (condition === "exclude") return !ruleCities.includes(normalizedCity);
  return true;
}

/**
 * Valida que cada line item del carrito con `_mox_service_code` tenga
 * al menos una regla de envío aplicable para la dirección ingresada.
 *
 * Política de fail-open (no bloquear) cuando:
 *   - No hay metafield de reglas (no configurado aún).
 *   - No hay dirección de envío aún (checkout temprano).
 *   - El código de provincia no está mapeado (ej: país fuera de Colombia).
 *   - El line item no tiene `_mox_service_code` (no es un item Mox).
 *
 * Pickup (`mox_pickup`): valida que `_mox_department` del carrito matchee el
 * departamento del destino. Si no, bloquea con mensaje de inconsistencia.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const rawMetafield = input && input.shop && input.shop.metafield && input.shop.metafield.value;
  if (!rawMetafield) return NO_ERRORS;

  let rules;
  try {
    rules = JSON.parse(rawMetafield);
  } catch (_) {
    return NO_ERRORS;
  }

  const deliveryGroups = (input && input.cart && input.cart.deliveryGroups) || [];
  const firstGroup = deliveryGroups[0];
  const address = firstGroup && firstGroup.deliveryAddress;
  if (!address) return NO_ERRORS;

  const deptSlug = resolveProvinceSlug(address.provinceCode);
  if (!deptSlug) return NO_ERRORS;

  const normalizedCity = normalizeCity(address.city || "");
  const zone = rules[deptSlug] || {};
  const defaultZone = rules["_default"] || {};
  const destDeptName = SLUG_TO_DEPARTMENT[deptSlug] || "";
  const cityDisplay = address.city || "esta dirección";

  const errors = [];
  const lines = (input && input.cart && input.cart.lines) || [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const serviceCode = getAttribute(line, "_mox_service_code");
    if (!serviceCode) continue;

    const methodLabel = METHOD_LABELS[serviceCode] || serviceCode;
    const merchandise = /** @type {any} */ (line.merchandise);
    const productTitle =
      (merchandise && merchandise.product && merchandise.product.title) ||
      "Un producto de tu carrito";

    if (serviceCode === "mox_pickup") {
      const cartDept = getAttribute(line, "_mox_department");
      if (!cartDept) continue;
      if (normalizeForCompare(cartDept) !== normalizeForCompare(destDeptName)) {
        errors.push({
          message: `"${productTitle}" está marcado para recoger en ${cartDept}, pero tu dirección es ${destDeptName || cityDisplay}. Cambia la sucursal de recogida o la dirección de envío.`,
          target: "$.cart",
        });
      }
      continue;
    }

    // Merge por serviceCode: si la zona define este método → zona autoritativa.
    // Si la zona NO define este método (o no hay zona) → _default lo cubre.
    const zoneDefinesCode = zone[serviceCode] !== undefined;
    const serviceRules = zoneDefinesCode ? zone[serviceCode] : defaultZone[serviceCode];
    if (!serviceRules || serviceRules.length === 0) {
      errors.push({
        message: `"${productTitle}" no tiene ${methodLabel} disponible en ${cityDisplay}. Elimínalo del carrito o cambia la dirección de envío.`,
        target: "$.cart",
      });
      continue;
    }

    const anyRuleMatches = serviceRules.some((rule) => cityPassesRule(rule, normalizedCity));
    if (!anyRuleMatches) {
      errors.push({
        message: `"${productTitle}" no tiene ${methodLabel} disponible en ${cityDisplay}. Elimínalo del carrito o cambia la dirección de envío.`,
        target: "$.cart",
      });
    }
  }

  if (errors.length === 0) return NO_ERRORS;

  return {
    operations: [
      {
        validationAdd: { errors },
      },
    ],
  };
}
