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
  // authenticate.webhook() throws a 401 Response when the HMAC digest is
  // invalid. That rejection MUST propagate — Shopify's "verify webhooks with
  // HMAC signatures" check sends a request with a bad digest and expects HTTP
  // 401. Wrapping this in a catch that swallows the Response and returns 200
  // fails that check. So: only the auth step decides the HTTP status; the
  // payload processing below has its own catch so a DB error never turns a
  // legitimately-authenticated webhook into a non-200 (which would make
  // Shopify retry indefinitely).
  let shop, topic;
  try {
    ({ shop, topic } = await authenticate.webhook(request));
  } catch (e) {
    if (e instanceof Response) throw e; // 401 from invalid HMAC — must reach Shopify
    logError("[compliance] Webhook authentication error:", e?.message || e);
    throw new Response("Unauthorized", { status: 401 });
  }

  info(`[compliance] Received ${topic} webhook for ${shop}`);

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
        info(`[compliance] customers/data_request for ${shop} — no customer data stored`);
        break;

      case "CUSTOMERS_REDACT":
        info(`[compliance] customers/redact for ${shop} — no customer data to delete`);
        break;

      case "SHOP_REDACT": {
        info(`[compliance] shop/redact for ${shop} — deleting all shop data`);
        // Las tarifas se borran en cascada con las zonas (onDelete: Cascade)
        const deletedZones = await db.shippingZone.deleteMany({ where: { shop } });
        const deletedSessions = await db.session.deleteMany({ where: { shop } });
        const deletedAppShop = await db.appShop.deleteMany({ where: { shop } });
        info(
          `[compliance] shop/redact for ${shop} — deleted ${deletedZones.count} zones, ${deletedSessions.count} sessions, ${deletedAppShop.count} app_shop row(s)`,
        );
        break;
      }

      default:
        info(`[compliance] Unhandled compliance topic: ${topic} for ${shop}`);
    }
  } catch (e) {
    logError(`[compliance] processing error for ${topic} ${shop}:`, e?.message || e);
  }

  return new Response();
};
