/**
 * Shopify Locations → service-code availability per Colombian department.
 *
 * Used at zone creation to pre-populate `enabledServices` so merchants don't
 * have to manually decide which delivery methods make sense for each region.
 *
 * Heuristic (kept simple on purpose — merchant can always override per zone):
 *   - Active Location with `fulfillsOnlineOrders=true` in a province
 *       → enables `mox_envio` and `mox_express` for that province.
 *   - Active Location with `localPickupSettingsV2` configured in a province
 *       → also enables `mox_pickup` for that province.
 *   - Province with no Location → returns the safe default (`mox_envio` only).
 *
 * Never throws — falls back to all-services-enabled on any error so zone
 * creation is never blocked by a Locations API hiccup.
 */

import { warn } from "./logger.server";

const ALL_SERVICES = ["mox_envio", "mox_express", "mox_pickup"];
const DEFAULT_SERVICES = ["mox_envio"];

function toSlug(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Returns map: { provinceSlug → string[] of service codes available }
 * Plus a `default` key with codes available somewhere in the shop (used as
 * fallback for departments without a Location).
 */
export async function getServiceAvailabilityByProvince(admin) {
  if (!admin) return { default: ALL_SERVICES };

  try {
    const res = await admin.graphql(`
      query FletixLocations {
        locations(first: 100, includeInactive: false) {
          nodes {
            id
            name
            isActive
            fulfillsOnlineOrders
            address { province provinceCode }
            localPickupSettingsV2 { instructions }
          }
        }
      }
    `);
    const json = await res.json();
    if (json.errors?.length) {
      warn("[locations] GraphQL errors:", json.errors);
      return { default: ALL_SERVICES };
    }

    const nodes = json.data?.locations?.nodes ?? [];
    const map = {};
    const globalServices = new Set();

    for (const loc of nodes) {
      if (!loc.isActive) continue;
      const province = loc.address?.province;
      if (!province) continue;
      const slug = toSlug(province);
      if (!map[slug]) map[slug] = new Set();

      if (loc.fulfillsOnlineOrders) {
        map[slug].add("mox_envio");
        map[slug].add("mox_express");
        globalServices.add("mox_envio");
        globalServices.add("mox_express");
      }
      if (loc.localPickupSettingsV2) {
        map[slug].add("mox_pickup");
        globalServices.add("mox_pickup");
      }
    }

    const result = Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, [...v]]),
    );
    result.default = globalServices.size > 0 ? [...globalServices] : DEFAULT_SERVICES;
    return result;
  } catch (e) {
    warn("[locations] Falling back to default services:", e?.message || e);
    return { default: ALL_SERVICES };
  }
}

/**
 * Returns the array of service codes that should be pre-enabled for `department`.
 * Department string is matched against `address.province` after slug normalization.
 */
export async function detectEnabledServicesForDepartment(admin, department) {
  if (!department) return DEFAULT_SERVICES;
  const slug = toSlug(department);
  const map = await getServiceAvailabilityByProvince(admin);
  if (map[slug]?.length) return map[slug];
  // No Location matched the department exactly → fall back to whatever services
  // exist anywhere in the shop, so we don't surprise the merchant with an
  // empty zone they can't add rates to.
  return map.default ?? DEFAULT_SERVICES;
}
