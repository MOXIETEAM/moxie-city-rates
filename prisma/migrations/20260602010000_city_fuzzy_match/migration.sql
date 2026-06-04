-- Merchant-tunable fuzzy city homologation.

-- Per-shop similarity threshold (percentage 0-100) for matching a customer
-- city to a configured city/alias at checkout.
ALTER TABLE "AppShop" ADD COLUMN "cityMatchThreshold" INTEGER NOT NULL DEFAULT 85;

-- Per-rate JSON map of canonical city -> list of merchant-defined aliases.
ALTER TABLE "ShippingRate" ADD COLUMN "cityAliases" TEXT NOT NULL DEFAULT '{}';
