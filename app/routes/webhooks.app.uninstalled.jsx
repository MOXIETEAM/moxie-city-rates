import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`[uninstall] Received ${topic} webhook for ${shop}`);

  try {
    const deletedZones = await db.shippingZone.deleteMany({ where: { shop } });
    const deletedAppShop = await db.appShop.deleteMany({ where: { shop } });
    console.log(
      `[uninstall] Deleted ${deletedZones.count} zones (rates cascade), ${deletedAppShop.count} app_shop row(s) for ${shop}`,
    );
  } catch (e) {
    console.error(`[uninstall] Error deleting shop data for ${shop}:`, e.message);
  }

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
