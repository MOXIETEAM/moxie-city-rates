/**
 * Quote log + simulador de tarifas.
 *
 * - Log: cada request del carrier service (checkout real) queda registrado con
 *   destino, carrito, decisiones por regla y rates devueltas. El merchant se
 *   autodiagnostica "¿por qué no salió mi tarifa?" sin abrir un ticket.
 * - Simulador: arma un destino + carrito ficticio y corre EXACTAMENTE el mismo
 *   pipeline del checkout (app/rate-engine.server.js), mostrando el desglose
 *   de decisiones sin necesidad de un checkout real.
 */

import { useFetcher, useLoaderData, useOutletContext, useRouteError } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createTranslator, getLocale } from "../utils/i18n";
import { getShopMeta } from "../utils/shop-record.server";
import { getQuotes, createQuoteTrace, saveQuote, QUOTE_RETENTION_DAYS } from "../utils/quote-log.server";
import { quoteShipping } from "../rate-engine.server";
import { getCountries, getSubdivisions, formatMoney } from "../utils/geo";
import { error as logError } from "../utils/logger.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
  const onlyEmpty = url.searchParams.get("only_empty") === "1";
  const search = url.searchParams.get("q") || "";

  let quoteData = { total: 0, quotes: [], page: 1, pageSize: 25 };
  try {
    quoteData = await getQuotes(session.shop, { page, onlyEmpty, search });
  } catch (e) {
    logError("[quotes loader] getQuotes failed:", e?.message || e);
  }

  const shopMeta = await getShopMeta(session.shop);

  // Mapa país → subdivisiones para el selector del simulador.
  const countries = getCountries();
  const subdivisionsByCountry = {};
  for (const c of countries) {
    subdivisionsByCountry[c.code] = getSubdivisions(c.code).map((s) => ({ code: s.code, name: s.name }));
  }

  return {
    ...quoteData,
    onlyEmpty,
    search,
    shopCountry: shopMeta.country || "CO",
    shopCurrency: shopMeta.currency || "COP",
    countries,
    subdivisionsByCountry,
    retentionDays: QUOTE_RETENTION_DAYS,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const locale = getLocale(url.searchParams.get("locale"));
  const t = createTranslator(locale);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  if (intent !== "simulate") return { error: "unknown intent" };

  try {
    const shopMeta = await getShopMeta(session.shop);
    const destCountry = String(formData.get("country") || shopMeta.country || "CO");
    const province = String(formData.get("province") || "");
    const city = String(formData.get("city") || "");
    const weightKg = parseFloat(formData.get("weight_kg")) || 0;
    const cartTotal = parseFloat(formData.get("cart_total")) || 0;
    const tagsRaw = String(formData.get("tags") || "");
    const itemTags = tagsRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const vendor = String(formData.get("vendor") || "").trim();
    const sku = String(formData.get("sku") || "").trim();
    const productType = String(formData.get("product_type") || "").trim();
    const collectionsRaw = String(formData.get("collections") || "");
    const collections = collectionsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!province) return { error: t("quotes.sim_province_required") };

    // Carrito sintético equivalente al payload del carrier service: price en
    // centésimas, peso en gramos.
    const items = [
      {
        name: t("quotes.sim_item_name"),
        quantity: 1,
        grams: Math.round(weightKg * 1000),
        price: Math.round(cartTotal * 100),
        properties: {},
      },
    ];

    // Un cartProduct por el item sintético, con los atributos que el merchant
    // escribió — mismo formato que arma el carrier service en checkout real.
    const cartProducts = [{ sku, vendor, productType, tags: itemTags, collections }];

    const trace = createQuoteTrace();
    const result = await quoteShipping({
      shop: session.shop,
      destCountry,
      province,
      city,
      items,
      shopMeta,
      cartProducts,
      trace,
    });

    const rates = result.finalRates.map((entry) => ({
      name: entry.rate ? entry.rate.name : entry.name,
      serviceCode: entry.rate ? entry.rate.serviceCode : entry.serviceCode,
      price: entry.price,
    }));

    // El simulador también queda en el log (source: "simulator") — sin await,
    // el resultado se muestra de inmediato.
    void saveQuote({
      shop: session.shop,
      source: "simulator",
      country: destCountry,
      province,
      city,
      resolvedCity: result.resolvedCity,
      resolveMethod: result.cityResolution.method,
      departmentSlug: result.departmentSlug,
      items,
      cartWeightKg: result.cartWeightKg,
      cartTotal: result.cartTotal,
      currency: shopMeta.currency || "COP",
      trace,
      ratesReturned: rates.map((r) => ({ name: r.name, serviceCode: r.serviceCode, totalPrice: String(Math.round(r.price * 100)), currency: shopMeta.currency || "COP" })),
    });

    return {
      simulation: {
        rates,
        steps: trace.steps,
        decisions: trace.rules,
        departmentName: result.departmentName,
        departmentSlug: result.departmentSlug,
        resolvedCity: result.resolvedCity,
        resolveMethod: result.cityResolution.method,
        pickupMismatch: result.pickupMismatchDept || null,
      },
    };
  } catch (e) {
    logError("[quotes action] simulate failed:", e?.message || e);
    return { error: t("quotes.sim_failed") };
  }
};

