/**
 * Tests del motor de tarifas — funciones puras de app/rate-engine.server.js.
 * db.server y shopify.server se mockean: estas funciones no tocan DB ni API.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: {},
  PLAN_FREE: "Free",
  PLAN_PRO: "Pro",
}));

const {
  resolveRatePrice,
  pickBestRate,
  deduplicateBestRates,
  buildCombinedRate,
  analyzeCartMethods,
  calculateCartWeightKg,
  calculateCartTotal,
  detectPickupDeptMismatch,
} = await import("../app/rate-engine.server.js");

const flat = (over = {}) => ({
  id: over.id || "r1",
  name: over.name || "Envío estándar",
  serviceCode: over.serviceCode || "mox_envio",
  price: over.price ?? 12000,
  pricingMode: "flat",
  weightTiers: "[]",
  cartTotalTiers: "[]",
  description: "",
  ...over,
});

describe("resolveRatePrice", () => {
  it("flat devuelve el precio fijo", () => {
    expect(resolveRatePrice(flat({ price: 9000 }), 3, 50000)).toBe(9000);
  });

  it("weight_tiers elige el rango correcto", () => {
    const rate = flat({
      pricingMode: "weight_tiers",
      weightTiers: JSON.stringify([
        { minKg: 0, maxKg: 5, price: 10000 },
        { minKg: 5, maxKg: 15, price: 20000 },
      ]),
    });
    expect(resolveRatePrice(rate, 3, 0)).toBe(10000);
    expect(resolveRatePrice(rate, 5, 0)).toBe(20000); // límite inferior inclusivo
    expect(resolveRatePrice(rate, 99, 0)).toBe(20000); // por encima del último → último
  });

  it("weight_tiers con hueco devuelve null", () => {
    const rate = flat({
      pricingMode: "weight_tiers",
      weightTiers: JSON.stringify([{ minKg: 5, maxKg: 10, price: 20000 }]),
    });
    expect(resolveRatePrice(rate, 2, 0)).toBeNull();
  });

  it("cart_total con maxAmount 0 = sin tope", () => {
    const rate = flat({
      pricingMode: "cart_total",
      cartTotalTiers: JSON.stringify([
        { minAmount: 0, maxAmount: 100000, price: 15000 },
        { minAmount: 100000, maxAmount: 0, price: 0 },
      ]),
    });
    expect(resolveRatePrice(rate, 0, 50000)).toBe(15000);
    expect(resolveRatePrice(rate, 0, 1000000)).toBe(0); // envío gratis sobre 100k
  });

  it("tiers vacíos caen al precio base", () => {
    const rate = flat({ pricingMode: "weight_tiers", weightTiers: "[]", price: 7000 });
    expect(resolveRatePrice(rate, 3, 0)).toBe(7000);
  });
});

describe("pickBestRate", () => {
  it("gana el precio más bajo", () => {
    const best = pickBestRate([flat({ id: "a", price: 15000 }), flat({ id: "b", price: 9000 })], 1, 0);
    expect(best.rate.id).toBe("b");
    expect(best.price).toBe(9000);
  });

  it("ignora rates sin precio aplicable (tier gap)", () => {
    const gap = flat({
      id: "a",
      pricingMode: "weight_tiers",
      weightTiers: JSON.stringify([{ minKg: 50, maxKg: 100, price: 1 }]),
    });
    const best = pickBestRate([gap, flat({ id: "b", price: 9000 })], 1, 0);
    expect(best.rate.id).toBe("b");
  });

  it("null cuando ninguna aplica", () => {
    const gap = flat({
      pricingMode: "weight_tiers",
      weightTiers: JSON.stringify([{ minKg: 50, maxKg: 100, price: 1 }]),
    });
    expect(pickBestRate([gap], 1, 0)).toBeNull();
  });
});

describe("deduplicateBestRates — dedupe por oferta (código + nombre)", () => {
  it("mismo nombre y código: gana la más barata", () => {
    const result = deduplicateBestRates(
      [flat({ id: "a", name: "Envío", price: 15000 }), flat({ id: "b", name: "envío", price: 9000 })],
      1,
      0,
    );
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(9000);
  });

  it("nombres distintos mismo código: ambas ofertas salen", () => {
    const result = deduplicateBestRates(
      [
        flat({ id: "a", name: "Envío normal", price: 12000 }),
        flat({ id: "b", name: "Envío personalizado", price: 20000 }),
      ],
      1,
      0,
    );
    expect(result).toHaveLength(2);
  });

  it("códigos distintos: una por código", () => {
    const result = deduplicateBestRates(
      [flat({ serviceCode: "mox_envio" }), flat({ serviceCode: "mox_express", name: "Express" })],
      1,
      0,
    );
    expect(result).toHaveLength(2);
  });
});

describe("buildCombinedRate — carrito mixto", () => {
  const items = [
    { quantity: 1, properties: { _mox_service_code: "mox_envio" } },
    { quantity: 1, properties: { _mox_service_code: "mox_pickup" } },
  ];

  it("suma envío pero pickup no suma al precio", () => {
    const combined = buildCombinedRate(
      items,
      [
        flat({ serviceCode: "mox_envio", name: "Envío", price: 12000 }),
        flat({ serviceCode: "mox_pickup", name: "Recogida", price: 5000 }),
      ],
      1,
      0,
    );
    expect(combined.price).toBe(12000);
    expect(combined.name).toBe("Envío + Recogida");
    expect(combined.serviceCode).toBe("mox_combined");
  });

  it("método requerido sin rate para el destino → null (checkout bloqueado)", () => {
    const combined = buildCombinedRate(items, [flat({ serviceCode: "mox_envio" })], 1, 0);
    expect(combined).toBeNull();
  });

  it("agrega el estimado de entrega más conservador (sin contar pickup)", () => {
    const combined = buildCombinedRate(
      items,
      [
        flat({ serviceCode: "mox_envio", minDeliveryDays: 2, maxDeliveryDays: 4 }),
        flat({ serviceCode: "mox_pickup", name: "Recogida", minDeliveryDays: 0, maxDeliveryDays: 0 }),
      ],
      1,
      0,
    );
    expect(combined.minDeliveryDays).toBe(2);
    expect(combined.maxDeliveryDays).toBe(4);
  });
});

describe("analyzeCartMethods", () => {
  it("sin propiedades → none", () => {
    expect(analyzeCartMethods([{ quantity: 1 }]).type).toBe("none");
  });

  it("un código → single", () => {
    const r = analyzeCartMethods([{ quantity: 2, properties: { _mox_service_code: "mox_express" } }]);
    expect(r).toMatchObject({ type: "single", code: "mox_express" });
  });

  it("dos códigos → mixed", () => {
    const r = analyzeCartMethods([
      { quantity: 1, properties: { _mox_service_code: "mox_envio" } },
      { quantity: 1, properties: { _mox_service_code: "mox_pickup" } },
    ]);
    expect(r.type).toBe("mixed");
    expect(r.codes.sort()).toEqual(["mox_envio", "mox_pickup"]);
  });

  it("código desconocido se ignora", () => {
    expect(analyzeCartMethods([{ quantity: 1, properties: { _mox_service_code: "otro" } }]).type).toBe("none");
  });
});

describe("totales del carrito", () => {
  it("peso: gramos × cantidad → kg", () => {
    expect(calculateCartWeightKg([{ grams: 500, quantity: 3 }, { grams: 250, quantity: 2 }])).toBe(2);
  });

  it("total: centésimas × cantidad → unidades mayores", () => {
    expect(calculateCartTotal([{ price: 1000000, quantity: 2 }])).toBe(20000);
  });
});

describe("detectPickupDeptMismatch", () => {
  it("pickup en otro depto → devuelve el depto del carrito", () => {
    const items = [{ properties: { _mox_service_code: "mox_pickup", _mox_department: "Antioquia" } }];
    expect(detectPickupDeptMismatch(items, "Cundinamarca")).toBe("Antioquia");
  });

  it("mismo depto (normalizado, con tildes) → null", () => {
    const items = [{ properties: { _mox_service_code: "mox_pickup", _mox_department: "Bogotá D.C." } }];
    expect(detectPickupDeptMismatch(items, "BOGOTA")).toBeNull();
  });

  it("sin pickup → null", () => {
    expect(detectPickupDeptMismatch([{ properties: {} }], "Antioquia")).toBeNull();
  });
});
