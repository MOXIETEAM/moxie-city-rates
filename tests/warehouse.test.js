/**
 * Tests de warehousesForRate — bodega-de-origen por tarifa (por población).
 *
 * Feature display-only: NO toca checkout ni routing. Fija qué bodegas son
 * candidatas a origen de una tarifa, base de la decisión de UI:
 *  - 1 candidata  → muestra esa bodega
 *  - 2+ candidatas → "según disponibilidad" (Shopify decide por inventario)
 *  - 0 candidatas → sin bodega
 *  - zona default (_default…) → [] (tarifa general, sin origen único)
 *
 * Clave: la ambigüedad es por POBLACIÓN (ciudad), no por provincia — una
 * tarifa "solo Medellín" con bodegas en Medellín y Rionegro debe acotar a la
 * de Medellín.
 */

import { describe, it, expect } from "vitest";
import { warehousesForZone, warehousesForRate, matchOriginWarehouseId } from "../app/utils/warehouse.js";

const WH = {
  medCentro: { id: "1", name: "Bodega Medellín Centro", provinceSlug: "antioquia", city: "Medellín" },
  medNorte: { id: "2", name: "Bodega Medellín Norte", provinceSlug: "antioquia", city: "MEDELLIN" },
  rionegro: { id: "3", name: "Bodega Rionegro", provinceSlug: "antioquia", city: "Rionegro" },
  bogota: { id: "4", name: "Bodega Bogotá", provinceSlug: "cundinamarca", city: "Bogotá" },
};
const ALL = Object.values(WH);

const rate = (cityCondition, cities) => ({ cityCondition, cities: JSON.stringify(cities || []) });

describe("warehousesForRate", () => {
  it("tarifa 'solo Medellín' con 1 bodega Medellín + 1 Rionegro → acota a Medellín", () => {
    const r = warehousesForRate(rate("include", ["MEDELLÍN"]), "antioquia", [WH.medCentro, WH.rionegro]);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Bodega Medellín Centro");
  });

  it("2 bodegas en la MISMA población (Medellín) → empate", () => {
    const r = warehousesForRate(rate("include", ["MEDELLÍN"]), "antioquia", [WH.medCentro, WH.medNorte, WH.rionegro]);
    expect(r).toHaveLength(2);
  });

  it("match de ciudad ignora tildes/mayúsculas", () => {
    // bodega city "MEDELLIN" (sin tilde) vs rate "Medellín" (con tilde)
    const r = warehousesForRate(rate("include", ["medellín"]), "antioquia", [WH.medNorte]);
    expect(r).toHaveLength(1);
  });

  it("tarifa general (cityCondition 'all') no acota → toda la provincia", () => {
    const r = warehousesForRate(rate("all"), "antioquia", ALL);
    expect(r).toHaveLength(3); // las 3 de antioquia → caller: según disponibilidad
  });

  it("'all' con 1 sola bodega en la provincia → esa bodega", () => {
    const r = warehousesForRate(rate("all"), "cundinamarca", ALL);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Bodega Bogotá");
  });

  it("ciudad sin bodega → cae a provincia (no deja la regla sin bodega)", () => {
    // "solo Envigado" pero no hay bodega en Envigado → fallback a Antioquia.
    const r = warehousesForRate(rate("include", ["ENVIGADO"]), "antioquia", [WH.medCentro, WH.rionegro]);
    expect(r).toHaveLength(2); // las 2 de antioquia → caller: según disponibilidad
  });

  it("provincia sin ninguna bodega → vacío", () => {
    const r = warehousesForRate(rate("include", ["CALI"]), "valle_del_cauca", [WH.medCentro, WH.bogota]);
    expect(r).toHaveLength(0);
  });

  it("zona default → vacío (tarifa general)", () => {
    expect(warehousesForRate(rate("all"), "_default_co", ALL)).toHaveLength(0);
  });

  it("sin bodegas (API vacía/falló) → vacío, sin romper", () => {
    expect(warehousesForRate(rate("include", ["MEDELLÍN"]), "antioquia", [])).toHaveLength(0);
    expect(warehousesForRate(rate("all"), "antioquia", null)).toHaveLength(0);
  });
});

describe("matchOriginWarehouseId", () => {
  const WHS = [
    { id: "1", city: "Medellín", province: "Antioquia", provinceSlug: "antioquia" },
    { id: "2", city: "Bogotá", province: "Cundinamarca", provinceSlug: "cundinamarca" },
    { id: "3", city: "Medellín", province: "Antioquia", provinceSlug: "antioquia" },
  ];

  it("ciudad única → match (ignora tildes/mayúsculas)", () => {
    expect(matchOriginWarehouseId({ city: "bogota" }, WHS)).toBe("2");
  });

  it("ciudad ambigua (2 bodegas misma ciudad) → null", () => {
    expect(matchOriginWarehouseId({ city: "Medellín" }, WHS)).toBe(null);
  });

  it("ciudad ambigua pero provincia desempata → match", () => {
    const mixed = [
      { id: "1", city: "Medellín", province: "Antioquia", provinceSlug: "antioquia" },
      { id: "2", city: "Medellín", province: "Otra", provinceSlug: "otra" },
    ];
    expect(matchOriginWarehouseId({ city: "Medellín", province: "Antioquia" }, mixed)).toBe("1");
  });

  it("sin ciudad / sin bodegas / ciudad sin match → null", () => {
    expect(matchOriginWarehouseId(null, WHS)).toBe(null);
    expect(matchOriginWarehouseId({ province: "Antioquia" }, WHS)).toBe(null);
    expect(matchOriginWarehouseId({ city: "Cali" }, WHS)).toBe(null);
    expect(matchOriginWarehouseId({ city: "Medellín" }, [])).toBe(null);
  });
});

describe("warehousesForZone", () => {
  it("filtra por provincia", () => {
    expect(warehousesForZone("cundinamarca", ALL)).toHaveLength(1);
    expect(warehousesForZone("antioquia", ALL)).toHaveLength(3);
  });
  it("zona default → []", () => {
    expect(warehousesForZone("_default_co", ALL)).toHaveLength(0);
  });
});
