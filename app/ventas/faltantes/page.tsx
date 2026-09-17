"use client";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Loader2, RefreshCw, AlertTriangle, PackageCheck,
  Check, X, Trash2, Copy, Users, Clock, Pin, PinOff,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// /ventas/faltantes — "Tabla 1" (según diagrama del usuario).
//
//   Entra a esta tabla un renglón "sin existencia" (gate de depósito, sin
//   tocarlo) si:
//     · YA tiene fecha de arribo cargada (preparado.faltante_control), o
//     · compras lo marcó "extraordinario" (preparado.faltante_extraordinario,
//       por código de artículo — tabla de COMPRAS, no se toca ni se escribe
//       acá, solo se lee).
//
//   Se agrupa por Cliente + Factura/Pedido (NroPedOrigen — hoy no hay N° de
//   factura real vinculado al pedido en el pipeline). Extraordinarios arriba
//   con fondo rojo, el resto abajo. Sin acordeones.
//
//   Acción (✓ lo quiere / ✗ no lo quiere): CUALQUIERA de las dos respuestas
//   guarda la decisión y RETIRA la fila de esta tabla (optimista).
//
//   Toda la agregación (existencia + fecha de arribo + extraordinario de
//   compras) se resuelve en el backend: GET /api/ventas/faltantes.
//
//   Selector de vista (header): "Sin ingresar" (flipped=false) / "Ingresados"
//   (flipped=true). Se monta SOLO la vista activa. Ingresados = misma lista,
//   filtrada a los que YA tienen fechaArribo (gruposConArribo, vendidoMode).
//   Acción (✓ vendido / ✗ no vendido): cualquiera de las dos respuestas
//   guarda "vendido" en faltante_control y retira la fila (optimista).
//   Acá también vive el botón basurero (violeta): "irrelevante" descarta el
//   renglón sin pasar por vendido/no vendido — guarda irrelevante=true y
//   retira la fila. Solo en "Ingresados", no en la vista default ni en
//   "Listos para vender" (rows→listos, requiere remito de ingreso x OC).
// ──────────────────────────────────────────────────────────────────────────────

interface Item {
  NroPedOrigen: number;
  NroRengOrigen: number;
  CodArticulo: string;
  Nombre: string;
  CantPend: number;
  Cliente: number | string | null;
  ClienteNombre: string | null;
  Vendedor: string | null; // vendedor de la cabecera del pedido (solo se muestra al admin)
  Importe: number;
  Fecha: string | null; // fecha del faltante (snapshot Ven_PedRenPendientes)
  fechaArribo: string | null;
  arriboOC: boolean; // true = fecha derivada de la OC pendiente (no cargada a mano)
  extraordinario: boolean; // leído de preparado.faltante_extraordinario (compras)
  extraordinarioFecha: string | null; // clave (fecha, CodArticulo) para decidir comprar
}

// Forma propia (no extiende Item): "listos" no trae extraordinario/extraordinarioFecha.
interface ItemListo {
  NroPedOrigen: number;
  NroRengOrigen: number;
  CodArticulo: string;
  Nombre: string;
  CantPend: number;
  Cliente: number | string | null;
  ClienteNombre: string | null;
  Vendedor: string | null;
  Importe: number;
  Fecha: string | null;
  fechaArribo: string | null;
  clienteQuiere: boolean | null;
  vendido: boolean | null;
  yaIngreso: boolean; // CodArticulo con remito de ingreso x OC ya concretado
}

const keyOf = (it: { NroPedOrigen: number; NroRengOrigen: number }) =>
  `${it.NroPedOrigen}-${it.NroRengOrigen}`;
const grupoKeyOf = (it: { Cliente: number | string | null; NroPedOrigen: number }) =>
  `${it.Cliente}__${it.NroPedOrigen}`;
const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n || 0);
const fmtAr = (s: string | null) => {
  if (s === "EN_STOCK") return "En stock";
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};

interface Grupo {
  key: string;
  cliente: number | string | null;
  clienteNombre: string | null;
  vendedor: string | null;
  pedido: number;
  items: Item[];
  importe: number;
}

function agrupar(items: Item[]): Grupo[] {
  const m = new Map<string, Grupo>();
  for (const it of items) {
    const k = grupoKeyOf(it);
    let g = m.get(k);
    if (!g) {
      g = {
        key: k,
        cliente: it.Cliente,
        clienteNombre: it.ClienteNombre,
        vendedor: it.Vendedor,
        pedido: it.NroPedOrigen,
        items: [],
        importe: 0,
      };
      m.set(k, g);
    }
    g.items.push(it);
    g.importe += it.Importe || 0;
    if (!g.clienteNombre && it.ClienteNombre) g.clienteNombre = it.ClienteNombre;
    if (!g.vendedor && it.Vendedor) g.vendedor = it.Vendedor;
  }
  return [...m.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((x, y) => y.Importe - x.Importe) }))
    .sort((a, b) => b.importe - a.importe);
}

