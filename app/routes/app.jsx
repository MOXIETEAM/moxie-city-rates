import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { getLocale, createTranslator } from "../utils/i18n";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const rawLocale = url.searchParams.get("locale");
  const locale = getLocale(rawLocale);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", locale };
};

export default function App() {
  const { apiKey, locale } = useLoaderData();
  const t = createTranslator(locale);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">{t("nav.home")}</s-link>
        <s-link href="/app/shipping-rules">{t("nav.shipping_rules")}</s-link>
        <s-link href="/app/billing">{t("nav.billing")}</s-link>
      </s-app-nav>
      <Outlet context={{ locale }} />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
