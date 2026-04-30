-- AlterTable
ALTER TABLE "ShippingZone" ADD COLUMN     "enabledServices" TEXT NOT NULL DEFAULT '["mox_envio","mox_express","mox_pickup"]';
