import crypto from "node:crypto";

/**
 * Valida el callback del Carrier Service de Shopify (body crudo + header X-Shopify-Hmac-Sha256, Base64).
 * @see https://shopify.dev/docs/api/admin-rest/latest/resources/carrierservice
 */
export function verifyCarrierServiceCallbackHmac(rawBody, hmacHeader, apiSecret) {
  if (!apiSecret || typeof rawBody !== "string" || !hmacHeader) {
    return false;
  }
  const digest = crypto.createHmac("sha256", apiSecret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(String(hmacHeader).trim(), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
