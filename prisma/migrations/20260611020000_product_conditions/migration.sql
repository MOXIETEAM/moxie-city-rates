-- Generalized product conditions: match rates by tags, vendor, product type,
-- collection or SKU, with any/all cart matching. Legacy productCondition
-- values (include_tags/exclude_tags) keep working as field="tags", mode="any".

ALTER TABLE "ShippingRate" ADD COLUMN "productField" TEXT NOT NULL DEFAULT 'tags';
ALTER TABLE "ShippingRate" ADD COLUMN "productMatchMode" TEXT NOT NULL DEFAULT 'any';
