/**
 * Tests de homologación de ciudades — el diferenciador LATAM de la app.
 * Cubre fuzzy (Levenshtein), aliases del merchant y el resolver con catálogo CO.
 */

import { describe, it, expect } from "vitest";
import {
  resolveCity,
  cityMatchScore,
  cityMatchesList,
} from "../app/utils/city-resolver.server.js";

describe("cityMatchScore", () => {
  it("idénticas (con tildes/case) → 1", () => {
    expect(cityMatchScore("medellín", "MEDELLIN")).toBe(1);
  });

  it("typo de una letra → alto pero < 1", () => {
    const s = cityMatchScore("medelin", "MEDELLÍN");
    expect(s).toBeGreaterThan(0.85);
    expect(s).toBeLessThan(1);
  });

  it("ciudades distintas → bajo", () => {
    expect(cityMatchScore("bogota", "medellin")).toBeLessThan(0.5);
  });
});

describe("cityMatchesList", () => {
  const cities = ["MEDELLÍN", "ENVIGADO"];

  it("threshold 1 (default) = solo exacto", () => {
    expect(cityMatchesList("MEDELLIN", cities)).toBe(true);
    expect(cityMatchesList("medelin", cities)).toBe(false);
  });

  it("threshold 0.85 tolera el typo", () => {
    expect(cityMatchesList("medelin", cities, {}, 0.85)).toBe(true);
  });

  it("alias del merchant matchea", () => {
    const aliases = { MEDELLÍN: ["medallo", "medeya"] };
    expect(cityMatchesList("medallo", cities, aliases, 0.85)).toBe(true);
  });

  it("lista vacía nunca matchea", () => {
    expect(cityMatchesList("MEDELLIN", [], {}, 0.5)).toBe(false);
  });
});

describe("resolveCity (catálogo CO)", () => {
  it("exacta con tilde y mayúsculas", () => {
    const r = resolveCity("medellín", "Antioquia", "CO");
    expect(r.resolved).toBe("MEDELLÍN");
    expect(r.method).toBe("exact");
  });

  it("apodo conocido → alias", () => {
    const r = resolveCity("medallo", "Antioquia", "CO");
    expect(r.resolved).toBe("MEDELLÍN");
    expect(r.method).toBe("alias");
  });

  it("typo → fuzzy", () => {
    const r = resolveCity("medelin", "Antioquia", "CO");
    expect(r.resolved).toBe("MEDELLÍN");
    expect(r.method).toBe("fuzzy");
  });

  it("país sin catálogo → passthrough normalizado", () => {
    const r = resolveCity("Guadalajara", "Jalisco", "MX");
    expect(r.method).toBe("none");
    expect(r.resolved).toBe("GUADALAJARA");
  });
});
