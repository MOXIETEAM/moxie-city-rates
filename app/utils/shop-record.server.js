import prisma from "../db.server";
import { warn } from "./logger.server";

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

/**
 * Captura moneda, timezone y país de la tienda desde la Admin API y los
 * persiste en AppShop. Llamado en afterAuth (install / re-auth) para que el
 * resto de la app (etiquetas de moneda en admin, moneda devuelta a Shopify en
 * checkout, timezone de horarios, país por defecto de zonas) tenga estos datos
 * sin depender de Colombia hardcodeado.
 *
 * Nunca lanza — un fallo transitorio de GraphQL no debe romper el install. La
 * fila ya existe vía ensureShopRecord; acá solo se actualizan los campos.
 */
export async function captureShopMeta(admin, shop) {
  const s = normalizeShopDomain(shop);
  if (!s || !admin) return null;
  try {
    const res = await admin.graphql(`#graphql
      query ShopMetaForI18n {
        shop {
          currencyCode
          ianaTimezone
          billingAddress { countryCodeV2 }
        }
      }
    `);
    const json = await res.json();
    const shopData = json?.data?.shop;
    if (!shopData) {
      warn("[shop-record] captureShopMeta: shop missing in response");
      return null;
    }
    const data = {
      currency: shopData.currencyCode || null,
      ianaTimezone: shopData.ianaTimezone || null,
      country: shopData.billingAddress?.countryCodeV2 || null,
    };
    return prisma.appShop.upsert({
      where: { shop: s },
      create: { shop: s, ...data },
      update: data,
    });
  } catch (e) {
    warn("[shop-record] captureShopMeta:", e?.message || e);
    return null;
  }
}

/**
 * Lee la metadata de la tienda (moneda / timezone / país) con defaults
 * colombianos para filas viejas o cuando la captura falló al instalar.
 */
export async function getShopMeta(shop) {
  const s = normalizeShopDomain(shop);
  const fallback = { currency: "COP", ianaTimezone: "America/Bogota", country: "CO", cityMatchThreshold: 85 };
  if (!s) return fallback;
  try {
    const row = await prisma.appShop.findUnique({
      where: { shop: s },
      select: { currency: true, ianaTimezone: true, country: true, cityMatchThreshold: true },
    });
    if (!row) return fallback;
    return {
      currency: row.currency || fallback.currency,
      ianaTimezone: row.ianaTimezone || fallback.ianaTimezone,
      country: row.country || fallback.country,
      cityMatchThreshold:
        typeof row.cityMatchThreshold === "number" ? row.cityMatchThreshold : fallback.cityMatchThreshold,
    };
  } catch (e) {
    warn("[shop-record] getShopMeta:", e?.message || e);
    return fallback;
  }
}
