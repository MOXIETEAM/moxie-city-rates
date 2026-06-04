-- Internationalization: country-aware zones, shop currency/timezone/country,
-- and decimal-capable rate prices.

-- AppShop: capture shop currency, IANA timezone, and country at install.
ALTER TABLE "AppShop" ADD COLUMN "currency" TEXT;
ALTER TABLE "AppShop" ADD COLUMN "ianaTimezone" TEXT;
ALTER TABLE "AppShop" ADD COLUMN "country" TEXT;

-- ShippingZone: tag each zone with its country. Existing rows are Colombian.
ALTER TABLE "ShippingZone" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'CO';

-- ShippingRate: allow decimal prices for currencies with minor units (USD 12.99).
-- Existing integer COP values are preserved by the widening cast.
ALTER TABLE "ShippingRate" ALTER COLUMN "price" SET DATA TYPE DOUBLE PRECISION;
