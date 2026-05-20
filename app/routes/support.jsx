import { useLoaderData } from "react-router";
import { getLegalBrand } from "../utils/legal-brand.server";
import { LEGAL_STYLES } from "../utils/legal-styles";

export const loader = async () => {
  return { brand: getLegalBrand() };
};

export const meta = ({ data }) => {
  const name = data?.brand?.appName || "Shopify App";
  return [
    { title: `Support | ${name}` },
    { name: "description", content: `Support for ${name}.` },
  ];
};

export default function Support() {
  const { brand } = useLoaderData();
  const formAction = `https://formsubmit.co/${brand.formsubmitHash}`;
  const formNext = `${brand.appUrl}/support`;

  return (
    <main className="moxie-legal-page">
      <style>{LEGAL_STYLES}</style>
      <div className="moxie-legal-shell">
        <header className="moxie-hero">
          <div className="moxie-brand-row">
            <img src={brand.logoUrl} alt={brand.company} />
            <span className="moxie-brand-badge">{brand.appName}</span>
          </div>
          <h1>Support – {brand.appName}</h1>
          <p>
            Get help configuring shipping zones, rates, the carrier service,
            and any other functionality of {brand.appName}.
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
            <h2>1. Support by Plan</h2>
            <p>
              {brand.appName} offers different levels of support depending on
              your subscription plan:
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "12px", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th style={{ padding: "10px 12px", color: "#374151", fontWeight: 700 }}>Plan</th>
                  <th style={{ padding: "10px 12px", color: "#374151", fontWeight: 700 }}>Support Level</th>
                  <th style={{ padding: "10px 12px", color: "#374151", fontWeight: 700 }}>Response Time</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>Free</td>
                  <td style={{ padding: "10px 12px" }}>Email support</td>
                  <td style={{ padding: "10px 12px" }}>Up to 48 business hours</td>
                </tr>
                <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "10px 12px", fontWeight: 600, color: "#16a34a" }}>Pro</td>
                  <td style={{ padding: "10px 12px" }}>Priority email support</td>
                  <td style={{ padding: "10px 12px" }}>Up to 24 business hours</td>
                </tr>
                <tr>
                  <td style={{ padding: "10px 12px", fontWeight: 600, color: "#4434ff" }}>Enterprise</td>
                  <td style={{ padding: "10px 12px" }}>Dedicated support</td>
                  <td style={{ padding: "10px 12px" }}>Up to 12 business hours</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="moxie-legal-section">
            <h2>2. Common Topics We Can Help With</h2>
            <ul>
              <li>Installing the App and registering the carrier service</li>
              <li>Configuring shipping zones by department and city</li>
              <li>Setting up flat, weight-based, or cart-total-based rates</li>
              <li>Schedule and day-of-week conditions</li>
              <li>Product-tag-based shipping rules</li>
              <li>CSV import/export of zones and rates</li>
              <li>Managing billing and switching plans</li>
              <li>Storefront integration with the shipping rules metafield</li>
              <li>Troubleshooting carrier service in checkout</li>
              <li>Multi-location and pickup configuration</li>
            </ul>
          </section>

          <section className="moxie-legal-section">
            <h2>3. Contact Us</h2>
            <p>
              Fill out the form below and we'll get back to you as soon as
              possible. Please include your store domain so we can assist you
              faster.
            </p>
            <form
              action={formAction}
              method="POST"
              style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "16px" }}
            >
              <input type="hidden" name="_subject" value={`${brand.appName} Support Request`} />
              <input type="hidden" name="_captcha" value="false" />
              <input type="hidden" name="_cc" value={brand.contactEmail} />
              <input type="hidden" name="_next" value={formNext} />
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4, display: "block" }}>
                  Store domain *
                </label>
                <input
                  type="text"
                  name="store"
                  placeholder="your-store.myshopify.com"
                  required
                  style={{ padding: "10px 14px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4, display: "block" }}>
                  Email *
                </label>
                <input
                  type="email"
                  name="email"
                  placeholder="you@example.com"
                  required
                  style={{ padding: "10px 14px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4, display: "block" }}>
                  Subject *
                </label>
                <input
                  type="text"
                  name="subject"
                  placeholder="Brief description of your issue"
                  required
                  style={{ padding: "10px 14px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4, display: "block" }}>
                  Message *
                </label>
                <textarea
                  name="message"
                  placeholder="Describe your issue in detail. Include screenshots, browser info, and steps to reproduce if applicable."
                  required
                  rows={5}
                  style={{ padding: "10px 14px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box", resize: "vertical" }}
                />
              </div>
              <button
                type="submit"
                style={{ padding: "12px 24px", background: "#4434ff", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" }}
              >
                Send message
              </button>
            </form>
            <p style={{ marginTop: 20, fontSize: 13, color: "#6b7280" }}>
              You can also reach us directly at{" "}
              <a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>
            </p>
          </section>

          <section className="moxie-legal-section">
            <h2>4. Legal References</h2>
            <p>
              <a href="/privacy">Privacy Policy</a> ·{" "}
              <a href="/terms">Terms of Service</a>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
