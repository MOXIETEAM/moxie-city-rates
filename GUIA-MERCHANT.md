# Guía de configuración — Delivery Rules (Fletix)

Esta guía explica cómo configurar la app paso a paso desde el admin de tu tienda Shopify.

---

## 1. Instalación

Después de instalar la app desde el Partner Dashboard o el App Store:

1. La app se abre automáticamente en el admin de Shopify.
2. Se registra un **carrier service** (visible en *Settings → Shipping and delivery → Custom rates*).
3. Se crea automáticamente la **metafield definition** `fletix.shipping_rules` con acceso de lectura desde el storefront.
4. Se detectan tus **Locations** (bodegas) de Shopify para derivar la bodega de origen de cada tarifa.

No requiere configuración manual en este paso.

> ⚠️ **Importante**: si tenés tarifas manuales configuradas en *Settings → Shipping and delivery* (o **Local delivery** con radio de envío gratis), Shopify las muestra JUNTO a las de la app. Para que solo salgan las tarifas de la app, eliminá las manuales de la zona y desactivá Local delivery (o dejale un radio mínimo).

---

## 2. Navegación

La página **Reglas de envío** se organiza en 4 pestañas:

| Pestaña | Qué hacés ahí |
|---|---|
| **Zonas** | Ver zonas creadas, agregar departamento, umbral de match de ciudad, guía de nombres |
| **Tarifas** | Buscar/crear/editar tarifas agrupadas por departamento (acordeones) |
| **Consultar** | Simulador de tarifas + log de cotizaciones del checkout real |
| **Carga masiva** | Importar/exportar tarifas por CSV |

---

## 3. Crear zonas de envío

Una **zona** representa un departamento (Colombia) o región. Cada zona puede tener varias **tarifas**.

1. Pestaña **Zonas** → seleccionar país y departamento → **Agregar zona**.
2. Al crear la zona se detectan los servicios disponibles según tus Locations.
3. También podés crear la zona **al vuelo** desde el modal "Nueva tarifa" (ver abajo).

> 💡 **Tarifa por defecto**: existe una zona especial (fallback) que aplica cuando el destino no tiene zona propia, por método de envío. Útil para "envío estándar a todo el país".

> 💡 **Duplicar zona**: dentro del acordeón de una zona (pestaña Tarifas) podés duplicarla hacia otro departamento — copia todas sus tarifas.

---

## 4. Crear tarifas

Desde la pestaña **Tarifas**:

- Botón **Nueva tarifa** → modal de 2 pasos: (1) elegí uno o varios departamentos del catálogo (si la zona no existe se crea sola), (2) completá el formulario. La tarifa se crea en cada departamento elegido.
- Botón **Agregar tarifa** en el header de cada zona → abre el mismo modal directo al paso 2.

Cada tarifa define:

| Campo | Descripción | Ejemplo |
|---|---|---|
| **Nombre** | Lo que ve el cliente en el checkout | "Envío Estándar" |
| **Tipo de servicio** | *Envío estándar*, *Envío express*, *Recoger en tienda* | Envío Estándar |
| **Precio** | En la moneda de la tienda | `12500` |
| **Modo de precio** | `flat`, por peso, por monto del carrito, por ítem | `flat` |
| **Bodega de origen** | A qué Location aplica la tarifa (o "Todas") | Bodega Medellín |
| **Condición de ciudad** | `all`, `include`, `exclude` + alias por ciudad | `include` |
| **Condición de producto** | Por tags, vendor, tipo, colección o SKU | tags: `frozen` |
| **Estimado de entrega** | Min/máx días calendario (visible en checkout) | 2–4 días |
| **Horario** | Ventana horaria + días de la semana | `09:00–18:00`, lun–vie |

### Modos de precio

- **Precio fijo** — precio único.
- **Por peso** — tiers de peso. Ej: 0–5kg = $10K, 5–15kg = $20K. *(Pro)*
- **Por monto del carrito** — tiers por total. Ej: < $200K = $15K, ≥ $200K = gratis. *(Pro)*
- **Por ítem** — primer ítem a precio base + cada ítem adicional a otro precio. Total = base + adicional × (unidades − 1).

### Bodega de origen

- Cada tarifa puede asignarse a una **bodega** (Shopify Location) o a "Todas las bodegas".
- En checkout, cuando Shopify parte el pedido por bodega (multi-location), solo aplican las tarifas de la bodega que despacha + las de "Todas".
- **La app NO decide qué bodega despacha** — eso lo resuelve Shopify según inventario y prioridad de ubicaciones (*Settings → Shipping → Order routing*).
- Red de seguridad: si el filtro por bodega dejara el checkout sin tarifas, la app devuelve las tarifas sin filtrar (nunca bloquea la compra).
- Para multi-bodega real necesitás **inventario rastreado por Location** y stock en cada bodega.

### Habilitar / deshabilitar

