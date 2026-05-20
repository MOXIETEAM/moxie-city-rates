import { useLoaderData } from "react-router";
import { login } from "../shopify.server";

function getBrand() {
  const variant = process.env.APP_VARIANT === "cityrates" ? "cityrates" : "fletix";
  return variant === "cityrates"
    ? { name: "City Rates", initial: "C" }
    : { name: "Fletix", initial: "F" };
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    const body = new URLSearchParams({ shop });
    const postRequest = new Request(url.toString(), {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return login(postRequest);
  }

  const result = await login(request);
  // login() may return a Response (redirect) or null/data. If response, pass through.
  if (result instanceof Response) return result;
  return { brand: getBrand() };
};

export const action = async ({ request }) => {
  return login(request);
};

export default function AuthLogin() {
  const data = useLoaderData();
  const brand = data?.brand || { name: "Fletix", initial: "F" };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        background: "#f6f6f7",
        color: "#202223",
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 16,
          padding: "48px 40px",
          textAlign: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          maxWidth: 380,
          width: "100%",
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: "linear-gradient(135deg, #5c6ac4, #006fbb)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 20px",
            color: "white",
            fontSize: 20,
            fontWeight: 700,
          }}
        >
          {brand.initial}
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>{brand.name}</h1>
        <p style={{ fontSize: 14, color: "#637381", margin: 0 }}>Connecting to your store...</p>
        <div
          style={{
            marginTop: 24,
            width: 32,
            height: 32,
            border: "3px solid #e1e3e5",
            borderTopColor: "#5c6ac4",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
            margin: "24px auto 0",
          }}
        />
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
