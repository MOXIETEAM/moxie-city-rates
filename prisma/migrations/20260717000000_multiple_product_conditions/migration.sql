-- Multiple product conditions per shipping rate. Existing rates keep using
-- the legacy productField/productMatchMode/productTags columns until saved.

ALTER TABLE "ShippingRate" ADD COLUMN "productConditions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ShippingRate" ADD COLUMN "productConditionLogic" TEXT NOT NULL DEFAULT 'and';
