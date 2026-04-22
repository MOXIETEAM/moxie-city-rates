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

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[compliance] Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      console.log(`[compliance] customers/data_request for ${shop} — no customer data stored`);
      break;

    case "CUSTOMERS_REDACT":
      console.log(`[compliance] customers/redact for ${shop} — no customer data to delete`);
      break;

    case "SHOP_REDACT": {
      console.log(`[compliance] shop/redact for ${shop} — deleting all shop data`);
      // Las tarifas se borran en cascada con las zonas (onDelete: Cascade)
      const deletedZones = await db.shippingZone.deleteMany({ where: { shop } });
      const deletedSessions = await db.session.deleteMany({ where: { shop } });
      const deletedAppShop = await db.appShop.deleteMany({ where: { shop } });
      console.log(
        `[compliance] shop/redact for ${shop} — deleted ${deletedZones.count} zones, ${deletedSessions.count} sessions, ${deletedAppShop.count} app_shop row(s)`,
      );
      break;
    }

    default:
      console.log(`[compliance] Unhandled compliance topic: ${topic} for ${shop}`);
  }

  return new Response();
};
