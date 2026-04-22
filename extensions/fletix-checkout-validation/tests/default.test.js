import { describe, it, expect } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

function makeInput({ rules, address, lines }) {
  return {
    cart: {
      lines: lines || [],
      deliveryGroups: address ? [{ deliveryAddress: address }] : [],
    },
    shop: {
      metafield: rules !== undefined ? { value: JSON.stringify(rules) } : null,
    },
  };
}

function makeLine({ serviceCode, department, city, title = "Producto X" }) {
  return {
    id: `gid://shopify/CartLine/${Math.random()}`,
    quantity: 1,
    attribute: serviceCode ? { key: "_mox_service_code", value: serviceCode } : null,
    deptAttribute: department ? { key: "_mox_department", value: department } : null,
    cityAttribute: city ? { key: "_mox_city", value: city } : null,
    merchandise: {
      id: "gid://shopify/ProductVariant/1",
      product: { id: "gid://shopify/Product/1", title },
    },
  };
}

describe("cartValidationsGenerateRun", () => {
  const rulesCO = {
    antioquia: {
      mox_express: [{ condition: "include", cities: ["MEDELLIN", "ENVIGADO"] }],
      mox_envio: [{ condition: "all", cities: [] }],
    },
    bogota_d_c: {
      mox_envio: [{ condition: "all", cities: [] }],
    },
  };

  it("no errores cuando no hay metafield", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: undefined,
      address: { provinceCode: "ANT", city: "Medellín" },
      lines: [makeLine({ serviceCode: "mox_express" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("no errores cuando no hay dirección aún", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: null,
      lines: [makeLine({ serviceCode: "mox_express" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("happy path: express en Medellín con regla que lo permite", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "ANT", city: "Medellín" },
      lines: [makeLine({ serviceCode: "mox_express", title: "Camisa" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("bloquea cuando la ciudad no está en la lista include", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [makeLine({ serviceCode: "mox_express", title: "Camisa" })],
    }));
    expect(result.operations).toHaveLength(1);
    const errors = result.operations[0].validationAdd.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Camisa");
    expect(errors[0].message).toContain("Envío Express");
    expect(errors[0].message).toContain("Turbo");
    expect(errors[0].target).toBe("$.cart");
  });

  it("bloquea cuando el departamento no tiene el método", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "DC", city: "Bogotá" },
      lines: [makeLine({ serviceCode: "mox_express", title: "Camisa" })],
    }));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].validationAdd.errors[0].message).toContain("Envío Express");
  });

  it("pickup: _mox_department igual al destino → no bloquea", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "ANT", city: "Envigado" },
      lines: [makeLine({ serviceCode: "mox_pickup", department: "Antioquia", city: "Medellín" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("pickup: _mox_department diferente al destino → bloquea con mensaje de inconsistencia", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "DC", city: "Bogotá" },
      lines: [makeLine({ serviceCode: "mox_pickup", department: "Antioquia", city: "Medellín", title: "Zapatos" })],
    }));
    expect(result.operations).toHaveLength(1);
    const msg = result.operations[0].validationAdd.errors[0].message;
    expect(msg).toContain("Zapatos");
    expect(msg).toContain("recoger en Antioquia");
    expect(msg).toContain("Bogotá");
  });

  it("pickup sin _mox_department no se valida (no se puede comparar)", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "DC", city: "Bogotá" },
      lines: [makeLine({ serviceCode: "mox_pickup", title: "Item legacy" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("items sin _mox_service_code se ignoran", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [makeLine({ serviceCode: null, title: "Producto legacy" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("carrito mixto: un item válido y uno inválido → emite 1 error", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [
        makeLine({ serviceCode: "mox_envio", title: "Estándar OK" }),
        makeLine({ serviceCode: "mox_express", title: "Express NO" }),
      ],
    }));
    expect(result.operations).toHaveLength(1);
    const errors = result.operations[0].validationAdd.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Express NO");
  });

  it("fail open cuando el provinceCode no está mapeado", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: rulesCO,
      address: { provinceCode: "XX", city: "Nowhere" },
      lines: [makeLine({ serviceCode: "mox_express" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("fail open cuando el metafield no es JSON válido", () => {
    const input = {
      cart: {
        lines: [makeLine({ serviceCode: "mox_express" })],
        deliveryGroups: [{ deliveryAddress: { provinceCode: "ANT", city: "Medellín" } }],
      },
      shop: { metafield: { value: "{not-valid-json" } },
    };
    const result = cartValidationsGenerateRun(input);
    expect(result.operations).toEqual([]);
  });

  it("exclude: ciudad excluida explícitamente bloquea", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: {
        antioquia: {
          mox_envio: [{ condition: "exclude", cities: ["TURBO"] }],
        },
      },
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [makeLine({ serviceCode: "mox_envio", title: "Producto" })],
    }));
    expect(result.operations).toHaveLength(1);
  });

  it("normalización: 'Bogotá D.C.' se compara como 'BOGOTA'", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: {
        bogota_d_c: {
          mox_envio: [{ condition: "include", cities: ["BOGOTA"] }],
        },
      },
      address: { provinceCode: "DC", city: "Bogotá D.C." },
      lines: [makeLine({ serviceCode: "mox_envio" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("departamento sin zona: usa _default si existe", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: {
        _default: {
          mox_envio: [{ condition: "all", cities: [] }],
        },
      },
      address: { provinceCode: "CES", city: "Valledupar" },
      lines: [makeLine({ serviceCode: "mox_envio" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("departamento sin zona: _default no cubre el método → bloquea", () => {
    const result = cartValidationsGenerateRun(makeInput({
      rules: {
        _default: {
          mox_envio: [{ condition: "all", cities: [] }],
        },
      },
      address: { provinceCode: "CES", city: "Valledupar" },
      lines: [makeLine({ serviceCode: "mox_express", title: "Camisa" })],
    }));
    expect(result.operations).toHaveLength(1);
  });

  it("merge por serviceCode: zona define express, _default cubre envío general", () => {
    // Antioquia zone: express solo en Medellín+Envigado. _default: mox_envio all cities.
    // Customer en Turbo con mox_envio → _default cubre (zona no define mox_envio) → no bloquea.
    const rules = {
      antioquia: {
        mox_express: [{ condition: "include", cities: ["MEDELLIN", "ENVIGADO"] }],
      },
      _default: {
        mox_envio: [{ condition: "all", cities: [] }],
      },
    };
    const result = cartValidationsGenerateRun(makeInput({
      rules,
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [makeLine({ serviceCode: "mox_envio", title: "Envío normal" })],
    }));
    expect(result.operations).toEqual([]);
  });

  it("merge por serviceCode: zona define express → _default NO rescata en ciudades fuera", () => {
    // Antioquia zone define express en Medellín+Envigado → Turbo queda sin express
    // aunque _default tenga express. Zone es autoritativa PARA ESE CÓDIGO.
    const rules = {
      antioquia: {
        mox_express: [{ condition: "include", cities: ["MEDELLIN", "ENVIGADO"] }],
      },
      _default: {
        mox_express: [{ condition: "all", cities: [] }],
      },
    };
    const result = cartValidationsGenerateRun(makeInput({
      rules,
      address: { provinceCode: "ANT", city: "Turbo" },
      lines: [makeLine({ serviceCode: "mox_express", title: "Urgente" })],
    }));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].validationAdd.errors[0].message).toContain("Urgente");
  });

  it("depto sin zona: _default cubre envío general → no bloquea", () => {
    const rules = {
      _default: {
        mox_envio: [{ condition: "all", cities: [] }],
      },
    };
    const result = cartValidationsGenerateRun(makeInput({
      rules,
      address: { provinceCode: "CES", city: "Valledupar" },
      lines: [makeLine({ serviceCode: "mox_envio" })],
    }));
    expect(result.operations).toEqual([]);
  });
});
