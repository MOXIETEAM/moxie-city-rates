/**
 * Variante de marca de la app — única fuente de verdad del check.
 *
 * Valor canónico: "deliveryrules" (marca Delivery Rules — apps pública/custom/demo).
 * Alias legacy:   "cityrates" (deployments existentes con la env vieja; mismo
 *                 comportamiento, mismos nombres de plan "Free"/"Pro").
 * Cualquier otro valor (o vacío): variante legacy Fletix.
 *
 * Isomórfico (server + client): función pura, el caller pasa el valor de su
 * fuente de env (process.env en server, import.meta.env en client) — este
 * módulo no toca `process` para no romper la hidratación del browser.
 */
export function isDeliveryRules(variantValue) {
  return variantValue === "deliveryrules" || variantValue === "cityrates";
}
