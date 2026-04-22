import en from "../locales/en.json";
import es from "../locales/es.json";

const locales = { en, es };

export function getLocale(shopifyLocale) {
  if (!shopifyLocale) return "es";
  const lang = shopifyLocale.split("-")[0].toLowerCase();
  return lang in locales ? lang : "es";
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj) ?? path;
}

export function t(locale, key, vars) {
  let str = getNestedValue(locales[locale], key) || getNestedValue(locales.es, key) || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

export function createTranslator(locale) {
  return (key, vars) => t(locale, key, vars);
}
