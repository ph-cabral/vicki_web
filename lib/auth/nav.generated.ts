// AUTO-GENERADO por scripts/gen-nav.mjs — NO editar a mano.
// Se regenera en cada dev/build. Escanea app/**/page.tsx.
import type { NavNode } from "./modules";

export const GENERATED_CHILDREN: Record<string, NavNode[]> = {
  "calidad": [],
  "compras": [
    {
      "label": "Consumo",
      "href": "/compras/consumo"
    },
    {
      "label": "Faltantes",
      "href": "/compras/faltantes"
    },
    {
      "label": "Planificación",
      "href": "/compras/planificacion"
    },
    {
      "label": "Tarea",
      "href": "/compras/tarea"
    }
  ],
  "deposito": [
    {
      "label": "Embolsado",
      "href": "/deposito/embolsado"
    },
    {
      "label": "Faltantes",
      "href": "/deposito/faltantes",
      "children": [
        {
          "label": "Duplicadas",
          "href": "/deposito/faltantes/duplicadas"
        }
      ]
    },
    {
      "label": "Pedidos",
      "href": "/deposito/pedidos"
    },
    {
      "label": "Picking",
      "href": "/deposito/picking",
      "children": [
        {
          "label": "Picker",
          "href": "/deposito/picking/picker"
        }
      ]
    },
    {
      "label": "Streaming",
      "href": "/deposito/streaming"
    }
  ],
  "fabrica": [
    {
      "label": "Faltantes",
      "href": "/fabrica/faltantes"
    },
    {
      "label": "Manguera",
      "href": "/fabrica/manguera",
      "children": [
        {
          "label": "Corte",
          "href": "/fabrica/manguera/corte"
        }
      ]
    }
  ],
  "finanza": [],
  "mostradores": [
    {
      "label": "Administrar",
      "href": "/mostradores/administrar"
    },
    {
      "label": "Control",
      "href": "/mostradores/control"
    }
  ],
  "rrhh": [
    {
      "label": "Asistencia",
      "href": "/rrhh/asistencia"
    },
    {
      "label": "Legajos",
      "href": "/rrhh/legajos"
    },
    {
      "label": "Premios",
      "href": "/rrhh/premios"
    },
    {
      "label": "Puestos",
      "href": "/rrhh/puestos"
    },
    {
      "label": "Tareas",
      "href": "/rrhh/tareas"
    }
  ],
  "sistema": [
    {
      "label": "Bloqueos",
      "href": "/sistema/bloqueos"
    },
    {
      "label": "Clientes",
      "href": "/sistema/clientes"
    },
    {
      "label": "Edit",
      "href": "/sistema/edit"
    },
    {
      "label": "Sorteo",
      "href": "/sistema/sorteo",
      "children": [
        {
          "label": "Armar",
          "href": "/sistema/sorteo/armar"
        },
        {
          "label": "Teléfono",
          "href": "/sistema/sorteo/telefono"
        }
      ]
    },
    {
      "label": "WMS",
      "href": "/sistema/wms"
    }
  ],
  "ventas": [
    {
      "label": "Faltantes",
      "href": "/ventas/faltantes"
    },
    {
      "label": "Líneas",
      "href": "/ventas/lineas"
    },
    {
      "label": "Presupuestos",
      "href": "/ventas/presupuestos"
    },
    {
      "label": "Vendedor",
      "href": "/ventas/vendedor"
    }
  ],
  "vicki": []
};

export const GENERATED_MODULES: { key: string; label: string; href: string; hasIndex: boolean }[] = [
  {
    "key": "calidad",
    "label": "Calidad",
    "href": "/calidad",
    "hasIndex": true
  },
  {
    "key": "compras",
    "label": "Compras",
    "href": "/compras",
    "hasIndex": true
  },
  {
    "key": "deposito",
    "label": "Depósito",
    "href": "/deposito",
    "hasIndex": true
  },
  {
    "key": "fabrica",
    "label": "Fabrica",
    "href": "/fabrica",
    "hasIndex": false
  },
  {
    "key": "finanza",
    "label": "Finanza",
    "href": "/finanza",
    "hasIndex": true
  },
  {
    "key": "mostradores",
    "label": "Mostradores",
    "href": "/mostradores",
    "hasIndex": false
  },
  {
    "key": "rrhh",
    "label": "RRHH",
    "href": "/rrhh",
    "hasIndex": true
  },
  {
    "key": "sistema",
    "label": "Sistema",
    "href": "/sistema",
    "hasIndex": true
  },
  {
    "key": "ventas",
    "label": "Ventas",
    "href": "/ventas",
    "hasIndex": true
  },
  {
    "key": "vicki",
    "label": "Vicki",
    "href": "/vicki",
    "hasIndex": true
  }
];