interface GrupoListo {
  key: string;
  cliente: number | string | null;
  clienteNombre: string | null;
  vendedor: string | null;
  pedido: number;
  items: ItemListo[];
  importe: number;
}

function agruparListos(items: ItemListo[]): GrupoListo[] {
  const m = new Map<string, GrupoListo>();
  for (const it of items) {
    const k = grupoKeyOf(it);
    let g = m.get(k);
    if (!g) {
      g = {
        key: k,
        cliente: it.Cliente,
        clienteNombre: it.ClienteNombre,
        vendedor: it.Vendedor,
        pedido: it.NroPedOrigen,
        items: [],
        importe: 0,
      };
      m.set(k, g);
    }
    g.items.push(it);
    g.importe += it.Importe || 0;
    if (!g.clienteNombre && it.ClienteNombre) g.clienteNombre = it.ClienteNombre;
    if (!g.vendedor && it.Vendedor) g.vendedor = it.Vendedor;
  }
  return [...m.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((x, y) => y.Importe - x.Importe) }))
    .sort((a, b) => b.importe - a.importe);
}

// Opción del filtro de vendedor del header (solo admin) — misma lista y mismo
// endpoint que /ventas/vendedor: /api/ventas/vendedor/vendedores.
interface VendedorOpcion {
  codigo: number;
  nombre: string | null;
}

