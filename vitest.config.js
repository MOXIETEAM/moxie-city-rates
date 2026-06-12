import { defineConfig } from "vitest/config";

// Config de vitest independiente del vite.config.js de la app (que carga el
// plugin de React Router y rompe en entorno de test). Los tests cubren las
// funciones PURAS del motor de tarifas — sin DB ni API de Shopify (mocked).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
  },
});
