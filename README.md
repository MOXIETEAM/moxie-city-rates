# Fletix

App de Shopify que ofrece un sistema de tarifas de envío configurable por departamento, ciudad, peso, total del carrito y horarios. Funciona como **carrier service** durante el checkout y publica las reglas a un **metafield público** del shop para que cualquier tema pueda consumirlas en el storefront.

## Qué hace

- **Reglas de envío granulares** por departamento + ciudad (modo `all` / `include` / `exclude`).
- **Pricing flexible**: tarifa plana, por peso (tiers), por total del carrito (tiers), y filtros por tags de producto.
- **Horarios**: ventanas de disponibilidad por día de la semana y hora del día.
- **Carrier service** que responde tarifas en tiempo real durante el checkout (<100ms).
- **Validación en checkout** vía Shopify Function: bloquea compras si el item del carrito no es entregable en la dirección final.
- **Metafield público** `fletix.shipping_rules` para que el storefront filtre métodos por ciudad.
- **Calculadora de tarifas** como bloque del tema (PDP) con plan Pro.

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│  Admin UI (React Router)                                 │
│    CRUD de zonas y tarifas                               │
└──────────────────┬───────────────────────────────────────┘
                   │ syncRulesToMetafield
                   ▼
        ┌─────────────────────┐
        │ shop.metafields     │  ← lectura desde cualquier
        │ .fletix             │     theme (PUBLIC_READ)
        │ .shipping_rules     │
        └──────────┬──────────┘
                   │
   ┌───────────────┼─────────────────────────────┐
   │               │                             │
   ▼               ▼                             ▼
┌──────────┐ ┌──────────────────┐ ┌────────────────────────┐
│ Carrier  │ │ Checkout         │ │ Storefront             │
│ Service  │ │ Validation       │ │ (cualquier theme)      │
│ (rates)  │ │ Function (block) │ │ filtrado por reglas    │
└──────────┘ └──────────────────┘ └────────────────────────┘
```

## Stack

- React Router v7 + Vite (admin UI)
- Prisma + SQLite (dev) / Postgres (prod recomendado)
- Shopify Admin API 2025-10
- Shopify Functions (validation), API 2026-04
- Theme App Extension para la calculadora del storefront

## Setup local

```bash
cd mox-parcelify
cp .env.example .env       # completar SHOPIFY_API_KEY/SECRET desde Partner Dashboard
npm install
npm run setup              # prisma generate + migrate
npm run dev --config shopify.app.fletix.toml
```

Seguí el link de "Install your app" que imprime la CLI para instalar Fletix en tu dev store.

## Variables de entorno

Ver `.env.example`. Las críticas:

- `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` — desde Partner Dashboard
- `SHOPIFY_APP_URL` — URL pública del hosting
- `SCOPES=read_shipping,write_shipping,read_products`
- `DATABASE_URL` — Postgres en prod; vacío en dev (usa SQLite)

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo + tunnel |
| `npm run deploy` | Deploya app version + extensions a Shopify |
| `npm run build` | Build de la app React Router |
| `npm run setup` | `prisma generate` + `migrate deploy` |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |

## Estructura

```
mox-parcelify/
├── app/                              React Router app (admin UI)
│   ├── routes/                       Rutas del admin
│   ├── mox-shipping-rules.server.js  Lógica de reglas + sync metafield
│   ├── shopify.server.js             Config del Shopify SDK
│   └── utils/
├── extensions/
│   ├── fletix-checkout-validation/   Shopify Function (bloqueo en checkout)
│   └── fletix-rate-calculator/       Theme app extension (calculadora storefront)
├── prisma/                           Schema y migraciones
└── shopify.app.fletix.toml           Config del app linkeada a Partners
```

## Para merchants

Ver [`GUIA-MERCHANT.md`](./GUIA-MERCHANT.md).

## Pendientes para producción

Ver [`TODO-PRODUCTION-READINESS.md`](./TODO-PRODUCTION-READINESS.md).

## Migración de namespace en curso

Fletix actualmente escribe el metafield al namespace canónico `fletix` y al legacy `mox_store_promise` simultáneamente, para no romper instalaciones del theme de mox-store-promise que aún leen del viejo. Ver [`TODO-NAMESPACE-MIGRATION.md`](./TODO-NAMESPACE-MIGRATION.md) para el plan de remoción del legacy.
