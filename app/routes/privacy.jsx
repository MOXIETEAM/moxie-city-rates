import { useLoaderData } from "react-router";
import { getLegalBrand, LEGAL_STYLES } from "../utils/legal-brand.server";

export const loader = async () => {
  return { brand: getLegalBrand() };
};

export const meta = ({ data }) => {
  const name = data?.brand?.appName || "Shopify App";
  return [
    { title: `Privacy Policy | ${name}` },
    { name: "description", content: `Privacy Policy for ${name}.` },
  ];
};

export default function Privacy() {
  const { brand } = useLoaderData();
  return (
    <main className="moxie-legal-page">
      <style>{LEGAL_STYLES}</style>
      <div className="moxie-legal-shell">
        <header className="moxie-hero">
          <div className="moxie-brand-row">
            <img src={brand.logoUrl} alt={brand.company} />
            <span className="moxie-brand-badge">{brand.appName}</span>
          </div>
          <h1>Privacy Policy – {brand.appName}</h1>
          <p>
            How {brand.appName} collects, uses, and protects information when
            merchants install and use the App.
          </p>
        </header>

        <nav className="moxie-nav" aria-label="Legal pages navigation">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
          <a href="/support">Support</a>
        </nav>

        <div className="moxie-content">
          <p className="moxie-note">Last updated: {brand.lastUpdated}</p>

          <section className="moxie-legal-section">
            <h2>1. Introduction</h2>
            <p>
              {brand.appName} ("the App") is a Shopify application developed by{" "}
              {brand.company} ("we", "us", or "our"). This Privacy Policy
              describes how we collect, use, and protect information when
              merchants install and use our App.
            </p>
            <p>
              By using {brand.appName}, you agree to the collection and use of
              information in accordance with this policy.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>2. Information We Collect</h2>

            <h4>a. Shopify Store Data</h4>
            <p>
              When you install {brand.appName}, we access certain data from your
              Shopify store through Shopify's API, including:
            </p>
            <ul>
              <li>Shipping zones, rates, and carrier service configuration</li>
              <li>Store locations (warehouses, pickup points)</li>
              <li>Product metadata (tags, weight) — only at checkout, not stored</li>
              <li>Shop domain and currency settings</li>
            </ul>
            <p>This data is used strictly to provide the core functionality of the App.</p>

            <h4>b. Checkout Destination Data</h4>
            <p>
              When a customer reaches the shipping step at checkout, Shopify
              sends destination data (country, province/department, city, postal
              code) to our carrier service endpoint to calculate eligible rates.
            </p>
            <p>This information is:</p>
            <ul>
              <li>Used in real time to compute matching shipping rates</li>
              <li>Not stored permanently</li>
              <li>Not linked to customer identity</li>
              <li>Not used for tracking, advertising, or profiling</li>
            </ul>

            <h4>c. Customer Personal Information</h4>
            <p>
              {brand.appName} does <strong>not</strong> collect, store, or
              process customer names, emails, phone numbers, addresses, or
              payment information. The App only operates on aggregated shipping
              configuration owned by the merchant.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>3. How We Use Information</h2>
            <p>We use the collected information to:</p>
            <ul>
              <li>Calculate available shipping rates at checkout</li>
              <li>Apply merchant-defined rules (department, city, schedule, weight, cart total, product tags)</li>
              <li>Register and maintain the Shopify carrier service for the merchant</li>
              <li>Publish public shipping rules metafield consumed by the storefront theme</li>
              <li>Provide and maintain the functionality of the App</li>
            </ul>
            <p>We do NOT use this data for advertising or profiling purposes.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>4. Data Sharing</h2>
            <p>We do not sell, rent, or share your data with third parties.</p>
            <p>We may only share data in the following cases:</p>
            <ul>
              <li>When required by law</li>
              <li>To comply with legal obligations</li>
              <li>To protect the rights and security of our users or our service</li>
            </ul>
          </section>

          <section className="moxie-legal-section">
            <h2>5. Data Retention</h2>
            <p>
              We retain merchant configuration data (shipping zones, rates, plan
              info) only for as long as the App is installed on your store.
            </p>
            <p>
              When the App is uninstalled, we receive a Shopify webhook and
              delete all associated shop data within 48 hours, in accordance
              with Shopify compliance requirements.
            </p>
            <p>
              GDPR compliance webhooks are implemented:
            </p>
            <ul>
              <li><code>customers/data_request</code> — no customer data stored</li>
              <li><code>customers/redact</code> — no customer data to delete</li>
              <li><code>shop/redact</code> — full shop data deletion</li>
            </ul>
          </section>

          <section className="moxie-legal-section">
            <h2>6. Data Security</h2>
            <p>We implement appropriate technical and organizational measures to protect your data:</p>
            <ul>
              <li>TLS encryption for all data in transit</li>
              <li>HMAC verification on all Shopify webhooks and carrier callbacks</li>
              <li>OAuth-scoped access tokens managed via Shopify session storage</li>
              <li>Rate limiting on public endpoints</li>
            </ul>
            <p>
              However, no method of transmission over the internet is 100%
              secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>7. Shopify Compliance</h2>
            <p>
              {brand.appName} operates in accordance with Shopify's API Terms
              and data protection requirements.
            </p>
            <p>
              We only access data that is necessary to deliver the App's
              functionality (shipping, locations, products) and do not use
              Shopify data outside of its intended purpose.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>8. Your Rights</h2>
            <p>Merchants may request:</p>
            <ul>
              <li>Access to their data</li>
              <li>Correction of data</li>
              <li>Deletion of stored data</li>
            </ul>
            <p>
              Requests can be made using the contact information below, or
              fulfilled automatically by uninstalling the App.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>9. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time.</p>
            <p>We encourage you to review this page periodically for any changes.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>10. Contact Us</h2>
            <p>If you have any questions about this Privacy Policy, you can contact us at:</p>
            <p>
              📧 <a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>
              <br />
              🌐 <a href={brand.website} target="_blank" rel="noopener noreferrer">{brand.company}</a>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
