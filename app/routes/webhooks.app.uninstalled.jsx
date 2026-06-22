import { authenticate } from "../shopify.server";
import db from "../db.server";
import { info, error as logError } from "../utils/logger.server";

export const action = async ({ request }) => {
  // The 401 thrown by authenticate.webhook() on an invalid HMAC must propagate
  // (Shopify's HMAC check expects 401). Only auth sets the HTTP status; DB
  // cleanup below has its own catch so an internal error stays 200.
  let shop, session, topic;
  try {
    ({ shop, session, topic } = await authenticate.webhook(request));
  } catch (e) {
    if (e instanceof Response) throw e; // 401 from invalid HMAC — must reach Shopify
    logError("[uninstall] Webhook authentication error:", e?.message || e);
    throw new Response("Unauthorized", { status: 401 });
  }

  info(`[uninstall] Received ${topic} webhook for ${shop}`);

  try {
    const deletedZones = await db.shippingZone.deleteMany({ where: { shop } });
    const deletedAppShop = await db.appShop.deleteMany({ where: { shop } });
    info(
      `[uninstall] Deleted ${deletedZones.count} zones (rates cascade), ${deletedAppShop.count} app_shop row(s) for ${shop}`,
    );
  } catch (e) {
    logError(`[uninstall] Error deleting shop data for ${shop}:`, e.message);
  }

  if (session) {
    try {
      await db.session.deleteMany({ where: { shop } });
    } catch (e) {
      logError(`[uninstall] Error deleting sessions for ${shop}:`, e.message);
    }
  }

  return new Response();
};
