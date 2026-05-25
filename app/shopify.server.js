import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureShopRecord } from "./utils/shop-record.server";
import { ensureFletixCarrierService } from "./utils/carrier-service.server";
import { syncRulesToMetafield } from "./mox-shipping-rules.server";
import { warn } from "./utils/logger.server";
import { PLAN_FREE, PLAN_PRO } from "./utils/billing.constants";

export { PLAN_FREE, PLAN_PRO };

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  billing: {
    [PLAN_PRO]: {
      lineItems: [
        {
          amount: 19.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: 7,
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Best-effort shop bootstrap: a transient Prisma failure must not abort
      // install. App Review installs on dev stores and any thrown error here
      // would surface as a broken first-install flow, failing the review.
      try {
        await ensureShopRecord(session.shop);
      } catch (e) {
        warn("[afterAuth] ensureShopRecord:", e?.message || e);
      }
      // Best-effort carrier registration so merchant doesn't need to click a button
      // post-install. Helper never throws — install must succeed even if Shopify
      // rejects the carrier (e.g. shop on plan without third-party carriers).
      await ensureFletixCarrierService(admin, session.shop);
      // Best-effort metafield bootstrap: creates the JSON definition and writes
      // an empty rules payload so the storefront extension and the admin Custom
      // data UI both have a target from day one. Wrapped so install never fails
      // because of metafield issues (e.g. transient GraphQL error).
      try {
        await syncRulesToMetafield(admin, session.shop);
      } catch (e) {
        warn("[afterAuth] syncRulesToMetafield bootstrap:", e?.message || e);
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