Cada tarifa tiene botón **Deshabilitar/Habilitar** — la apaga sin borrarla (no sale en checkout ni en el metafield).

---

## 5. Consultar (simulador + log)

Pestaña **Consultar**:

- **Simulador**: armá un destino (país, departamento, ciudad) + carrito ficticio (peso, total, tags/atributos de producto) y corré el MISMO pipeline del checkout. Muestra las tarifas devueltas, la bodega de origen que resolvería y una tabla con la decisión por regla (por qué aplicó o se descartó).
- **Log de cotizaciones**: cada request real del checkout queda registrado (destino, carrito, decisiones, tarifas devueltas). Sirve para autodiagnosticar "¿por qué no salió mi tarifa?".

---

## 6. Carga masiva (CSV)

Pestaña **Carga masiva** *(Pro)*:

- **Exportar** las reglas actuales, **importar** un CSV, o **descargar plantilla** de ejemplo.
- La guía "¿Cómo llenar el CSV?" documenta todas las columnas. Requeridas: `departamento`, `nombre_tarifa`, `tipo_servicio`, `precio`. Opcionales: ciudades, alias, horarios, tiers, condición de producto, país, **bodega** (nombre de la Location) y **alias_ciudades**.

---

## 7. Sincronización al storefront

Cada vez que guardás una zona o tarifa, la app:

1. Actualiza el metafield `fletix.shipping_rules` (JSON con las reglas activas).
2. *(Transitorio)* También escribe a `mox_store_promise.shipping_rules` para retrocompatibilidad.

Accesible vía Liquid:

```liquid
{{ shop.metafields.fletix.shipping_rules }}
```

---

## 8. Carrier service en checkout

Durante el checkout, Shopify llama al endpoint de la app con la dirección destino, el origen (bodega que despacha) y los items. La app:

1. Resuelve el departamento (código ISO → slug interno).
2. Homologa la ciudad escrita por el cliente (resolver fuzzy + alias, umbral configurable en Zonas).
3. Resuelve la **bodega de origen** por ciudad de la Location.
4. Filtra reglas por: departamento + ciudad + bodega + horario + producto.
5. Si los items tienen `_mox_service_code` (preseleccionado en PDP), filtra por ese método.
6. Devuelve las tarifas con precio según su modo (fijo / peso / monto / por ítem) y estimado de entrega.

---

## 9. Validación de checkout (Shopify Function)

La app incluye una **Validation Function** que bloquea el checkout cuando:

- Un item tiene un service code preseleccionado **no disponible** en la dirección final.
- Un item está marcado para pickup en un departamento distinto al de la dirección.

Para activarla:

1. **Settings → Checkout → Checkout rules → Add rule**.
2. Seleccionar la validación de la app y guardar.

> ⚠️ Las validation functions requieren **activación manual** del merchant.

---

## 10. Calculadora de tarifas en PDP (plan Pro)

Bloque de tema **"Rate Calculator"**: el cliente ingresa departamento + ciudad en la PDP y ve tarifas antes del checkout.

1. **Online Store → Themes → Customize** → agregar el bloque en la PDP.

---

## 11. Plan Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Zonas / tarifas | limitadas | ilimitadas |
| Tarifa plana / por ítem | ✅ | ✅ |
| Carrier service + fuzzy de ciudades | ✅ | ✅ |
| Bodega de origen por tarifa | ✅ | ✅ |
| Metafield público | ✅ | ✅ |
| Tarifas por peso / por carrito | ❌ | ✅ |
| Horarios y días | ❌ | ✅ |
| CSV import/export | ❌ | ✅ |
| Condición de producto | ❌ | ✅ |
| Calculadora PDP | ❌ | ✅ |

Detalles exactos en `app/utils/billing.server.js`.

---

## 12. Troubleshooting

### El carrier no devuelve tarifas en checkout

- Verificá en *Settings → Shipping → Custom rates* que el carrier esté activo.
- Verificá que el destino tenga zona configurada (o una tarifa por defecto).
- Usá la pestaña **Consultar**: simulá el destino y mirá la decisión por regla.
- Si los items tienen `_mox_service_code`, la zona debe tener tarifa con ese método.

### Aparecen tarifas que no configuré (ej. envío gratis)

- Son tarifas **manuales de Shopify** o **Local delivery** — ver sección 1.

### Una tarifa con bodega asignada no sale

- Shopify decidió despachar desde otra bodega (inventario). Revisá *Order routing* y el stock por Location, o poné la tarifa en "Todas las bodegas".

### El storefront no filtra por reglas

- GraphiQL: `query { shop { metafield(namespace: "fletix", key: "shipping_rules") { value } } }`.
- Si está vacío, guardá cualquier tarifa → fuerza sync.

### La validación de checkout no bloquea

- Confirmá la rule en *Settings → Checkout → Checkout rules* (activación manual).

---

## Soporte

Para reportar bugs o pedir features, contactá al equipo.
