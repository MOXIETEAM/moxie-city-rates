/*
  Warnings:

  - You are about to drop the `SponsoredShop` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SponsoredShop";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "AppShop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "sponsoredPro" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
