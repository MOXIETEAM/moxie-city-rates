/**
 * Brand resolution for public legal/support pages.
 * Driven by APP_VARIANT env so the same repo can serve both Fletix (private)
 * and City Rates Custom (public App Store) deployments.
 */

export function getLegalBrand() {
  const isCityRates = process.env.APP_VARIANT === "cityrates";
  return {
    appName: isCityRates ? "City Rates Custom" : "Fletix",
    company: "Moxie",
    contactEmail: "info@moxiedigital.co",
    website: "https://moxiedigital.co",
    logoUrl:
      "https://www.moxiedigital.co/cdn/shop/files/Logo_Moxie_nuevo_banco_con_azul_rey.png?v=1772565807&width=320",
    appUrl:
      process.env.SHOPIFY_APP_URL ||
      (isCityRates
        ? "https://moxie-city-rates-public.onrender.com"
        : "https://moxie-city-rates-test.onrender.com"),
    formsubmitHash: process.env.FORMSUBMIT_HASH || "f8707cd07387279b53c2352ebe26c081",
    lastUpdated: "May 20, 2026",
  };
}

export const LEGAL_STYLES = `
  .moxie-legal-page {
    --mx-bg: #ffffff;
    --mx-card: #ffffff;
    --mx-ink: #10182c;
    --mx-muted: #5a6478;
    --mx-line: #dde2f5;
    --mx-brand-1: #10182c;
    --mx-brand-2: #4434ff;
    --mx-brand-3: #10182c;
    min-height: 100vh;
    background:
      radial-gradient(1200px 500px at 10% -10%, rgba(68, 52, 255, 0.14), transparent 60%),
      radial-gradient(1000px 500px at 100% 0%, rgba(16, 24, 44, 0.1), transparent 60%),
      var(--mx-bg);
    color: var(--mx-ink);
    font-family: "Avenir Next", "Montserrat", "Segoe UI", sans-serif;
  }
  .moxie-legal-shell { width: min(980px, 94vw); margin: 0 auto; padding: 28px 0 40px; }
  .moxie-hero {
    position: relative; overflow: hidden; border-radius: 20px; padding: 26px 26px 24px;
    background: linear-gradient(130deg, var(--mx-brand-3), var(--mx-brand-1) 55%, var(--mx-brand-2));
    color: #fff; box-shadow: 0 20px 40px rgba(16, 24, 44, 0.26); margin-bottom: 18px;
  }
  .moxie-hero::after {
    content: ""; position: absolute; right: -90px; top: -80px; width: 280px; height: 280px;
    border-radius: 50%; background: rgba(255, 255, 255, 0.16);
  }
  .moxie-brand-row {
    position: relative; z-index: 1; display: flex; flex-wrap: wrap;
    align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px;
  }
  .moxie-brand-row img { width: 176px; max-width: 56vw; height: auto; display: block; }
  .moxie-brand-badge {
    border: 1px solid rgba(255, 255, 255, 0.32); background: rgba(255, 255, 255, 0.12);
    border-radius: 999px; padding: 6px 10px; font-size: 12px; letter-spacing: 0.04em;
    text-transform: uppercase; max-width: 100%; white-space: normal; line-height: 1.2;
  }
  .moxie-hero h1 {
    position: relative; z-index: 1; margin: 0; font-size: clamp(26px, 5vw, 36px); line-height: 1.12;
  }
  .moxie-hero p {
    position: relative; z-index: 1; margin: 10px 0 0; max-width: 760px;
    color: rgba(255, 255, 255, 0.88); font-size: 15px;
  }
  .moxie-nav { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .moxie-nav a {
    background: #fff; border: 1px solid var(--mx-line); color: var(--mx-ink);
    text-decoration: none; border-radius: 999px; padding: 8px 12px; font-size: 13px; font-weight: 600;
  }
  .moxie-nav a:hover { border-color: var(--mx-brand-1); color: var(--mx-brand-2); }
  .moxie-content {
    background: var(--mx-card); border: 1px solid var(--mx-line);
    border-radius: 16px; padding: 18px; box-shadow: 0 10px 24px rgba(19, 34, 61, 0.08);
  }
  .moxie-note { margin: 0 0 8px; color: var(--mx-muted); font-size: 13px; }
  .moxie-legal-section {
    border: 1px solid var(--mx-line); background: #fff;
    border-radius: 12px; padding: 16px; margin-bottom: 12px;
  }
  .moxie-legal-section h2 { margin: 0 0 10px; font-size: 18px; color: #4434ff; }
  .moxie-legal-section h4 { margin: 12px 0 6px; font-size: 15px; color: var(--mx-ink); }
  .moxie-legal-section p,
  .moxie-legal-section li { font-size: 14px; color: var(--mx-ink); line-height: 1.65; }
  .moxie-legal-section ul { margin: 0; padding-left: 18px; }
  .moxie-legal-section a { color: #4434ff; font-weight: 600; text-decoration: none; }
  .moxie-legal-section a:hover { text-decoration: underline; }
  @media (max-width: 640px) {
    .moxie-hero { border-radius: 16px; padding: 20px; }
    .moxie-brand-row { align-items: flex-start; justify-content: flex-start; gap: 10px; }
    .moxie-brand-badge { font-size: 11px; }
    .moxie-content { padding: 12px; }
    .moxie-legal-section { padding: 14px; }
  }
`;
