import { authenticate } from "../shopify.server";

/**
 * Comprueba que la petición viene del App Proxy de Shopify (query firmada).
 * @returns {Promise<Response|null>} `null` si la firma es válida; `Response` JSON 401 si no.
 */
export async function verifyAppProxyOrUnauthorized(request, jsonHeaders) {
  try {
    await authenticate.public.appProxy(request);
    return null;
  } catch (err) {
    if (err instanceof Response) {
      return Response.json(
        { error: "invalid_app_proxy_signature" },
        { status: 401, headers: jsonHeaders },
      );
    }
    throw err;
  }
}
