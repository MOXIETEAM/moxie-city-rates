import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale");
  const lang = locale?.startsWith("es") ? "es" : "en";
  // Shopify App Bridge requires the api key to be available before any client
  // code runs so it can patch fetch (session tokens, reauthorize headers, billing
  // redirects). Per Shopify docs since 2024-03, the script tag MUST live in the
  // document <head> — loading it from a React component is too late for the
  // first fetch and was the root cause of the billing button "doing nothing".
  return {
    lang,
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { lang, apiKey } = useLoaderData();
  return (
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {apiKey && <meta name="shopify-api-key" content={apiKey} />}
        {apiKey && (
          <script
            src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
            data-api-key={apiKey}
          />
        )}
        <link
          rel="icon"
          type="image/png"
          href="https://www.moxiedigital.co/cdn/shop/files/Favicon_Moxie_Nuevo.png?crop=center&height=32&v=1772566344&width=32"
        />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
