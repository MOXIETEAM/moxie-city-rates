/**
 * Tests del descubrimiento de campos usados por condiciones de producto.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../app/db.server", () => ({
  default: { shippingRate: { findMany } },
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: {} }));

const {
  getProductConditionFields,
  invalidateProductConditionFields,
  fieldsNeedApiFetch,
} = await import("../app/utils/product-info.server.js");

describe("getProductConditionFields", () => {
  beforeEach(() => {
    findMany.mockReset();
    invalidateProductConditionFields("shop.myshopify.com");
  });

  it("descubre todos los campos de condiciones múltiples", async () => {
    findMany.mockResolvedValue([{
      productField: "tags",
      productConditions: JSON.stringify([
        { field: "vendor", matchMode: "any", values: ["Nike"] },
        { field: "collection", matchMode: "any", values: ["verano"] },
      ]),
    }]);

    const fields = await getProductConditionFields("shop.myshopify.com");

    expect([...fields]).toEqual(["vendor", "collection"]);
    expect(fieldsNeedApiFetch(fields)).toBe(true);
  });

  it("usa el campo legacy cuando no hay condiciones múltiples", async () => {
    findMany.mockResolvedValue([{
      productField: "sku",
      productConditions: "[]",
    }]);

    const fields = await getProductConditionFields("shop.myshopify.com");

    expect([...fields]).toEqual(["sku"]);
    expect(fieldsNeedApiFetch(fields)).toBe(false);
  });

  it("condiciones vacías o JSON inválido caen al campo legacy", async () => {
    findMany.mockResolvedValue([
      {
        productField: "tags",
        productConditions: "[{ \"field\": \"collection\", \"values\": [] }]",
      },
      {
        productField: "sku",
        productConditions: "{not-json",
      },
    ]);

    const fields = await getProductConditionFields("shop.myshopify.com");

    expect([...fields].sort()).toEqual(["sku", "tags"]);
  });
});