// --- Presentación de razones de decisión ---

const REASON_TONES = {
  selected: "success",
  ok: "success",
  lost_price: "info",
  method_not_selected: "info",
  zone_overrides_default: "info",
  tier_gap: "warning",
  service_disabled: "warning",
  city_include: "critical",
  city_exclude: "critical",
  product_include: "critical",
  product_exclude: "critical",
  schedule: "critical",
};

function serviceLabel(t, code) {
  if (code === "mox_envio") return t("shipping.service_standard");
  if (code === "mox_express") return t("shipping.service_express");
  if (code === "mox_pickup") return t("shipping.service_pickup");
  return code;
}

function DecisionsTable({ decisions, t, currency }) {
  if (!decisions?.length) {
    return (
      <s-text variant="bodySm" tone="subdued">{t("quotes.no_decisions")}</s-text>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e3e3e3" }}>
            <th style={{ padding: "6px 8px" }}>{t("quotes.col_rate")}</th>
            <th style={{ padding: "6px 8px" }}>{t("quotes.col_service")}</th>
            <th style={{ padding: "6px 8px" }}>{t("quotes.col_zone")}</th>
            <th style={{ padding: "6px 8px" }}>{t("quotes.col_result")}</th>
            <th style={{ padding: "6px 8px" }}>{t("quotes.col_detail")}</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d, i) => (
            <tr key={`${d.rateId}-${i}`} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: "6px 8px", fontWeight: 600 }}>{d.name}</td>
              <td style={{ padding: "6px 8px" }}>{serviceLabel(t, d.serviceCode)}</td>
              <td style={{ padding: "6px 8px" }}>{d.zone === "_default" ? t("quotes.zone_default") : d.zone}</td>
              <td style={{ padding: "6px 8px" }}>
                <s-badge tone={REASON_TONES[d.reason] || undefined}>
                  {t(`quotes.reason_${d.reason}`)}
                </s-badge>
              </td>
              <td style={{ padding: "6px 8px", color: "#666" }}>
                {d.detail || (typeof d.price === "number" ? formatMoney(d.price, currency) : "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatesSummary({ rates, t, currency }) {
  if (!rates?.length) {
    return <s-badge tone="critical">{t("quotes.no_rates_returned")}</s-badge>;
  }
  return (
    <s-stack direction="inline" gap="small-200">
      {rates.map((r, i) => (
        <s-badge key={i} tone="success">
          {r.name}: {formatMoney(typeof r.price === "number" ? r.price : Number(r.totalPrice || 0) / 100, currency)}
        </s-badge>
      ))}
    </s-stack>
  );
}

// --- Simulador ---

function Simulator({ t, countries, subdivisionsByCountry, shopCountry, shopCurrency, locale }) {
  const fetcher = useFetcher();
  const [country, setCountry] = useState(shopCountry);
  const subdivisions = subdivisionsByCountry[country] || [];
  const isLoading = fetcher.state !== "idle";
  const sim = fetcher.data?.simulation;

  return (
    <s-section heading={t("quotes.sim_title")}>
      <s-stack direction="block" gap="base">
        <s-text variant="bodySm" tone="subdued">{t("quotes.sim_desc")}</s-text>

        <fetcher.Form method="post" action={`?locale=${locale}`}>
          <input type="hidden" name="_intent" value="simulate" />
          <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                {t("quotes.sim_country")}
              </label>
              <select
                name="country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", minWidth: 140 }}
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                {t("quotes.sim_province")}
              </label>
              <select
                name="province"
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", minWidth: 180 }}
              >
                {subdivisions.map((s) => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </select>
            </div>
            <s-text-field
              label={t("quotes.sim_city")}
              name="city"
              placeholder={t("quotes.sim_city_placeholder")}
              style={{ minWidth: 160 }}
            />
            <s-text-field
              label={t("quotes.sim_weight")}
              name="weight_kg"
              type="number"
              step="any"
              value="1"
              style={{ maxWidth: 110 }}
            />
            <s-text-field
              label={t("quotes.sim_cart_total", { currency: shopCurrency })}
              name="cart_total"
              type="number"
              step="any"
              value="0"
              style={{ maxWidth: 140 }}
            />
            <s-text-field
              label={t("quotes.sim_tags")}
              name="tags"
              placeholder="fragil, pesado"
              style={{ minWidth: 160 }}
            />
            <s-button type="submit" variant="primary" loading={isLoading}>
              {t("quotes.sim_run")}
            </s-button>
          </s-stack>

          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#666" }}>
              {t("quotes.sim_product_attrs")}
            </summary>
            <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", marginTop: 8 }}>
              <s-text-field label={t("shipping.field_vendor")} name="vendor" style={{ minWidth: 140 }} />
              <s-text-field label={t("shipping.field_sku")} name="sku" style={{ minWidth: 140 }} />
              <s-text-field label={t("shipping.field_product_type")} name="product_type" style={{ minWidth: 140 }} />
              <s-text-field label={t("shipping.field_collection")} name="collections" placeholder="handle-o-titulo, otra" style={{ minWidth: 180 }} />
            </s-stack>
          </details>
        </fetcher.Form>

        {fetcher.data?.error && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fde8e8", border: "1px solid #f5b5b5", fontSize: 13 }}>
            {fetcher.data.error}
          </div>
        )}

        {sim && (
          <div style={{ padding: "14px 16px", borderRadius: 12, background: "#f7f7f8", border: "1px solid #e3e3e3" }}>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <s-text variant="bodySm" tone="subdued">
                  {sim.departmentName} ({sim.departmentSlug})
                  {sim.resolvedCity ? ` · ${t("quotes.resolved_city")}: ${sim.resolvedCity} (${sim.resolveMethod})` : ""}
                </s-text>
                <RatesSummary rates={sim.rates} t={t} currency={shopCurrency} />
              </s-stack>
              {sim.pickupMismatch && (
                <s-badge tone="critical">{t("quotes.pickup_mismatch", { dept: sim.pickupMismatch })}</s-badge>
              )}
              <DecisionsTable decisions={sim.decisions} t={t} currency={shopCurrency} />
            </s-stack>
          </div>
        )}
      </s-stack>
    </s-section>
  );
}

// --- Fila del log ---

function QuoteRow({ quote, t, currency, locale }) {
  const decisions = safeParse(quote.decisions, []);
  const rates = safeParse(quote.ratesReturned, []);
  const items = safeParse(quote.items, []);
  const when = new Date(quote.createdAt).toLocaleString(locale === "en" ? "en-US" : "es-CO");

  return (
    <details style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: "10px 14px", background: "#fff" }}>
      <summary style={{ cursor: "pointer", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 13 }}>
        <span style={{ color: "#666", minWidth: 140 }}>{when}</span>
        {quote.source === "simulator" && <s-badge tone="info">{t("quotes.source_simulator")}</s-badge>}
        <span style={{ fontWeight: 600 }}>
          {quote.country} / {quote.departmentSlug || quote.province}
          {quote.city ? ` / ${quote.city}` : ""}
        </span>
        {quote.resolvedCity && quote.resolvedCity !== quote.city && (
          <span style={{ color: "#666" }}>→ {quote.resolvedCity} ({quote.resolveMethod})</span>
        )}
        <span style={{ color: "#666" }}>
          {t("quotes.row_summary", { items: quote.itemCount, kg: quote.cartWeightKg.toFixed(1) })} · {formatMoney(quote.cartTotal, currency)}
        </span>
        <span style={{ marginLeft: "auto" }}>
          {quote.rateCount > 0
            ? <s-badge tone="success">{t("quotes.rates_count", { n: quote.rateCount })}</s-badge>
            : <s-badge tone="critical">{t("quotes.no_rates_returned")}</s-badge>}
        </span>
      </summary>

      <div style={{ marginTop: 12 }}>
        <s-stack direction="block" gap="base">
          {rates.length > 0 && <RatesSummary rates={rates} t={t} currency={currency} />}
          <DecisionsTable decisions={decisions} t={t} currency={currency} />
          {items.length > 0 && (
            <s-text variant="bodySm" tone="subdued">
              {t("quotes.items_label")}: {items.map((i) => `${i.quantity}× ${i.name || "?"}${i.serviceCode ? ` [${i.serviceCode}]` : ""}`).join(", ")}
            </s-text>
          )}
        </s-stack>
      </div>
    </details>
  );
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json || "");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// --- Página ---

