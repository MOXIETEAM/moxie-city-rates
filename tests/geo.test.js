/**
 * Tests de geo.js — slugs multi-país, defaults por país, formato carrier.
 * El contrato de slugs es crítico: si admin y checkout derivan slugs
 * distintos para la misma zona, las tarifas desaparecen silenciosamente.
 */

import { describe, it, expect } from "vitest";
import {
  toSlug,
  provinceToSlug,
  provinceToZoneSlugCandidates,
  zoneSlugForCountry,
  defaultZoneSlugFor,
  toCarrierTotalPrice,
} from "../app/utils/geo.js";

describe("toSlug", () => {
  it("quita tildes y normaliza separadores", () => {
    expect(toSlug("Bogotá D.C.")).toBe("bogota_d_c");
    expect(toSlug("Valle del Cauca")).toBe("valle_del_cauca");
    expect(toSlug("São Paulo")).toBe("sao_paulo");
  });
});

describe("provinceToSlug", () => {
  it("código de Shopify → slug del nombre (CO)", () => {
    expect(provinceToSlug("CO", "ANT")).toBe("antioquia");
  });

  it("nombre completo también resuelve (fallback)", () => {
    expect(provinceToSlug("CO", "Antioquia")).toBe("antioquia");
  });

  it("país fuera del dataset → slug directo del valor", () => {
    expect(provinceToSlug("FR", "Île-de-France")).toBe("ile_de_france");
  });
});

describe("provinceToZoneSlugCandidates — contrato multi-país", () => {
  it("CO: un solo candidato sin prefijo (legacy intacto)", () => {
    expect(provinceToZoneSlugCandidates("CO", "ANT")).toEqual(["antioquia"]);
  });

  it("MX: prefijado primero, legacy después", () => {
    expect(provinceToZoneSlugCandidates("MX", "JAL")).toEqual(["mx_jalisco", "jalisco"]);
  });

  it("creación y checkout derivan el MISMO slug prefijado", () => {
    // El admin crea con zoneSlugForCountry(nombre); el checkout busca con
    // provinceToZoneSlugCandidates(código). Deben coincidir.
    const created = zoneSlugForCountry("MX", "Jalisco");
    const [checkoutFirst] = provinceToZoneSlugCandidates("MX", "JAL");
    expect(created).toBe(checkoutFirst);
  });

  it("CO creación sin prefijo", () => {
    expect(zoneSlugForCountry("CO", "Antioquia")).toBe("antioquia");
  });
});

describe("defaultZoneSlugFor — sin fuga entre países", () => {
  it("destino = país de la tienda → _default legacy", () => {
    expect(defaultZoneSlugFor("CO", "CO")).toBe("_default");
  });

  it("destino distinto → default propio del país", () => {
    expect(defaultZoneSlugFor("MX", "CO")).toBe("_default_mx");
  });

  it("defaults sanos con valores vacíos", () => {
    expect(defaultZoneSlugFor(null, null)).toBe("_default");
  });
});

describe("toCarrierTotalPrice", () => {
  it("unidades mayores → centésimas (string)", () => {
    expect(toCarrierTotalPrice(12000)).toBe("1200000"); // COP 12.000
    expect(toCarrierTotalPrice(12.99)).toBe("1299"); // USD 12.99
    expect(toCarrierTotalPrice(0)).toBe("0");
  });
});
