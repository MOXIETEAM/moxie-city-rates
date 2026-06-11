-- Delivery estimates per rate, in calendar days. Converted to
-- min/max_delivery_date in the carrier service response so Shopify shows
-- "arrives between X and Y" under the rate at checkout. Null = no estimate.

ALTER TABLE "ShippingRate" ADD COLUMN "minDeliveryDays" INTEGER;
ALTER TABLE "ShippingRate" ADD COLUMN "maxDeliveryDays" INTEGER;
