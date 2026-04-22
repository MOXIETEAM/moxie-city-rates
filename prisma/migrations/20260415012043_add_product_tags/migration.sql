-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShippingRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cityCondition" TEXT NOT NULL DEFAULT 'all',
    "cities" TEXT NOT NULL DEFAULT '[]',
    "timeFrom" TEXT,
    "timeTo" TEXT,
    "daysOfWeek" TEXT NOT NULL DEFAULT '[]',
    "productCondition" TEXT NOT NULL DEFAULT 'all',
    "productTags" TEXT NOT NULL DEFAULT '[]',
    "pricingMode" TEXT NOT NULL DEFAULT 'flat',
    "weightTiers" TEXT NOT NULL DEFAULT '[]',
    "cartTotalTiers" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShippingRate_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShippingRate" ("cartTotalTiers", "cities", "cityCondition", "createdAt", "daysOfWeek", "description", "enabled", "id", "name", "price", "pricingMode", "serviceCode", "timeFrom", "timeTo", "updatedAt", "weightTiers", "zoneId") SELECT "cartTotalTiers", "cities", "cityCondition", "createdAt", "daysOfWeek", "description", "enabled", "id", "name", "price", "pricingMode", "serviceCode", "timeFrom", "timeTo", "updatedAt", "weightTiers", "zoneId" FROM "ShippingRate";
DROP TABLE "ShippingRate";
ALTER TABLE "new_ShippingRate" RENAME TO "ShippingRate";
CREATE INDEX "ShippingRate_zoneId_idx" ON "ShippingRate"("zoneId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
