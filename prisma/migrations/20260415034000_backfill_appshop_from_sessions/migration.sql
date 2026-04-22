-- Tiendas que ya tenían sesión pero aún no fila en AppShop (previo a afterAuth).
INSERT OR IGNORE INTO "AppShop" ("shop", "sponsoredPro", "createdAt", "updatedAt")
SELECT DISTINCT "shop", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Session"
WHERE "shop" IS NOT NULL AND trim("shop") != '';
