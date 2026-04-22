(function () {
  "use strict";

  var DEPARTMENTS = {
    "Amazonas": "AMA", "Antioquia": "ANT", "Arauca": "ARA", "Atlántico": "ATL",
    "Bogotá D.C.": "DC", "Bolívar": "BOL", "Boyacá": "BOY", "Caldas": "CAL",
    "Caquetá": "CAQ", "Casanare": "CAS", "Cauca": "CAU", "Cesar": "CES",
    "Chocó": "CHO", "Córdoba": "COR", "Cundinamarca": "CUN", "Guainía": "GUA",
    "Guaviare": "GUV", "Huila": "HUI", "La Guajira": "LAG", "Magdalena": "MAG",
    "Meta": "MET", "Nariño": "NAR", "Norte de Santander": "NSA", "Putumayo": "PUT",
    "Quindío": "QUI", "Risaralda": "RIS", "San Andrés": "SAP", "Santander": "SAN",
    "Sucre": "SUC", "Tolima": "TOL", "Valle del Cauca": "VAC", "Vaupés": "VAU",
    "Vichada": "VID",
  };

  function fetchCart() {
    return fetch("/cart.js")
      .then(function (res) { return res.json(); })
      .then(function (cart) {
        var productIds = {};
        (cart.items || []).forEach(function (item) {
          if (item.product_id) productIds[item.product_id] = true;
        });
        return {
          weight_kg: (cart.total_weight || 0) / 1000,
          cart_total: (cart.total_price || 0) / 100,
          product_ids: Object.keys(productIds),
          item_count: cart.item_count || 0,
        };
      })
      .catch(function () { return null; });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function getTranslations(locale) {
    return locale === "es" ? {
      toggle: "Calcular envío",
      calculate: "Calcular",
      calculating: "Calculando...",
      noRates: "No hay opciones de envío para este destino.",
      free: "Gratis",
      error: "No se pudo calcular. Intenta de nuevo.",
      dept: "Departamento",
      city: "Ciudad",
      deptPh: "Departamento...",
      cityPh: "Ciudad...",
      cartInfo: "{{count}} producto(s) · {{weight}} kg · ${{total}}",
    } : {
      toggle: "Calculate shipping",
      calculate: "Calculate",
      calculating: "Calculating...",
      noRates: "No shipping options for this destination.",
      free: "Free",
      error: "Could not calculate. Try again.",
      dept: "Department",
      city: "City",
      deptPh: "Department...",
      cityPh: "City...",
      cartInfo: "{{count}} item(s) · {{weight}} kg · ${{total}}",
    };
  }

  function buildRatesHtml(data, t) {
    if (!data.rates || data.rates.length === 0) {
      return '<div class="fletix-calc__empty">' + t.noRates + "</div>";
    }

    var html = "";

    if (data.cart && data.cart.weight_kg !== null && data.cart.products > 0) {
      html += '<div class="fletix-calc__cart-info">'
        + escapeHtml(
            t.cartInfo
              .replace("{{count}}", data.cart.products)
              .replace("{{weight}}", (data.cart.weight_kg || 0).toFixed(1))
              .replace("{{total}}", Math.round(data.cart.total || 0).toLocaleString("es-CO"))
          )
        + "</div>";
    }

    data.rates.forEach(function (rate) {
      var cls = "fletix-calc__rate-price";
      var txt = rate.price_formatted;
      if (rate.price === 0) { cls += " fletix-calc__rate-price--free"; txt = t.free; }
      html += '<div class="fletix-calc__rate">'
        + '<div class="fletix-calc__rate-info">'
        + '<span class="fletix-calc__rate-name">' + escapeHtml(rate.name) + "</span>"
        + (rate.description ? '<span class="fletix-calc__rate-desc">' + escapeHtml(rate.description) + "</span>" : "")
        + "</div>"
        + '<span class="' + cls + '">' + escapeHtml(txt) + "</span>"
        + "</div>";
    });
    return html;
  }

  var PROXY_PATH = "/apps/fletix/api/rate-calculator";

  function resolveApiUrl(raw) {
    if (!raw || raw.indexOf("://") !== -1) return PROXY_PATH;
    return raw;
  }

  function doCalculate(el, t) {
    var apiBase = resolveApiUrl(el.getAttribute("data-api-url"));
    var shop = el.getAttribute("data-shop");

    var deptSelect = el.querySelector(".fletix-calc__select");
    var cityInput = el.querySelector(".fletix-calc__input");
    var btn = el.querySelector(".fletix-calc__btn");
    var resultsDiv = el.querySelector(".fletix-calc__results");
    if (!deptSelect || !btn || !resultsDiv) return;

    var province = deptSelect.value;
    var city = cityInput ? cityInput.value.trim() : "";

    if (!province) { deptSelect.focus(); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="fletix-calc__spinner"></span>' + t.calculating;
    resultsDiv.innerHTML = "";

    fetchCart().then(function (cart) {
      var url = apiBase + "?shop=" + encodeURIComponent(shop)
        + "&province=" + encodeURIComponent(province)
        + "&city=" + encodeURIComponent(city);

      if (cart) {
        url += "&weight_kg=" + cart.weight_kg + "&cart_total=" + cart.cart_total;
        if (cart.product_ids.length) url += "&product_ids=" + cart.product_ids.join(",");
      }
      return fetch(url);
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function (result) {
        btn.disabled = false;
        btn.textContent = t.calculate;
        if (result.status === 403 || (result.data && result.data.error === "pro_required")) {
          el.style.display = "none";
          return;
        }
        resultsDiv.innerHTML = buildRatesHtml(result.data, t);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = t.calculate;
        resultsDiv.innerHTML = '<div class="fletix-calc__error">' + t.error + "</div>";
      });
  }

  function populateDeptSelect(select) {
    if (select.options.length > 1) return;
    Object.keys(DEPARTMENTS).sort().forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = DEPARTMENTS[name];
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  function hideIfPlanExcludesCalculator(el) {
    var shop = el.getAttribute("data-shop");
    var apiBase = resolveApiUrl(el.getAttribute("data-api-url"));
    if (!shop) return;
    fetch(apiBase + "?shop=" + encodeURIComponent(shop) + "&plan_check=1")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.storefront_calculator === false) {
          el.style.display = "none";
        }
      })
      .catch(function () {});
  }

  function initCalculator(el) {
    if (el._fletixInit) return;
    el._fletixInit = true;

    hideIfPlanExcludesCalculator(el);

    var locale = el.getAttribute("data-locale") || "es";
    var isEmbed = el.classList.contains("fletix-calc--embed");
    var t = getTranslations(locale);

    var deptSelect = el.querySelector(".fletix-calc__select");
    if (deptSelect) populateDeptSelect(deptSelect);

    if (isEmbed) {
      var toggle = el.querySelector(".fletix-calc__toggle");
      var body = el.querySelector(".fletix-calc__body");
      var icon = el.querySelector(".fletix-calc__toggle-icon");
      if (toggle && body) {
        toggle.addEventListener("click", function () {
          var isOpen = body.classList.toggle("fletix-calc__body--open");
          if (icon) icon.classList.toggle("fletix-calc__toggle-icon--open", isOpen);
        });
      }
    }

    var btn = el.querySelector(".fletix-calc__btn");
    var cityInput = el.querySelector(".fletix-calc__input");

    if (btn) {
      btn.addEventListener("click", function () { doCalculate(el, t); });
    }
    if (cityInput) {
      cityInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doCalculate(el, t); }
      });
    }
  }

  function initAll() {
    document.querySelectorAll("[data-fletix-calculator]").forEach(initCalculator);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  new MutationObserver(initAll).observe(document.body, { childList: true, subtree: true });
})();
