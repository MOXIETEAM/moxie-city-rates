/**
 * Shopify Locations → bodegas de origen (solo lectura).
 *
 * Devuelve las Locations de la tienda como bodegas para MOSTRAR de qué bodega
 * sale cada tarifa en el admin. NO toca el checkout ni el routing de Shopify:
 * la bodega que despacha la decide Shopify (Order Routing + inventario). Esto
 * solo deriva, por ubicación, qué bodega corresponde a cada zona/tarifa.
 *
 * Match zona↔bodega: `provinceSlug` (toSlug de la provincia de la Location)
 * contra `zone.slug` (que también es toSlug del depto) — mismo algoritmo que
 * usa el resto de la app, así un slug nunca diverge entre escritura y lectura.
 *
 * Nunca lanza: ante cualquier error de la API devuelve [] para que la página
 * de tarifas renderice igual (solo sin el tag de bodega).
 */

import { toSlug } from "./geo";
import { warn } from "./logger.server";

/**
 * @returns {Promise<Array<{id:string,name:string,province:string,provinceSlug:string,city:string,isActive:boolean}>>}
 */
export async function getWarehouses(admin) {
  if (!admin) return [];
  try {
    const res = await admin.graphql(`
      query FletixWarehouses {
        locations(first: 100, includeInactive: false) {
          nodes {
            id
            name
            isActive
            address { city province provinceCode zip address1 countryCode }
          }
        }
      }
    `);
    const json = await res.json();
    if (json.errors?.length) {
      warn("[warehouse] GraphQL errors:", json.errors);
      return [];
    }
    const nodes = json.data?.locations?.nodes ?? [];
    return nodes
      .filter((loc) => loc.isActive)
      .map((loc) => {
        const province = loc.address?.province || "";
        return {
          id: loc.id,
          name: loc.name,
          province,
          provinceSlug: toSlug(province),
          city: loc.address?.city || "",
          zip: loc.address?.zip || "",
          address1: loc.address?.address1 || "",
          country: loc.address?.countryCode || "",
          isActive: loc.isActive,
        };
      });
  } catch (e) {
    warn("[warehouse] Falling back to no warehouses:", e?.message || e);
    return [];
  }
}
