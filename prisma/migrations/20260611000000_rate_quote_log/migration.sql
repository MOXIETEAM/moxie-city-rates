-- Quote log: one row per carrier-service rate request (real checkout or admin
-- simulator). Stores destination, cart snapshot, per-rule match decisions and
-- the rates returned, so merchants can self-diagnose "why didn't my rate show".

-- CreateTable
CREATE TABLE "RateQuote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'checkout',
    "country" TEXT NOT NULL DEFAULT '',
    "province" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "resolvedCity" TEXT NOT NULL DEFAULT '',
    "resolveMethod" TEXT NOT NULL DEFAULT '',
    "departmentSlug" TEXT NOT NULL DEFAULT '',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "cartWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cartTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT '',
    "items" TEXT NOT NULL DEFAULT '[]',
    "decisions" TEXT NOT NULL DEFAULT '[]',
    "steps" TEXT NOT NULL DEFAULT '[]',
    "ratesReturned" TEXT NOT NULL DEFAULT '[]',
    "rateCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateQuote_shop_createdAt_idx" ON "RateQuote"("shop", "createdAt");
