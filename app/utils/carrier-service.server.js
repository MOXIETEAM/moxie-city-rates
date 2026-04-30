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

const CARRIER_NAME = "Fletix";

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
    const fletix = existing.find((c) => c.name === CARRIER_NAME);

    if (fletix) {
      // Skip update if config already current — avoids extra mutation on every login.
      if (fletix.callbackUrl === callbackUrl && fletix.active !== false) {
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
        { variables: { input: { id: fletix.id, callbackUrl, active: true } } },
      );
      const updateJson = await updateRes.json();
      const errs = updateJson.data?.carrierServiceUpdate?.userErrors || [];
      if (errs.length > 0) {
        logError(`[carrier-service] update userErrors for ${shopDomain}:`, errs);
        return { status: "skipped", id: fletix.id, errors: errs.map((e) => e.message) };
      }
      debug(`[carrier-service] ${shopDomain} carrier updated (${fletix.id})`);
      return { status: "updated", id: fletix.id };
    }

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
    if (errs.length > 0) {
      // PROTECTED_CARRIER_SERVICE / SHOP_INELIGIBLE → not all stores can register carriers.
      // Log as warn (not blocking) so install continues.
      warn(`[carrier-service] create userErrors for ${shopDomain}:`, errs);
      return { status: "skipped", errors: errs.map((e) => e.message) };
    }
    const id = createJson.data?.carrierServiceCreate?.carrierService?.id;
    debug(`[carrier-service] ${shopDomain} carrier created (${id})`);
    return { status: "created", id };
  } catch (e) {
    logError(`[carrier-service] ensure failed for ${shopDomain}:`, e?.message || e);
    return { status: "skipped", errors: [e?.message || String(e)] };
  }
}
