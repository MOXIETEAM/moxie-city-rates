/**
 * GDPR/Privacy Compliance Webhooks — obligatorios para Shopify App Store.
 *
 * Maneja 3 topics:
 * - customers/data_request: cliente solicita sus datos → esta app no almacena datos de clientes
 * - customers/redact: tienda solicita borrar datos de un cliente → nada que borrar
 * - shop/redact: limpieza total de datos de la tienda (48h después de desinstalar)
 */

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { info, error as logError } from "../utils/logger.server";

export const action = async ({ request }) => {
  try {
    const { shop, topic } = await authenticate.webhook(request);

    info(`[compliance] Received ${topic} webhook for ${shop}`);

    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
        info(`[compliance] customers/data_request for ${shop} — no customer data stored`);
        break;

      case "CUSTOMERS_REDACT":
        info(`[compliance] customers/redact for ${shop} — no customer data to delete`);
        break;

      case "SHOP_REDACT": {
        info(`[compliance] shop/redact for ${shop} — deleting all shop data`);
        try {
          // Las tarifas se borran en cascada con las zonas (onDelete: Cascade)
          const deletedZones = await db.shippingZone.deleteMany({ where: { shop } });
          const deletedSessions = await db.session.deleteMany({ where: { shop } });
          const deletedAppShop = await db.appShop.deleteMany({ where: { shop } });
          info(
            `[compliance] shop/redact for ${shop} — deleted ${deletedZones.count} zones, ${deletedSessions.count} sessions, ${deletedAppShop.count} app_shop row(s)`,
          );
        } catch (e) {
          logError(`[compliance] shop/redact DB error for ${shop}:`, e.message);
        }
        break;
      }

      default:
        info(`[compliance] Unhandled compliance topic: ${topic} for ${shop}`);
    }
  } catch (e) {
    logError("[compliance] Webhook handler error:", e?.message || e);
  }

  return new Response();
};
