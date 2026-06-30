/**
 * Bodega-de-origen por tarifa — puro e isomórfico (server + client).
 *
 * Display/organización solamente. NO controla qué Location despacha (eso lo
 * decide Shopify por Order Routing + inventario) ni afecta el precio.
 *
 * Granularidad = población (ciudad) con fallback a departamento (provincia),
 * para que ninguna regla quede sin bodega de origen:
 *  - tarifa con ciudades específicas → bodegas ubicadas en esas ciudades. Si
 *    NINGUNA bodega matchea la ciudad, cae al match por provincia (depto) en
 *    vez de quedar sin bodega.
 *  - tarifa general (cityCondition "all"/"exclude") → bodegas de la provincia.
 *  - zona default → cubre muchas poblaciones → sin origen único.
 * Luego la UI decide: 1 candidata → muestra esa bodega; 2+ → ambiguo
 * ("según disponibilidad", Shopify elige por inventario); 0 → sin bodega.
 */

/** Normaliza nombre de ciudad para comparar (igual criterio que el resto de
 *  la app: mayúsculas, sin tildes, sin sufijo D.C., espacios colapsados). */
function normCity(city) {
  return String(city || "")
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normaliza texto para comparar direcciones (mayúsculas, sin tildes/espacios extra). */
function normTxt(s) {
  return String(s || "")
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Resuelve el `origin` de un request del carrier service (que NO trae el id de
 * la Location, solo dirección) a la bodega (Shopify Location id) que despacha.
 * Solo por CIUDAD (sin zip): city → si ambiguo, desempata por provincia.
 * Devuelve el id o null si no hay match único. Pura/isomórfica.
 *
 * @param {{city?:string,province?:string}} origin
 * @param {Array<{id,city,province,provinceSlug}>} warehouses
 */
export function matchOriginWarehouseId(origin, warehouses) {
  const list = Array.isArray(warehouses) ? warehouses : [];
  if (!origin || !list.length) return null;
  const oCity = normTxt(origin.city);
  const oProv = normTxt(origin.province);
  if (!oCity) return null;

  let m = list.filter((w) => normTxt(w.city) === oCity);
  if (m.length === 1) return m[0].id;
  // Ciudad ambigua (2+ bodegas misma ciudad) → desempatar por provincia.
  if (m.length > 1 && oProv) {
    const byProv = m.filter((w) => normTxt(w.province) === oProv);
    if (byProv.length === 1) return byProv[0].id;
  }
  return null;
}

/** Bodegas cuya provincia matchea el slug de la zona. [] para zonas default. */
export function warehousesForZone(zoneSlug, warehouses) {
  const list = Array.isArray(warehouses) ? warehouses : [];
  if (!zoneSlug || zoneSlug.startsWith("_default")) return [];
  return list.filter((w) => w.provinceSlug && w.provinceSlug === zoneSlug);
}

/**
 * Bodegas candidatas a ser el origen de una tarifa concreta.
 * @param {{cityCondition?:string, cities?:string}} rate
 * @param {string} zoneSlug
 * @param {Array<{id,name,provinceSlug,city}>} warehouses
 * @returns {Array} candidatas (la UI decide: 1 = mostrar, 2+ = según disponibilidad)
 */
export function warehousesForRate(rate, zoneSlug, warehouses) {
  const inZone = warehousesForZone(zoneSlug, warehouses);
  if (!inZone.length) return [];

  // Solo "include" con ciudades acota a poblaciones específicas. "all" y
  // "exclude" aplican a toda la provincia → tarifa general → no se acota.
  if ((rate?.cityCondition || "all") === "include") {
    let cities = [];
    try {
      cities = JSON.parse(rate?.cities || "[]");
    } catch {
      cities = [];
    }
    if (Array.isArray(cities) && cities.length) {
      const set = new Set(cities.map(normCity));
      const byCity = inZone.filter((w) => w.city && set.has(normCity(w.city)));
      // Si alguna bodega matchea por ciudad, esas mandan. Si NINGUNA matchea,
      // caer al match por provincia (depto) para no dejar la regla sin bodega.
      if (byCity.length) return byCity;
    }
  }
  return inZone;
}
