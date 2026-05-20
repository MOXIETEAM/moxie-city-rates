import { useLoaderData } from "react-router";
import { getLegalBrand, LEGAL_STYLES } from "../utils/legal-brand.server";

export const loader = async () => {
  return { brand: getLegalBrand() };
};

export const meta = ({ data }) => {
  const name = data?.brand?.appName || "Shopify App";
  return [
    { title: `Terms of Service | ${name}` },
    { name: "description", content: `Terms of Service for ${name}.` },
  ];
};

export default function Terms() {
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
          <h1>Terms of Service – {brand.appName}</h1>
          <p>
            These terms describe merchant responsibilities, service scope, and
            billing conditions for {brand.appName}.
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
            <h2>1. Overview</h2>
            <p>
              {brand.appName} ("the App") is a Shopify application developed by{" "}
              {brand.company} ("we", "us", or "our") that provides a carrier
              service to calculate shipping rates at checkout based on
              department, city, schedule, weight, cart total, and product
              attributes.
            </p>
            <p>
              By installing or using the App, you agree to be bound by these
              Terms of Service ("Terms").
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>2. Use of the App</h2>
            <p>
              You agree to use {brand.appName} only for lawful purposes and in
              accordance with these Terms.
            </p>
            <p>You may not:</p>
            <ul>
              <li>Use the App in any way that violates applicable laws or regulations</li>
              <li>Interfere with or disrupt the App's functionality</li>
              <li>Attempt to gain unauthorized access to any part of the App</li>
            </ul>
            <p>We reserve the right to suspend or terminate access if misuse is detected.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>3. Shopify Integration</h2>
            <p>
              {brand.appName} integrates with Shopify and requires access to
              certain store data through Shopify's API, including shipping
              settings, locations, and product metadata.
            </p>
            <p>By using the App, you acknowledge that:</p>
            <ul>
              <li>You have authorized access to your Shopify store</li>
              <li>The App will process store data solely to provide its functionality</li>
              <li>Your use of Shopify is also subject to Shopify's terms and policies</li>
              <li>The App requires a Shopify plan that supports third-party carrier services</li>
            </ul>
          </section>

          <section className="moxie-legal-section">
            <h2>4. Subscription &amp; Billing</h2>
            <p>{brand.appName} operates on a subscription model with Free and Pro tiers.</p>
            <ul>
              <li>Charges are billed through Shopify Billing</li>
              <li>Billing cycles are recurring (monthly)</li>
              <li>Fees are non-refundable unless required by law</li>
              <li>Plan limits (zones, rates, advanced pricing) are enforced server-side</li>
            </ul>
            <p>We reserve the right to modify pricing at any time, with notice provided where applicable.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>5. Data &amp; Privacy</h2>
            <p>Your use of the App is also governed by our Privacy Policy.</p>
            <ul>
              <li>We only access data necessary to provide the service</li>
              <li>We do not sell or misuse your data</li>
              <li>We do not store customer personal information</li>
            </ul>
            <p>For full details, please review our <a href="/privacy">Privacy Policy</a>.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>6. Availability of the Service</h2>
            <p>
              We strive to provide a reliable service, but we do not guarantee that the App will be:
            </p>
            <ul>
              <li>Uninterrupted</li>
              <li>Error-free</li>
              <li>Available at all times</li>
            </ul>
            <p>
              If the carrier service callback fails, Shopify will fall back to
              other available shipping methods. We may perform maintenance,
              updates, or improvements that temporarily affect availability.
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>7. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law:</p>
            <p>{brand.appName} and {brand.company} shall not be liable for:</p>
            <ul>
              <li>Loss of revenue or profits</li>
              <li>Business interruption</li>
              <li>Data loss</li>
              <li>Shipping rates miscalculated due to merchant misconfiguration</li>
              <li>Any indirect or consequential damages</li>
            </ul>
            <p>arising from the use or inability to use the App.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>8. No Warranty</h2>
            <p>
              The App is provided "as is" and "as available" without warranties of any kind.
            </p>
            <p>We do not guarantee that:</p>
            <ul>
              <li>The App will meet all your expectations</li>
              <li>The results will be error-free or accurate in all cases</li>
              <li>Third-party services (Shopify, carriers) will remain compatible</li>
            </ul>
          </section>

          <section className="moxie-legal-section">
            <h2>9. Intellectual Property</h2>
            <p>
              All rights, title, and interest in the App, including its software, design,
              and content, remain the property of {brand.company}.
            </p>
            <p>You may not:</p>
            <ul>
              <li>Copy</li>
              <li>Modify</li>
              <li>Distribute</li>
              <li>Reverse engineer</li>
            </ul>
            <p>any part of the App without prior written consent.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>10. Termination</h2>
            <p>You may stop using the App at any time by uninstalling it from your Shopify store.</p>
            <p>We may terminate or suspend access if:</p>
            <ul>
              <li>You violate these Terms</li>
              <li>Misuse the App</li>
              <li>Required by law</li>
            </ul>
            <p>Upon uninstallation, shop data is deleted within 48 hours per Shopify compliance requirements.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>11. Changes to Terms</h2>
            <p>We may update these Terms from time to time.</p>
            <p>Continued use of the App after changes constitutes acceptance of the updated Terms.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>12. Governing Law</h2>
            <p>These Terms shall be governed by and interpreted in accordance with the laws of Colombia.</p>
          </section>

          <section className="moxie-legal-section">
            <h2>13. Contact Information</h2>
            <p>If you have any questions about these Terms, please contact us:</p>
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
