import prisma from "../db.server";

/** Dominio de tienda estable (Shopify usa minúsculas en session.shop). */
export function normalizeShopDomain(shop) {
  return (shop || "").trim().toLowerCase();
}

/**
 * Garantiza una fila por tienda al instalar / reautenticar la app.
 * `sponsoredPro` solo se cambia manualmente en BD (o futura UI interna).
 */
export async function ensureShopRecord(shop) {
  const s = normalizeShopDomain(shop);
  if (!s) return null;
  return prisma.appShop.upsert({
    where: { shop: s },
    create: { shop: s },
    update: {},
  });
}
