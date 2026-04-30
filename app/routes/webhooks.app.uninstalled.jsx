import { authenticate } from "../shopify.server";
import db from "../db.server";
import { info, error as logError } from "../utils/logger.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

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
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