export default function VentasFaltantesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [listos, setListos] = useState<ItemListo[]>([]);
  const [fecha, setFecha] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false); // header: foco solo extraordinarios
  // Modo de la vista, lo decide el backend con la sesión (nunca el navegador):
  // admin = todo + contadores + N° de pedido; vendedor = solo sus clientes,
  // encabezado limpio. Arranca en admin para no parpadear con la vista
  // recortada mientras carga.
  const [esAdmin, setEsAdmin] = useState(true);
  const [sinVendedor, setSinVendedor] = useState(false);
  // ── Filtro de vendedor (solo ADMIN) ──────────────────────────────────────
  // Mismo criterio y mismo endpoint que el selector de /ventas/vendedor: las
  // personas habilitadas en Magnus que además tienen usuario activo con legajo
  // ACTIVO (lib/ventas/vendedoresActivos.ts). La ruta es admin-only, así que un
  // 403 simplemente deja la vista sin filtro. "" = todos.
  const [vendedores, setVendedores] = useState<VendedorOpcion[]>([]);
  const [vendedorSel, setVendedorSel] = useState("");
  const [leaving, setLeaving] = useState<Record<string, "left" | "right">>({}); // filas saliendo (animación)

  // Fijar cliente ("clip"): mientras se van marcando eliminar/duplicado en un
  // cliente, el grupo bajaría de lugar en el instante (la lista se reordena
  // por importe, que va bajando a medida que se sacan renglones) obligando a
  // buscarlo de nuevo con scroll para seguir marcando el resto. Al fijarlo se
  // congela la CLAVE de orden (el importe que tenía en ese momento), así el
  // grupo no se mueve aunque su importe real baje. Se guarda por g.key
  // (Cliente+Pedido), sobrevive a los refresh (misma clave) y se suelta con
  // el mismo botón: ahí sí vuelve a ordenarse por su importe actual, como
  // el resto. Si el cliente termina sin renglones, desaparece de la lista
  // (y con él el botón) sin que haga falta limpiar nada a mano; la entrada
  // vieja se poda cuando ya no hay ningún renglón con esa clave (ver abajo).
  const [pinnedImporte, setPinnedImporte] = useState<Record<string, number>>({});
  const togglePin = useCallback((key: string, importeActual: number) => {
    setPinnedImporte((m) => {
      if (key in m) {
        const { [key]: _quitado, ...resto } = m;
        return resto;
      }
      return { ...m, [key]: importeActual };
    });
  }, []);
  // Orden a aplicar sobre un `agrupar()` ya armado: los grupos fijados usan
  // el importe congelado como clave de orden en vez del importe en vivo.
  const conFijados = useCallback(
    <G extends { key: string; importe: number },>(grupos: G[]): G[] => {
      if (Object.keys(pinnedImporte).length === 0) return grupos;
      return [...grupos].sort((a, b) => {
        const ka = pinnedImporte[a.key] ?? a.importe;
        const kb = pinnedImporte[b.key] ?? b.importe;
        return kb - ka;
      });
    },
    [pinnedImporte],
  );

  // Renglones con un guardado en vuelo. Un load() que ya estaba en camino
  // (auto-refresh de 1 min, refrescar, cambio de vendedor) puede volver con la
  // foto ANTERIOR al POST y resucitar la fila recién descartada; mientras la
  // clave esté acá, load() la filtra. Se suelta al confirmar el guardado (o
  // al fallar, antes de recargar, para que la fila vuelva de verdad).
  const enVuelo = useRef<Set<string>>(new Set());
  const retener = (keys: string[]) => keys.forEach((k) => enVuelo.current.add(k));
  const soltar = (keys: string[]) => keys.forEach((k) => enVuelo.current.delete(k));

  // Anima las filas (una o varias, ej. extraordinario = todos los renglones
  // de ESE cliente en ese artículo) hacia el costado y recién al terminar
  // ejecuta el cambio real — la fila ya está afuera cuando desaparece del
  // array, sin salto de layout.
  const EXIT_MS = 260;
  const withExit = useCallback((keys: string[], dir: "left" | "right", fn: () => void) => {
    setLeaving((m) => {
      const n = { ...m };
      for (const k of keys) n[k] = dir;
      return n;
    });
    window.setTimeout(() => {
      fn();
      setLeaving((m) => {
        const n = { ...m };
        for (const k of keys) delete n[k];
        return n;
      });
    }, EXIT_MS);
  }, []);

  useEffect(() => {
    let vivo = true;
    fetch("/api/ventas/vendedor/vendedores", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (vivo && j) setVendedores(Array.isArray(j.vendedores) ? j.vendedores : []);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // El back ignora `vendedor` si quien pide no es admin (vendedorParam).
      const qs = vendedorSel ? `?vendedor=${encodeURIComponent(vendedorSel)}` : "";
      const res = await fetch(`/api/ventas/faltantes${qs}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const vivo = (r: { NroPedOrigen: number; NroRengOrigen: number }) =>
        !enVuelo.current.has(keyOf(r));
      setItems(((j.rows ?? []) as Item[]).filter(vivo));
      setListos(((j.listos ?? []) as ItemListo[]).filter(vivo));
      setFecha(j.fecha ?? null);
      setEsAdmin(j.isAdmin !== false);
      setSinVendedor(!!j.sinVendedor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setItems([]);
      setListos([]);
    } finally {
      setLoading(false);
    }
  }, [vendedorSel]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh cada 1 min.
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Poda pines de clientes que ya no tienen ningún renglón en `items` (se
  // terminó de trabajar todo lo suyo y el grupo desapareció de la lista).
  useEffect(() => {
    const activas = new Set(items.map(grupoKeyOf));
    setPinnedImporte((m) => {
      let cambio = false;
      const next: Record<string, number> = {};
      for (const k of Object.keys(m)) {
        if (activas.has(k)) next[k] = m[k];
        else cambio = true;
      }
      return cambio ? next : m;
    });
  }, [items]);

  // Guarda clienteQuiere en preparado.faltante_control (mismo endpoint que ya
  // usa /deposito/faltantes/control) y retira la fila de esta tabla, sea cual
  // sea la respuesta. Optimista: si falla el guardado, se vuelve a traer todo.
  //
  // Si el renglón es extraordinario, esta misma respuesta decide también
  // "comprar" en preparado.faltante_extraordinario (a nivel artículo+día+
  // CLIENTE desde 2026-09-16) → saca de acá, ya mismo, a los demás renglones
  // de ESE MISMO cliente en ese artículo (no todo el artículo: eso mezclaría
  // pedidos de otros clientes que no tienen nada que ver con esta marca).
  const mismoExtra = useCallback(
    (r: Item, it: Item) =>
      it.extraordinario &&
      r.CodArticulo === it.CodArticulo &&
      String(r.Cliente ?? "") === String(it.Cliente ?? ""),
    [],
  );
  const decidir = useCallback(
    (it: Item, quiere: boolean) => {
      const keys = items.filter((r) => mismoExtra(r, it) || keyOf(r) === keyOf(it)).map(keyOf);
      withExit(keys, quiere ? "right" : "left", () => {
        retener(keys);
        setItems((rs) => rs.filter((r) => !mismoExtra(r, it) && keyOf(r) !== keyOf(it)));
        const calls = [
          fetch("/api/ventas/faltantes/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fecha,
              nroPedOrigen: it.NroPedOrigen,
              nroRengOrigen: it.NroRengOrigen,
              codArticulo: it.CodArticulo,
              fechaArribo: it.fechaArribo === "EN_STOCK" ? null : it.fechaArribo,
              clienteQuiere: quiere,
            }),
          }),
        ];
        if (it.extraordinario && it.extraordinarioFecha && it.Cliente != null && it.Cliente !== "") {
          calls.push(
            fetch("/api/ventas/faltantes/extraordinario", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                fecha: it.extraordinarioFecha,
                codArticulo: it.CodArticulo,
                codCliente: String(it.Cliente),
                clienteNombre: it.ClienteNombre,
                comprar: quiere,
              }),
            }),
          );
        }
        Promise.all(calls)
          .then((rs) => {
            if (rs.some((r) => !r.ok)) throw new Error();
            soltar(keys);
          })
          .catch(() => {
            soltar(keys);
            setError("No se pudo guardar la decisión");
            load();
          });
      });
    },
    [items, fecha, load, withExit, mismoExtra],
  );

  // Tabla 2: guarda "vendido" en preparado.faltante_control (mismo endpoint,
  // ahora acepta ese campo opcional — ver route.ts) y retira la fila, sea cual
  // sea la respuesta (vendido o no vendido). Optimista, igual que decidir().
  // Tabla 1 con fecha de arribo, vista "Ingresados": misma acción que
  // decidirVendido pero sobre un Item (Tabla 1). Fija clienteQuiere=vendido
  // para que el renglón deje de calificar en Tabla 1 al recargar.
  const decidirVendidoTabla1 = useCallback(
    (it: Item, vendido: boolean) => {
      withExit([keyOf(it)], vendido ? "right" : "left", () => {
        retener([keyOf(it)]);
        setItems((rs) => rs.filter((r) => keyOf(r) !== keyOf(it)));
        fetch("/api/ventas/faltantes/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            fechaArribo: it.fechaArribo === "EN_STOCK" ? null : it.fechaArribo,
            clienteQuiere: vendido,
            vendido,
          }),
        })
          .then((r) => {
            if (!r.ok) throw new Error();
            soltar([keyOf(it)]);
          })
          .catch(() => {
            soltar([keyOf(it)]);
            setError("No se pudo guardar la venta");
            load();
          });
      });
    },
    [fecha, load, withExit],
  );

  const decidirVendido = useCallback(
    (it: ItemListo, vendido: boolean) => {
      withExit([keyOf(it)], vendido ? "right" : "left", () => {
        retener([keyOf(it)]);
        setListos((rs) => rs.filter((r) => keyOf(r) !== keyOf(it)));
        fetch("/api/ventas/faltantes/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            fechaArribo: it.fechaArribo,
            clienteQuiere: it.clienteQuiere,
            vendido,
          }),
        })
          .then((r) => {
            if (!r.ok) throw new Error();
            soltar([keyOf(it)]);
          })
          .catch(() => {
            soltar([keyOf(it)]);
            setError("No se pudo guardar la venta");
            load();
          });
      });
    },
    [fecha, load, withExit],
  );

  // Botón basurero (Tabla 1, SOLO filas "En stock" — existencia=true, error
  // de preparado): "irrelevante", descarta el renglón sin pasar por
  // lo-quiere/no-lo-quiere. Guarda irrelevante=true y retira la fila.
  const marcarIrrelevante = useCallback(
    (it: Item) => {
      withExit([keyOf(it)], "left", () => {
        retener([keyOf(it)]);
        setItems((rs) => rs.filter((r) => keyOf(r) !== keyOf(it)));
        fetch("/api/ventas/faltantes/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            fechaArribo: it.fechaArribo === "EN_STOCK" ? null : it.fechaArribo,
            clienteQuiere: null,
            irrelevante: true,
          }),
        })
          .then((r) => {
            if (!r.ok) throw new Error();
            soltar([keyOf(it)]);
          })
          .catch(() => {
            soltar([keyOf(it)]);
            setError("No se pudo marcar como irrelevante");
            load();
          });
      });
    },
    [fecha, load, withExit],
  );

  // Botón "Duplicado" (Tabla 1, ambas secciones): la factura se duplicó, este
  // renglón no es un faltante real. Guarda duplicado=true y retira la fila,
  // sin pasar por clienteQuiere (mismo patrón que marcarIrrelevante).
  const marcarDuplicado = useCallback(
    (it: Item) => {
      withExit([keyOf(it)], "left", () => {
        retener([keyOf(it)]);
        setItems((rs) => rs.filter((r) => keyOf(r) !== keyOf(it)));
        fetch("/api/ventas/faltantes/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            fechaArribo: it.fechaArribo === "EN_STOCK" ? null : it.fechaArribo,
            clienteQuiere: null,
            duplicado: true,
          }),
        })
          .then((r) => {
            if (!r.ok) throw new Error();
            soltar([keyOf(it)]);
          })
          .catch(() => {
            soltar([keyOf(it)]);
            setError("No se pudo marcar como duplicado");
            load();
          });
      });
    },
    [fecha, load, withExit],
  );

  const extraordinarios = useMemo(() => items.filter((it) => it.extraordinario), [items]);
  const normales = useMemo(
    () => items.filter((it) => !it.extraordinario && it.fechaArribo !== "EN_STOCK"),
    [items],
  );
  const gruposExtra = useMemo(
    () => conFijados(agrupar(extraordinarios)),
    [extraordinarios, conFijados],
  );
  const gruposNormales = useMemo(
    () => conFijados(agrupar(normales)),
    [normales, conFijados],
  );
  const gruposListos = useMemo(() => agruparListos(listos), [listos]);
  const conArribo = useMemo(() => items.filter((it) => it.fechaArribo), [items]);
  const gruposConArribo = useMemo(
    () => conFijados(agrupar(conArribo)),
    [conArribo, conFijados],
  );

  // Totales POR CARA (antes era un solo total en el header, lejos de la tabla
  // que estabas mirando). Cada título lleva la cantidad de renglones y el
  // importe de lo que esa cara muestra, así el número siempre coincide con
  // las filas de abajo.
  const totales = useMemo(() => {
    const sum = (arr: { Importe: number }[]) => arr.reduce((a, it) => a + (it.Importe || 0), 0);
    const sinIngresar = [...extraordinarios, ...normales];
    return {
      sin: {
        art: sinIngresar.length,
        extra: extraordinarios.length,
        importe: sum(sinIngresar),
      },
      ing: { art: conArribo.length, importe: sum(conArribo) },
      listos: { art: listos.length, importe: sum(listos) },
    };
  }, [extraordinarios, normales, conArribo, listos]);

  const hay = items.length > 0 || listos.length > 0;

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      {(loading || error) && (
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
          {loading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" /> Consultando la base…
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="text-red-400" /> {error}
            </div>
          )}
        </div>
      )}

      {/* Header. En el teléfono se apila en 3 filas (2026-09-03: antes era una
          sola fila `h-16` y el segmentado se montaba encima del título):
            fila 1 → logo + FALTANTES, con "refrescar" pegado a la derecha
            fila 2 → filtro de vendedor (admin) y el usuario a la derecha
            fila 3 → segmentado Sin ingresar / Ingresados, a todo el ancho
          En `md` vuelve a ser UNA fila de 64px: el grupo del título lleva
          `md:mr-auto` (empuja todo lo demás a la derecha) y el `order-*`
          reacomoda → título, filtro, segmentado, refrescar, usuario. Los dos
          wrappers de mobile se disuelven con `md:contents`, así sus hijos
          entran como items del header. Al agregar algo nuevo, darle su
          `md:order-N`. */}
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 px-4 md:px-8 py-2 md:py-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:h-16 md:flex-nowrap md:gap-4">
          <div className="flex items-center gap-2 min-w-0 md:order-1 md:gap-4 md:mr-auto">
            <InicioButton />
            <span className="font-bold text-yellow-400 text-sm md:text-2xl tracking-wide uppercase whitespace-nowrap">
              EVER WEAR{" "}
              <span className="text-[10px] md:text-sm tracking-[3px] font-normal">S.A.</span>
            </span>
            <div className="hidden md:block w-px h-7 bg-yellow-400/30" />
            <span className="text-sm md:text-2xl font-extrabold uppercase tracking-[0.15em] md:tracking-[0.2em] text-white whitespace-nowrap">
              Faltantes
            </span>
          </div>

          {/* Refrescar. En mobile cierra la fila del título (ml-auto). */}
          <button
            onClick={load}
            title="Refrescar"
            disabled={loading}
            className="btn-anim text-zinc-400 hover:text-yellow-400 p-2 ml-auto disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0 md:order-4 md:ml-0"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>

          {/* Fila 2 en mobile: filtro de vendedor + usuario. */}
          <div className="w-full flex items-center gap-2 md:contents">
            {/* Filtro de vendedor — SOLO ADMIN. Acota la vista a la CARTERA de
                ese vendedor (mismo criterio que ve él cuando entra), server-side.
                No se renderiza si /api/ventas/vendedor/vendedores contestó 403:
                ese usuario ya está acotado a su propio vendedor.
                2026-09-03: antes era `hidden md:flex` — en el teléfono el admin
                no podía filtrar. Ahora entra en la fila 2, angosto. */}
            {esAdmin && vendedores.length > 0 && (
              <div className="flex items-center gap-2 min-w-0 flex-1 md:flex-none md:order-2">
                <Users size={14} className="text-yellow-400 shrink-0" />
                <select
                  value={vendedorSel}
                  onChange={(e) => setVendedorSel(e.target.value)}
                  title="Ver los faltantes de la cartera de un vendedor"
                  className="bg-[#1f1f1f] border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 w-full min-w-0 md:w-auto md:max-w-[200px]"
                >
                  <option value="">Todos los vendedores</option>
                  {vendedores.map((v) => (
                    <option key={v.codigo} value={String(v.codigo)}>
                      {v.nombre ?? `Vendedor ${v.codigo}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <UsuarioActual className="ml-auto md:order-5 md:ml-0" />
          </div>

          {/* Selector de vista. Antes era UN solo botón "Ingresados" que giraba la
              tarjeta: no se entendía qué se estaba mirando ni cuál era la otra
              cara. Ahora las dos vistas están a la vista con su contador y la
              activa queda resaltada (amarillo = sin ingresar, verde = ingresados).
              En mobile ocupa su propia fila a todo el ancho (mitad y mitad). */}
          <div className="w-full flex items-center rounded-md border border-zinc-700 overflow-hidden text-xs font-medium md:w-auto md:order-3">
            <button
              onClick={() => setFlipped(false)}
              title="Faltantes que todavía NO ingresaron"
              className={`flex flex-1 items-center justify-center gap-2 px-3 py-1.5 transition-colors md:flex-none md:justify-start ${
                !flipped ? "bg-yellow-400/15 text-yellow-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Clock size={14} className="shrink-0" />
              Sin ingresar
              <span
                className={`rounded-full px-1.5 text-[10px] leading-4 tabular-nums ${
                  !flipped ? "bg-yellow-400 text-black" : "bg-zinc-700 text-zinc-300"
                }`}
              >
                {extraordinarios.length + normales.length}
              </span>
            </button>
            <div className="w-px self-stretch bg-zinc-700" />
            <button
              onClick={() => setFlipped(true)}
              title="Faltantes que YA ingresaron (tienen fecha de arribo)"
              className={`flex flex-1 items-center justify-center gap-2 px-3 py-1.5 transition-colors md:flex-none md:justify-start ${
                flipped ? "bg-green-500/15 text-green-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <PackageCheck size={14} className="shrink-0" />
              Ingresados
              <span
                className={`rounded-full px-1.5 text-[10px] leading-4 tabular-nums ${
                  flipped ? "bg-green-500 text-white" : "bg-zinc-700 text-zinc-300"
                }`}
              >
                {conArribo.length}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-3 md:px-8 py-6">
        {!hay ? (
          <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
            {loading ? (
              <Loader2 size={40} className="text-yellow-400 animate-spin" />
            ) : (
              <PackageCheck size={44} className="text-zinc-700" />
            )}
            <p className="text-zinc-400 font-medium">
              {loading
                ? "Consultando la base…"
                : sinVendedor
                  ? "Todavía no tenés un vendedor asignado."
                  : "No hay faltantes pendientes."}
            </p>
            {!loading && sinVendedor && (
              <p className="text-zinc-600 text-sm">
                Pedile a un administrador que te asigne el vendedor en Administración → Usuarios.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* 2026-09-04: acá había una TARJETA QUE GIRA (perspective +
                rotateY(180deg) + preserve-3d, las 2 caras montadas siempre y
                superpuestas por grid). Con el volumen real de renglones el
                navegador tenía que rasterizar las dos listas enteras dentro de
                una capa 3D y animarla 700ms: al tocar el segmentado la pestaña
                se congelaba varios segundos. Ahora se renderiza SOLO la cara
                activa (montaje condicional, sin transform 3D): el cambio es
                instantáneo y la cara que no se ve ni existe en el DOM.
                Si se toca esto, NO volver a montar las dos caras a la vez. */}
            <div className="min-w-0">
              {!flipped ? (
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-yellow-400 uppercase tracking-wide mb-3">
                    <span className="flex items-center gap-2">
                      <Clock size={16} /> Sin ingresar (todavía no llegaron)
                    </span>
                    <span className="normal-case tracking-normal text-zinc-400 font-normal">
                      <b className="text-yellow-400 tabular-nums">{totales.sin.art}</b> art.
                      {totales.sin.extra > 0 && (
                        <>
                          {" · "}
                          <b className="text-red-400 tabular-nums">{totales.sin.extra}</b> extraord.
                        </>
                      )}
                      {" · "}
                      <b className="text-zinc-200 tabular-nums">${fmtNum(totales.sin.importe)}</b>
                    </span>
                  </h2>
                  {gruposExtra.length === 0 && gruposNormales.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-center text-zinc-500 text-sm">
                      <PackageCheck size={28} className="text-zinc-700" />
                      Nada pendiente en esta vista.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-6">
                      {gruposExtra.length > 0 && (
                        <section className="flex flex-col gap-3">
                          {gruposExtra.map((g) => (
                            <GrupoCard
                              key={g.key}
                              g={g}
                              mostrarVendedor={esAdmin}
                              extra
                              onDecidir={decidir}
                              onIrrelevante={marcarIrrelevante}
                              onDuplicado={marcarDuplicado}
                              leaving={leaving}
                              pinned={g.key in pinnedImporte}
                              onTogglePin={() => togglePin(g.key, g.importe)}
                            />
                          ))}
                        </section>
                      )}

                      {gruposNormales.length > 0 && (
                        <section className="flex flex-col gap-3">
                          {gruposNormales.map((g) => (
                            <GrupoCard
                              key={g.key}
                              g={g}
                              mostrarVendedor={esAdmin}
                              onDecidir={decidir}
                              onIrrelevante={marcarIrrelevante}
                              onDuplicado={marcarDuplicado}
                              leaving={leaving}
                              pinned={g.key in pinnedImporte}
                              onTogglePin={() => togglePin(g.key, g.importe)}
                            />
                          ))}
                        </section>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* Ingresados */
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-green-400 uppercase tracking-wide mb-3">
                    <span className="flex items-center gap-2">
                      <PackageCheck size={16} /> Ingresados (ya llegaron)
                    </span>
                    <span className="normal-case tracking-normal text-zinc-400 font-normal">
                      <b className="text-green-400 tabular-nums">{totales.ing.art}</b> art. ·{" "}
                      <b className="text-zinc-200 tabular-nums">${fmtNum(totales.ing.importe)}</b>
                    </span>
                  </h2>
                  {gruposConArribo.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2 text-center text-zinc-500 text-sm">
                      <PackageCheck size={28} className="text-zinc-700" />
                      Nada ingresado todavía.
                    </div>
                  ) : (
                    <section className="flex flex-col gap-3">
                      {gruposConArribo.map((g) => (
                        <GrupoCard
                          key={g.key}
                          g={g}
                          mostrarVendedor={esAdmin}
                          vendidoMode
                          onDecidir={decidirVendidoTabla1}
                          onIrrelevante={marcarIrrelevante}
                          onDuplicado={marcarDuplicado}
                          leaving={leaving}
                          pinned={g.key in pinnedImporte}
                          onTogglePin={() => togglePin(g.key, g.importe)}
                        />
                      ))}
                    </section>
                  )}
                </div>
              )}
            </div>

            {gruposListos.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-green-400 uppercase tracking-wide">
                  <span className="flex items-center gap-2">
                    <PackageCheck size={16} /> Listos para vender (ya ingresaron)
                  </span>
                  <span className="normal-case tracking-normal text-zinc-400 font-normal">
                    <b className="text-green-400 tabular-nums">{totales.listos.art}</b> art. ·{" "}
                    <b className="text-zinc-200 tabular-nums">${fmtNum(totales.listos.importe)}</b>
                  </span>
                </h2>
                {gruposListos.map((g) => (
                  <GrupoCardListo
                    key={g.key}
                    g={g}
                    mostrarVendedor={esAdmin}
                    onDecidir={decidirVendido}
                    leaving={leaving}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function GrupoCard({
  g, extra, vendidoMode, mostrarVendedor, onDecidir, onIrrelevante, onDuplicado, leaving = {},
  pinned, onTogglePin,
}: {
  g: Grupo;
  extra?: boolean;
  /** Solo la vista de admin muestra el vendedor del pedido. */
  mostrarVendedor?: boolean;
  vendidoMode?: boolean;
  onDecidir: (it: Item, quiere: boolean) => void;
  onIrrelevante?: (it: Item) => void;
  onDuplicado?: (it: Item) => void;
  leaving?: Record<string, "left" | "right">;
  /** Fijar el cliente en su lugar mientras se lo trabaja (ver `conFijados`). */
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        extra ? "border-red-900/50 bg-red-500/[0.05]" : "border-zinc-800 bg-[#161616]"
      } ${pinned ? "ring-1 ring-yellow-400/60" : ""}`}
    >
      <div className={`flex items-center gap-4 px-4 py-3 border-b ${
        extra ? "bg-red-500/[0.08] border-red-900/40" : "bg-[#1A1A1A] border-zinc-800"
      }`}>
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            title={
              pinned
                ? "Soltar cliente — vuelve a ordenarse por importe"
                : "Fijar cliente en su lugar mientras lo trabajás"
            }
            className={`btn-anim shrink-0 p-1.5 rounded-md border transition-colors ${
              pinned
                ? "border-yellow-400/60 text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20"
                : "border-zinc-700 text-zinc-500 hover:text-yellow-400 hover:border-yellow-400/40"
            }`}
          >
            {pinned ? <Pin size={15} className="fill-current" /> : <PinOff size={15} />}
          </button>
        )}
        {/* Encabezado: cliente y, solo para admin, el vendedor del pedido. El
            N° de factura/pedido y la cantidad de artículos no se muestran. */}
        <div
          className={`flex-1 grid gap-x-6 gap-y-1 min-w-0 ${
            mostrarVendedor ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
          }`}
        >
          <Campo label="Cliente" value={g.clienteNombre || g.cliente || "—"} />
          {mostrarVendedor && <Campo label="Vendedor" value={g.vendedor || "—"} />}
        </div>
        <div className="shrink-0 text-right hidden sm:block">
          <div className="text-sm tabular-nums text-zinc-200">${fmtNum(g.importe)}</div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#141414] text-zinc-400">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Cód.</th>
              <th className="px-3 py-2 font-medium">Artículo</th>
              <th className="px-3 py-2 font-medium text-right">Cant. faltante</th>
              <th className="px-3 py-2 font-medium">Fecha faltante</th>
              <th className="px-3 py-2 font-medium">Fecha arribo</th>
              <th className="px-3 py-2 font-medium text-right">Importe</th>
              <th className="px-3 py-2 font-medium text-center">{vendidoMode ? "Vendido" : "Acción"}</th>
            </tr>
          </thead>
          <tbody>
            {g.items.map((it) => {
              const dir = leaving[keyOf(it)];
              return (
              <tr
                key={keyOf(it)}
                className={`border-t border-zinc-800/70 animate-in fade-in duration-300 ${
                  dir === "right" ? "row-out-right" : dir === "left" ? "row-out-left" : ""
                }`}
              >
                <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{it.CodArticulo}</td>
                <td className="px-3 py-2 text-zinc-100">{it.Nombre}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(it.CantPend)}</td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">{fmtAr(it.Fecha)}</td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">
                  {fmtAr(it.fechaArribo)}
                  {it.arriboOC && it.fechaArribo && (
                    <span
                      className="ml-1.5 text-[10px] text-sky-400/80 align-middle"
                      title="Fecha estimada de la OC pendiente (editable en Compras → Faltantes, columna Arribo)"
                    >
                      OC
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">${fmtNum(it.Importe)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      onClick={() => onDecidir(it, true)}
                      disabled={!!dir}
                      title={vendidoMode ? "Vendido" : "Lo quiere"}
                      className="btn-anim p-1.5 rounded-md border border-zinc-700 text-green-500 hover:bg-green-600/20 disabled:opacity-40"
                    >
                      <Check size={15} />
                    </button>
                    <button
                      onClick={() => onDecidir(it, false)}
                      disabled={!!dir}
                      title={vendidoMode ? "No vendido" : "No lo quiere"}
                      className="btn-anim p-1.5 rounded-md border border-zinc-700 text-red-500 hover:bg-red-600/20 disabled:opacity-40"
                    >
                      <X size={15} />
                    </button>
                    {onIrrelevante && (
                      <button
                        onClick={() => onIrrelevante(it)}
                        disabled={!!dir}
                        title="Irrelevante — descartar"
                        className="btn-anim p-1.5 rounded-md border border-zinc-700 text-violet-600 hover:bg-violet-800/25 hover:text-violet-500 disabled:opacity-40"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                    {onDuplicado && (
                      <button
                        onClick={() => onDuplicado(it)}
                        disabled={!!dir}
                        title="Duplicado — factura duplicada, ignorar"
                        className="btn-anim p-1.5 rounded-md border border-zinc-700 text-amber-600 hover:bg-amber-800/25 hover:text-amber-500 disabled:opacity-40"
                      >
                        <Copy size={15} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GrupoCardListo({
  g, mostrarVendedor, onDecidir, leaving = {},
}: {
  g: GrupoListo;
  /** Ver GrupoCard. */
  mostrarVendedor?: boolean;
  onDecidir: (it: ItemListo, vendido: boolean) => void;
  leaving?: Record<string, "left" | "right">;
}) {
  return (
    <div className="rounded-xl border border-green-900/50 bg-green-500/[0.05] overflow-hidden">
      <div className="flex items-center gap-4 px-4 py-3 border-b bg-green-500/[0.08] border-green-900/40">
        {/* Ver GrupoCard: cliente y, solo para admin, el vendedor. */}
        <div
          className={`flex-1 grid gap-x-6 gap-y-1 min-w-0 ${
            mostrarVendedor ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
          }`}
        >
          <Campo label="Cliente" value={g.clienteNombre || g.cliente || "—"} />
          {mostrarVendedor && <Campo label="Vendedor" value={g.vendedor || "—"} />}
        </div>
        <div className="shrink-0 text-right hidden sm:block">
          <div className="text-sm tabular-nums text-zinc-200">${fmtNum(g.importe)}</div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#141414] text-zinc-400">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Cód.</th>
              <th className="px-3 py-2 font-medium">Artículo</th>
              <th className="px-3 py-2 font-medium text-right">Cant. faltante</th>
              <th className="px-3 py-2 font-medium">Fecha faltante</th>
              <th className="px-3 py-2 font-medium">Fecha arribo</th>
              <th className="px-3 py-2 font-medium text-right">Importe</th>
              <th className="px-3 py-2 font-medium text-center">Vendido</th>
            </tr>
          </thead>
          <tbody>
            {g.items.map((it) => {
              const dir = leaving[keyOf(it)];
              return (
                <tr
                  key={keyOf(it)}
                  className={`border-t border-zinc-800/70 animate-in fade-in duration-300 ${
                    dir === "right" ? "row-out-right" : dir === "left" ? "row-out-left" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{it.CodArticulo}</td>
                  <td className="px-3 py-2 text-zinc-100">{it.Nombre}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(it.CantPend)}</td>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">{fmtAr(it.Fecha)}</td>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">{fmtAr(it.fechaArribo)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">${fmtNum(it.Importe)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => onDecidir(it, true)}
                        disabled={!!dir}
                        title="Vendido"
                        className="btn-anim p-1.5 rounded-md border border-zinc-700 text-green-500 hover:bg-green-600/20 disabled:opacity-40"
                      >
                        <Check size={15} />
                      </button>
                      <button
                        onClick={() => onDecidir(it, false)}
                        disabled={!!dir}
                        title="No vendido"
                        className="btn-anim p-1.5 rounded-md border border-zinc-700 text-red-500 hover:bg-red-600/20 disabled:opacity-40"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Campo({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-100 truncate">{value}</div>
    </div>
  );
}
