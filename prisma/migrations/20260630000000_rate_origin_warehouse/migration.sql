-- Origin warehouse per rate (display/organization only — does NOT affect
-- checkout pricing or Shopify fulfillment routing). NULL = derived
-- automatically from the warehouse whose province matches the zone; a set
-- value is a merchant override pointing at a Shopify Location GID.

ALTER TABLE "ShippingRate" ADD COLUMN "warehouseId" TEXT;
