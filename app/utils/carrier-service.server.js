import { isDeliveryRules } from "./variant";
/**
 * Fletix Carrier Service registration.
 *
 * Idempotent: creates Fletix carrier if missing, otherwise updates callbackUrl
 * and reactivates it. Called from `afterAuth` (install / re-auth) and from the
 * admin UI ("Re-register carrier" button) so behavior stays consistent.
 *
 * Returns:
 *   { status: "created" | "updated" | "skipped", id?, errors? }
 *
 * Never throws — failures are logged and surfaced via the return value so
 * callers (especially `afterAuth`) can decide whether to fail the install.
 */

import { debug, error as logError, warn } from "./logger.server";

export const CARRIER_NAME =
  process.env.CARRIER_NAME ||
  (isDeliveryRules(process.env.APP_VARIANT) ? "Delivery Rules" : "Fletix");

// Nombres históricos del carrier en tiendas ya instaladas. El matching debe
// reconocerlos para RENOMBRAR el carrier existente in-place en vez de crear
// uno duplicado (dos carriers activos = tarifas dobles en checkout).
const LEGACY_CARRIER_NAMES = new Set(["City Rates", "Fletix"]);

function buildCallbackUrl(shopDomain) {
  const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST;
  if (!appUrl) {
    throw new Error("SHOPIFY_APP_URL not configured — cannot build carrier callbackUrl");
  }
  return `${appUrl.replace(/\/$/, "")}/api/carrier-service?shop=${encodeURIComponent(shopDomain)}`;
}

