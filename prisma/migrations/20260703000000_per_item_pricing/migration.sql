-- Per-item pricing: pricingMode "per_item" cobra `price` por el primer ítem y
-- `perItemPrice` por cada ítem adicional del carrito.

ALTER TABLE "ShippingRate" ADD COLUMN "perItemPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;
