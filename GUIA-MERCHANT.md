# Guía de configuración — Fletix

Esta guía explica cómo configurar Fletix paso a paso desde el admin de tu tienda Shopify.

---

## 1. Instalación

Después de instalar Fletix desde el Partner Dashboard o el App Store:

1. La app se abre automáticamente en el admin de Shopify.
2. Fletix registra un **carrier service** llamado "Fletix" (visible en *Settings → Shipping and delivery → Custom rates*).
3. Se crea automáticamente la **metafield definition** `fletix.shipping_rules` con acceso de lectura desde el storefront.

No requiere configuración manual en este paso.

---

## 2. Crear zonas de envío

Una **zona** representa un departamento (en Colombia) o región. Cada zona puede tener varias **tarifas** (rates).

1. En el admin de Fletix, ir a **Reglas de envío**.
2. Click en **Agregar zona** → seleccionar el departamento.
3. La zona queda activa por defecto. Podés desactivarla con el toggle.

> 💡 **Zona `_default`**: Existe una zona especial llamada `_default` que actúa como fallback cuando ninguna zona específica del destino define el método solicitado. Útil para "envío estándar a todo el país".

---

## 3. Crear tarifas dentro de una zona

Cada tarifa define:

| Campo | Descripción | Ejemplo |
|---|---|---|
| **Nombre** | Lo que ve el cliente en el checkout | "Envío Estándar" |
| **Tipo de servicio** | Se elige de un dropdown: *Envío estándar*, *Envío express*, *Recoger en tienda* | Envío Estándar |
| **Precio** | Tarifa fija en COP | `12500` |
| **Modo de precios** | `flat`, `weight`, `cart_total` | `flat` |
| **Condición de ciudad** | `all`, `include`, `exclude` | `include` |
| **Ciudades** | Lista (cuando condición ≠ `all`) | `MEDELLÍN, ENVIGADO, SABANETA` |
| **Condición de productos** | `all`, `include_tags`, `exclude_tags` | `all` |
| **Tags de producto** | Lista (cuando condición ≠ `all`) | `frozen, fresh` |
| **Horario** | `timeFrom` / `timeTo` (24h) y días | `09:00 - 18:00`, lunes a viernes |

### Modos de precios

- **`flat`** — precio único (campo `price`).
- **`weight`** — tarifa por tiers de peso. Ej: 0–5kg = $10K, 5–10kg = $15K.
- **`cart_total`** — tarifa por tiers de total del carrito. Ej: < $50K = $10K, ≥ $50K = gratis.

### Condición de ciudad

- **`all`** — la tarifa aplica a cualquier ciudad del departamento (sin filtrar).
- **`include`** — solo aplica a las ciudades listadas.
- **`exclude`** — aplica a todas las ciudades del departamento **excepto** las listadas.

### Horarios

- **Hora**: `timeFrom` y `timeTo` en formato 24h (ej: `08:00`, `20:00`). Vacío = 24/7.
- **Días**: lista de días de la semana donde aplica. Vacío = todos los días.

> ⚠️ Los horarios se evalúan en zona horaria `America/Bogota`.

---

## 4. Tipos de servicio disponibles

Al crear una tarifa, elegís uno de los tres tipos de servicio predefinidos:

| Tipo | Significado |
|---|---|
| **Envío estándar** | Envío puerta a puerta convencional |
| **Envío express** | Envío rápido (mismo día / siguiente día) |
| **Recoger en tienda** | El cliente retira en una sucursal física |

El **nombre** que pongas en cada tarifa (ej: "Envío Estándar Medellín") es lo que ve el cliente en el checkout. El **tipo de servicio** es una clasificación interna que Fletix usa para agrupar tarifas y para que el theme del storefront filtre productos disponibles por método.

---

## 5. Sincronización al storefront

Cada vez que guardás una zona o tarifa, Fletix:

1. Actualiza el metafield `fletix.shipping_rules` (JSON con todas las reglas activas).
2. *(Transitorio)* También escribe a `mox_store_promise.shipping_rules` para retrocompatibilidad con themes que aún no migraron.

El metafield es **público** para el storefront, accesible vía Liquid:

```liquid
{{ shop.metafields.fletix.shipping_rules }}
```

---

## 6. Carrier service en checkout

Durante el checkout, Shopify llama al endpoint de Fletix con la dirección destino y los items del carrito. Fletix:

1. Resuelve el departamento (código ISO → slug interno).
2. Homologa la ciudad escrita por el cliente contra el catálogo (resolver fuzzy + alias).
3. Filtra reglas activas por: departamento + ciudad + horario + día.
4. Si los items del carrito tienen `_mox_service_code` (preseleccionado en PDP), filtra por ese código. Si no, devuelve todas las tarifas aplicables.
5. Devuelve hasta N tarifas en <100ms.

---

## 7. Validación de checkout (Shopify Function)

Fletix incluye una **Validation Function** que bloquea el checkout cuando:

- Un item del carrito tiene un service code preseleccionado que **no está disponible** en la dirección final.
- Un item está marcado para pickup en un departamento distinto al de la dirección final.

Para activarla:

1. En el admin: **Settings → Checkout → Checkout rules → Add rule**.
2. Seleccionar **"Fletix: Validación de Checkout"**.
3. Guardar.

> ⚠️ Las validation functions de Shopify requieren **activación manual** del merchant — no se prenden solas.

---

## 8. Calculadora de tarifas en PDP (plan Pro)

Fletix incluye un bloque de tema **"Fletix Rate Calculator"** que muestra una calculadora en la PDP donde el cliente puede ingresar departamento + ciudad y ver tarifas disponibles antes de llegar al checkout.

1. En el admin: **Online Store → Themes → Customize**.
2. En la PDP, agregar el bloque "Fletix Rate Calculator".
3. Guardar.

> Requiere plan Pro de Fletix.

---

## 9. Plan Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Zonas configurables | hasta N | ilimitadas |
| Tarifas por zona | hasta M | ilimitadas |
| Tarifa plana | ✅ | ✅ |
| Carrier service en checkout | ✅ | ✅ |
| Resolver fuzzy de ciudades | ✅ | ✅ |
| Metafield público para themes | ✅ | ✅ |
| Calculadora de tarifas en PDP | ❌ | ✅ |
| Tarifas por peso / por carrito | ❌ | ✅ |
| Horarios y días de la semana | ❌ | ✅ |
| Importar tarifas desde CSV | ❌ | ✅ |
| Filtros por tags de producto | ❌ | ✅ |

Detalles exactos en `app/utils/billing.server.js`.

---

## 10. Troubleshooting

### El carrier service no devuelve tarifas en el checkout

- Verificá en *Settings → Shipping → Custom rates* que "Fletix" esté activo.
- Verificá que el departamento del destino tenga al menos una zona configurada en Fletix.
- Si los line items tienen `_mox_service_code`, asegurate de que la zona del destino tenga una tarifa con ese mismo service code.

### El storefront no filtra por reglas

- Verificá que el metafield exista: GraphiQL → `query { shop { metafield(namespace: "fletix", key: "shipping_rules") { value } } }`.
- Si está vacío, abrí cualquier zona en el admin y guardá → fuerza un sync.
- Verificá que el theme lea desde `shop.metafields.fletix.shipping_rules` (o desde `shop.metafields.mox_store_promise.shipping_rules` si aún no migró).

### La validación de checkout no bloquea

- Confirmá que activaste la rule en *Settings → Checkout → Checkout rules*.
- Las validation functions requieren activación manual del merchant.

---

## Soporte

Para reportar bugs o pedir features, abrí un issue en el repositorio o contactá al equipo de Fletix.
