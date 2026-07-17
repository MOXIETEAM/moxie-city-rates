/**
 * Tests de condiciones de producto — evaluateProductCondition de
 * app/mox-shipping-rules.server.js (pura; DB y Shopify mockeados).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: {},
  PLAN_FREE: "Free",
  PLAN_PRO: "Pro",
}));

const { evaluateProductCondition } = await import("../app/mox-shipping-rules.server.js");

const rate = (over = {}) => ({
  productCondition: "include",
  productField: "tags",
  productMatchMode: "any",
  productTags: JSON.stringify(["fragil"]),
  ...over,
});

const item = (over = {}) => ({
  sku: "",
  vendor: "",
  productType: "",
  tags: [],
  collections: [],
  ...over,
});

describe("evaluateProductCondition", () => {
  it('condición "all" siempre aplica', () => {
    expect(evaluateProductCondition(rate({ productCondition: "all" }), [item()]).applies).toBe(true);
  });

  it("valores vacíos → condición ignorada (aplica)", () => {
    expect(evaluateProductCondition(rate({ productTags: "[]" }), [item()]).applies).toBe(true);
  });

  it("include + tags: aplica solo si algún item tiene el tag", () => {
    const r = rate();
    expect(evaluateProductCondition(r, [item({ tags: ["fragil"] })]).applies).toBe(true);
    expect(evaluateProductCondition(r, [item({ tags: ["otro"] })]).applies).toBe(false);
  });

  it("exclude + tags: se descarta si algún item tiene el tag", () => {
    const r = rate({ productCondition: "exclude" });
    expect(evaluateProductCondition(r, [item({ tags: ["fragil"] })]).applies).toBe(false);
    expect(evaluateProductCondition(r, [item({ tags: ["otro"] })]).applies).toBe(true);
  });

  it("vendor case-insensitive", () => {
    const r = rate({ productField: "vendor", productTags: JSON.stringify(["nike"]) });
    expect(evaluateProductCondition(r, [item({ vendor: "NIKE" })]).applies).toBe(true);
    expect(evaluateProductCondition(r, [item({ vendor: "Adidas" })]).applies).toBe(false);
  });

  it("sku exacto", () => {
    const r = rate({ productField: "sku", productTags: JSON.stringify(["sku-001"]) });
    expect(evaluateProductCondition(r, [item({ sku: "SKU-001" })]).applies).toBe(true);
    expect(evaluateProductCondition(r, [item({ sku: "SKU-002" })]).applies).toBe(false);
  });

  it("collection matchea por handle o título", () => {
    const r = rate({ productField: "collection", productTags: JSON.stringify(["congelados"]) });
    expect(evaluateProductCondition(r, [item({ collections: ["congelados", "Congelados"] })]).applies).toBe(true);
    expect(evaluateProductCondition(r, [item({ collections: ["ofertas"] })]).applies).toBe(false);
  });

  it("product_type", () => {
    const r = rate({ productField: "product_type", productTags: JSON.stringify(["camisetas"]) });
    expect(evaluateProductCondition(r, [item({ productType: "Camisetas" })]).applies).toBe(true);
  });

  it('modo "all": TODOS los items deben matchear', () => {
    const r = rate({ productMatchMode: "all" });
    const matching = item({ tags: ["fragil"] });
    const notMatching = item({ tags: ["otro"] });
    expect(evaluateProductCondition(r, [matching, matching]).applies).toBe(true);
    expect(evaluateProductCondition(r, [matching, notMatching]).applies).toBe(false);
  });

  it('modo "any": basta un item', () => {
    const r = rate({ productMatchMode: "any" });
    expect(
      evaluateProductCondition(r, [item({ tags: ["otro"] }), item({ tags: ["fragil"] })]).applies,
    ).toBe(true);
  });

  it("combina varias condiciones con Y", () => {
    const r = rate({
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "and" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Nike" }),
    ]).applies).toBe(true);
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Adidas" }),
    ]).applies).toBe(false);
  });

  it("combina varias condiciones con O", () => {
    const r = rate({
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "or" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Nike" }),
    ]).applies).toBe(true);
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Adidas" }),
    ]).applies).toBe(false);
  });

  it("mezcla Y y O de izquierda a derecha", () => {
    // (tags:fragil Y vendor:nike) O sku:sku-001
    const r = rate({
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "and" },
        { field: "sku", matchMode: "any", values: ["sku-001"], join: "or" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Nike", sku: "otro" }),
    ]).applies).toBe(true);
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Adidas", sku: "SKU-001" }),
    ]).applies).toBe(true);
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Adidas", sku: "otro" }),
    ]).applies).toBe(false);
  });

  it("sin join por condición usa productConditionLogic legacy", () => {
    const r = rate({
      productConditionLogic: "or",
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"] },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Nike" }),
    ]).applies).toBe(true);
  });

  it("exclude descarta según el resultado del grupo", () => {
    const r = rate({
      productCondition: "exclude",
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "and" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Nike" }),
    ]).applies).toBe(false);
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Adidas" }),
    ]).applies).toBe(true);
  });

  it("exclude + OR oculta si cualquier condición se cumple", () => {
    const r = rate({
      productCondition: "exclude",
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "or" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Nike" }),
    ]).applies).toBe(false);
    expect(evaluateProductCondition(r, [
      item({ tags: ["otro"], vendor: "Adidas" }),
    ]).applies).toBe(true);
  });

  it("AND con matchMode all exige que todos los items cumplan esa condición", () => {
    const r = rate({
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "all", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "and" },
      ]),
    });
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Adidas" }),
      item({ tags: ["otro"], vendor: "Nike" }),
    ]).applies).toBe(false);
    expect(evaluateProductCondition(r, [
      item({ tags: ["fragil"], vendor: "Adidas" }),
      item({ tags: ["fragil"], vendor: "Nike" }),
    ]).applies).toBe(true);
  });

  it("condiciones mixtas sin cartProducts → fail-open total", () => {
    const r = rate({
      productConditions: JSON.stringify([
        { field: "tags", matchMode: "any", values: ["fragil"] },
        { field: "vendor", matchMode: "any", values: ["nike"], join: "and" },
      ]),
    });
    expect(evaluateProductCondition(r, null, ["fragil"]).applies).toBe(true);
    expect(evaluateProductCondition(
      rate({ ...r, productCondition: "exclude" }),
      null,
      ["fragil"],
    ).applies).toBe(true);
  });

  it("valores legacy include_tags/exclude_tags siguen funcionando", () => {
    const inc = rate({ productCondition: "include_tags" });
    const exc = rate({ productCondition: "exclude_tags" });
    expect(evaluateProductCondition(inc, [item({ tags: ["fragil"] })]).applies).toBe(true);
    expect(evaluateProductCondition(exc, [item({ tags: ["fragil"] })]).applies).toBe(false);
  });

  it("fallback legacy: lista plana de tags (sin cartProducts)", () => {
    const r = rate();
    expect(evaluateProductCondition(r, null, ["fragil"]).applies).toBe(true);
    expect(evaluateProductCondition(r, null, ["otro"]).applies).toBe(false);
  });

  it("sin datos para evaluar → fail open (aplica)", () => {
    expect(evaluateProductCondition(rate(), null, null).applies).toBe(true);
  });
});
