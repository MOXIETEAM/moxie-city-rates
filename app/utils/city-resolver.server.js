/**
 * City Resolver — resuelve nombres de ciudades colombianas escritos con
 * errores ortográficos, apodos o variantes.
 *
 * Estrategia de resolución (en orden):
 *   1. Match exacto después de normalizar (tildes, mayúsculas, espacios)
 *   2. Alias / apodos conocidos ("medallo" → MEDELLÍN)
 *   3. Fuzzy matching (Levenshtein) contra el catálogo del departamento
 *
 * Funciona para cuentas Plus (dropdown) y normales (texto libre).
 */

import MUNICIPALITIES from "../data/municipalities.json";

// ─── Normalización base ──────────────────────────────────────────────

function strip(str) {
  if (!str) return "";
  return str
    .toUpperCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*D\.?C\.?\s*$/i, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Alias / apodos colombianos ──────────────────────────────────────
// Clave: versión normalizada (sin tildes, mayúsculas).
// Valor: nombre canónico tal como aparece en municipalities.json.

const ALIASES = {
  // Antioquia
  MEDALLO: "MEDELLÍN",
  MEDE: "MEDELLÍN",
  MDLLN: "MEDELLÍN",
  RIONEGRO: "RIONEGRO",
  // Bogotá
  BOGOTA: "BOGOTÁ D.C.",
  "BOGOTA DC": "BOGOTÁ D.C.",
  "BOGOTA D C": "BOGOTÁ D.C.",
  SANTAFE: "BOGOTÁ D.C.",
  "SANTA FE DE BOGOTA": "BOGOTÁ D.C.",
  // Valle del Cauca
  CALENO: "CALI",
  // Atlántico
  BQUILLA: "BARRANQUILLA",
  BARRANQ: "BARRANQUILLA",
  QUILLA: "BARRANQUILLA",
  "LA ARENOSA": "BARRANQUILLA",
  // Bolívar
  CTGENA: "CARTAGENA",
  CARTAGO: "CARTAGENA",
  "CARTAGENA DE INDIAS": "CARTAGENA",
  // Santander
  BUCA: "BUCARAMANGA",
  BUCARAMGA: "BUCARAMANGA",
  // Norte de Santander
  CUCUTA: "CÚCUTA",
  // Meta
  VILLAVO: "VILLAVICENCIO",
  VILLAO: "VILLAVICENCIO",
  // Tolima
  IBAGUE: "IBAGUÉ",
  // Nariño
  PASTO: "PASTO",
  // Caldas
  MANIZALEZ: "MANIZALES",
  // Risaralda
  PEREIRA: "PEREIRA",
  // Cundinamarca
  SOACHA: "SOACHA",
  CHIA: "CHÍA",
  CAJICA: "CAJICÁ",
  ZIPAQUIRA: "ZIPAQUIRÁ",
  FUSAGASUGA: "FUSAGASUGÁ",
  FUSA: "FUSAGASUGÁ",
  MOSQUERA: "MOSQUERA",
  FACATATIVA: "FACATATIVÁ",
  GIRARDOT: "GIRARDOT",
  // Huila
  NEIVA: "NEIVA",
  // Magdalena
  "SANTA MARTA": "SANTA MARTA",
  SAMARIO: "SANTA MARTA",
  // Córdoba
  MONTERIA: "MONTERÍA",
  // Quindío
  ARMENIA: "ARMENIA",
  // Cauca
  POPAYAN: "POPAYÁN",
  // Boyacá
  TUNJA: "TUNJA",
  DUITAMA: "DUITAMA",
  SOGAMOSO: "SOGAMOSO",
};

// Normalizar las claves del alias map para búsqueda rápida
const ALIAS_MAP = new Map();
for (const [key, value] of Object.entries(ALIASES)) {
  ALIAS_MAP.set(strip(key), value);
}

// ─── Catálogo indexado ───────────────────────────────────────────────

// { "Antioquia": Map<"MEDELLIN" → "MEDELLÍN", "BELLO" → "BELLO", ...> }
const CATALOG_BY_DEPT = {};
// Flat: Map<"MEDELLIN" → "MEDELLÍN", ...>  (todos los dptos)
const CATALOG_FLAT = new Map();

for (const [dept, cities] of Object.entries(MUNICIPALITIES)) {
  const map = new Map();
  for (const canonical of cities) {
    const key = strip(canonical);
    map.set(key, canonical);
    CATALOG_FLAT.set(key, canonical);
  }
  CATALOG_BY_DEPT[dept] = map;
}

// ─── Levenshtein (optimizado para strings cortos) ────────────────────

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }

  return dp[n];
}

