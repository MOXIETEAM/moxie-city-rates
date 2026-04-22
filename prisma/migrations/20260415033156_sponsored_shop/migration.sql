-- CreateTable
CREATE TABLE "SponsoredShop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