export async function ensureFletixCarrierService(admin, shopDomain) {
  if (!admin || !shopDomain) {
    return { status: "skipped", errors: ["missing admin or shop"] };
  }

  let callbackUrl;
  try {
    callbackUrl = buildCallbackUrl(shopDomain);
  } catch (e) {
    logError("[carrier-service] buildCallbackUrl:", e.message);
    return { status: "skipped", errors: [e.message] };
  }

  try {
    const checkRes = await admin.graphql(`
      query { carrierServices(first: 10) { nodes { id name active callbackUrl } } }
    `);
    const checkJson = await checkRes.json();
    const existing = checkJson.data?.carrierServices?.nodes || [];
    // Carrier names are unique per shop ACROSS apps. After a reinstall (or a
    // different client_id like the fletix / cityrates / demo configs) a stale
    // "Fletix" carrier can linger: this app can't UPDATE it ("The carrier or
    // app could not be found.") and can't CREATE one ("Fletix is already
    // configured."). The only escape is to DELETE the stale carrier (works
    // when it's our own orphaned record) and create fresh. A truly foreign
    // carrier (another live app) won't delete — surfaced as a clear error.
    const deleteCarrier = async (id) => {
      try {
        const res = await admin.graphql(
          `mutation carrierServiceDelete($id: ID!) {
            carrierServiceDelete(id: $id) { deletedId userErrors { field message } }
          }`,
          { variables: { id } },
        );
        const json = await res.json();
        const errs = json.data?.carrierServiceDelete?.userErrors || [];
        if (errs.length > 0) {
          warn(`[carrier-service] delete userErrors for ${shopDomain} (${id}):`, errs);
          return false;
        }
        debug(`[carrier-service] ${shopDomain} stale carrier deleted (${id})`);
        return true;
      } catch (e) {
        warn(`[carrier-service] delete threw for ${shopDomain} (${id}):`, e?.message || e);
        return false;
      }
    };

    const rawCreate = async () => {
      const createRes = await admin.graphql(
        `mutation carrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
          carrierServiceCreate(input: $input) {
            carrierService { id name active }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              name: CARRIER_NAME,
              callbackUrl,
              active: true,
              supportsServiceDiscovery: true,
            },
          },
        },
      );
      const createJson = await createRes.json();
      const errs = createJson.data?.carrierServiceCreate?.userErrors || [];
      const id = createJson.data?.carrierServiceCreate?.carrierService?.id;
      return { errs, id };
    };

    // Create, reclaiming the name from a stale carrier once if needed.
    const createCarrier = async () => {
      let { errs, id } = await rawCreate();
      if (errs.length > 0) {
        const nameTaken = errs.some((e) => /already configured|already exists|taken/i.test(e.message || ""));
        if (nameTaken) {
          // Re-query and delete every carrier with our name, then retry once.
          const reRes = await admin.graphql(
            `query { carrierServices(first: 25) { nodes { id name } } }`,
          );
          const reJson = await reRes.json();
          const staleNamed = (reJson.data?.carrierServices?.nodes || []).filter((c) => c.name === CARRIER_NAME);
          let deletedAny = false;
          for (const c of staleNamed) {
            if (await deleteCarrier(c.id)) deletedAny = true;
          }
          if (deletedAny) {
            ({ errs, id } = await rawCreate());
          }
        }
      }
      if (errs.length > 0) {
        // Could not register — foreign carrier owns the name, shop ineligible,
        // or protected carrier. Non-blocking so install continues.
        warn(`[carrier-service] create userErrors for ${shopDomain}:`, errs);
        return {
          status: "skipped",
          errors: errs.map((e) => e.message),
          hint: `A carrier named "${CARRIER_NAME}" exists but this app can't manage it. Remove it from the shop (Settings → Shipping, or via another app/the Shopify admin) and re-register.`,
        };
      }
      debug(`[carrier-service] ${shopDomain} carrier created (${id})`);
      return { status: "created", id };
    };

    // Prefer OUR carrier (callbackUrl on our app host) over a same-named one
    // from another app, so we don't keep churning a foreign record. Carriers
    // con nombre legacy ("City Rates"/"Fletix") y NUESTRO callbackUrl también
    // matchean — se renombran in-place al nombre actual en el update.
    const appBase = (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");
    const isOurs = (c) =>
      c.callbackUrl === callbackUrl || (appBase && (c.callbackUrl || "").startsWith(appBase));
    const named = existing.filter((c) => c.name === CARRIER_NAME);
    const legacyOurs = existing.filter(
      (c) => c.name !== CARRIER_NAME && LEGACY_CARRIER_NAMES.has(c.name) && isOurs(c),
    );
    const fletix =
      named.find((c) => isOurs(c)) ||
      legacyOurs[0] ||
      named[0];

    if (fletix) {
      // Skip update if config already current — avoids extra mutation on every login.
      if (fletix.name === CARRIER_NAME && fletix.callbackUrl === callbackUrl && fletix.active !== false) {
        debug(`[carrier-service] ${shopDomain} carrier already current (${fletix.id})`);
        return { status: "skipped", id: fletix.id };
      }

      const updateRes = await admin.graphql(
        `mutation carrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
          carrierServiceUpdate(input: $input) {
            carrierService { id name active callbackUrl }
            userErrors { field message }
          }
        }`,
        { variables: { input: { id: fletix.id, name: CARRIER_NAME, callbackUrl, active: true } } },
      );
      const updateJson = await updateRes.json();
      const errs = updateJson.data?.carrierServiceUpdate?.userErrors || [];
      if (errs.length > 0) {
        // Stale/orphaned carrier — can't update. Delete it (best effort) and
        // recreate, which also reclaims the unique name.
        warn(`[carrier-service] ${shopDomain} update failed (${fletix.id}), deleting+recreating:`, errs);
        await deleteCarrier(fletix.id);
        return createCarrier();
      }
      debug(`[carrier-service] ${shopDomain} carrier updated (${fletix.id})`);
      return { status: "updated", id: fletix.id };
    }

    return createCarrier();
  } catch (e) {
    logError(`[carrier-service] ensure failed for ${shopDomain}:`, e?.message || e);
    return { status: "skipped", errors: [e?.message || String(e)] };
  }
}
