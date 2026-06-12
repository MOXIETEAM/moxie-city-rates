import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { error as logError } from "./utils/logger.server";

export const streamTimeout = 5000;

/**
 * Errores no manejados de loaders/actions a nivel framework. Sin esto, un 500
 * del framework (ej. fallo en session storage durante el install) muere
 * silencioso: no pasa por nuestro logger y Sentry nunca se entera.
 */
export function handleError(error, { request }) {
  if (request.signal.aborted) return; // cliente canceló — ruido, no error
  logError("[entry.server] Unhandled route error:", error);
}

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logError(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