/**
 * Busca la ciudad más cercana en un catálogo (Map<stripped → canonical>).
 * Retorna { canonical, distance } o null si ninguna está dentro del umbral.
 */
function fuzzyFind(input, catalog, maxDistance) {
  let bestCanonical = null;
  let bestDist = maxDistance + 1;

  for (const [stripped, canonical] of catalog) {
    // Atajo: si la diferencia de longitud ya excede el umbral, saltar
    if (Math.abs(input.length - stripped.length) > maxDistance) continue;

    const dist = levenshtein(input, stripped);
    if (dist < bestDist) {
      bestDist = dist;
      bestCanonical = canonical;
      if (dist === 0) break;
    }
  }

  return bestDist <= maxDistance ? { canonical: bestCanonical, distance: bestDist } : null;
}

// ─── Resolver público ────────────────────────────────────────────────

/**
 * Resuelve un nombre de ciudad a su forma canónica.
 *
 * @param {string} rawCity  — lo que escribió el cliente ("medallo", "Medellin", etc.)
 * @param {string} [department] — nombre del departamento (mejora precisión de fuzzy)
 * @returns {{ resolved: string, method: "exact"|"alias"|"fuzzy"|"none", distance?: number }}
 */
export function resolveCity(rawCity, department) {
  if (!rawCity || !rawCity.trim()) {
    return { resolved: "", method: "none" };
  }

  const input = strip(rawCity);

  // 1. Match exacto en el catálogo del departamento
  if (department && CATALOG_BY_DEPT[department]) {
    const exact = CATALOG_BY_DEPT[department].get(input);
    if (exact) return { resolved: exact, method: "exact" };
  }

  // 1b. Match exacto en todo el catálogo
  const flatExact = CATALOG_FLAT.get(input);
  if (flatExact) return { resolved: flatExact, method: "exact" };

  // 2. Alias / apodos
  const aliasMatch = ALIAS_MAP.get(input);
  if (aliasMatch) return { resolved: aliasMatch, method: "alias" };

  // 3. Fuzzy matching — umbral dinámico según longitud del input
  //    Palabras cortas (<=4): max 1 edit
  //    Palabras medias (5-8): max 2 edits
  //    Palabras largas (>8): max 3 edits
  const maxDist = input.length <= 4 ? 1 : input.length <= 8 ? 2 : 3;

  // Buscar primero en el departamento (más preciso)
  if (department && CATALOG_BY_DEPT[department]) {
    const fuzzyDept = fuzzyFind(input, CATALOG_BY_DEPT[department], maxDist);
    if (fuzzyDept) {
      return { resolved: fuzzyDept.canonical, method: "fuzzy", distance: fuzzyDept.distance };
    }
  }

  // Fallback: buscar en todos los departamentos
  const fuzzyAll = fuzzyFind(input, CATALOG_FLAT, maxDist);
  if (fuzzyAll) {
    return { resolved: fuzzyAll.canonical, method: "fuzzy", distance: fuzzyAll.distance };
  }

  // No se encontró match — retornar normalizado sin resolver
  return { resolved: rawCity.toUpperCase().trim(), method: "none" };
}

/**
 * Normaliza la ciudad para comparación en reglas de envío.
 * Reemplaza normalizeCity() — ahora con resolución inteligente.
 */
export function normalizeCityForRules(city, department) {
  const { resolved } = resolveCity(city, department);
  return strip(resolved);
}