export default function QuotesPage() {
  const {
    quotes, total, page, pageSize, onlyEmpty, search,
    shopCountry, shopCurrency, countries, subdivisionsByCountry, retentionDays,
  } = useLoaderData();
  const { locale } = useOutletContext() || { locale: "es" };
  const t = createTranslator(locale);

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const baseParams = new URLSearchParams();
  baseParams.set("locale", locale);
  if (onlyEmpty) baseParams.set("only_empty", "1");
  if (search) baseParams.set("q", search);

  const pageLink = (p) => {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(p));
    return `/app/quotes?${params.toString()}`;
  };

  return (
    <s-page heading={t("quotes.title")} subtitle={t("quotes.subtitle", { days: retentionDays })}>
      <Simulator
        t={t}
        countries={countries}
        subdivisionsByCountry={subdivisionsByCountry}
        shopCountry={shopCountry}
        shopCurrency={shopCurrency}
        locale={locale}
      />

      <s-section heading={t("quotes.log_title")}>
        <s-stack direction="block" gap="base">
          <form method="get" action="/app/quotes">
            <input type="hidden" name="locale" value={locale} />
            <s-stack direction="inline" gap="base" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
              <s-text-field
                label={t("quotes.filter_search")}
                name="q"
                value={search}
                placeholder={t("quotes.filter_search_placeholder")}
                style={{ minWidth: 220 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, paddingBottom: 8 }}>
                <input type="checkbox" name="only_empty" value="1" defaultChecked={onlyEmpty} />
                {t("quotes.filter_only_empty")}
              </label>
              <s-button type="submit" variant="secondary">{t("quotes.filter_apply")}</s-button>
            </s-stack>
          </form>

          {quotes.length === 0 ? (
            <s-text variant="bodySm" tone="subdued">{t("quotes.empty_log")}</s-text>
          ) : (
            <s-stack direction="block" gap="small-200">
              {quotes.map((q) => (
                <QuoteRow key={q.id} quote={q} t={t} currency={q.currency || shopCurrency} locale={locale} />
              ))}
            </s-stack>
          )}

          {totalPages > 1 && (
            <s-stack direction="inline" gap="base" style={{ alignItems: "center" }}>
              {page > 1 && <a href={pageLink(page - 1)}>{t("quotes.prev_page")}</a>}
              <s-text variant="bodySm" tone="subdued">
                {t("quotes.page_of", { page, total: totalPages })}
              </s-text>
              {page < totalPages && <a href={pageLink(page + 1)}>{t("quotes.next_page")}</a>}
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
