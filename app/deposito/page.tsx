"use client";
import { useState, useEffect, useMemo } from "react";
import {
  ResumenTab,
  ProcesoTab,
  OperariosTab,
  TiempoTab,
} from "./components/tabs";
import { MesaControlTab } from "./components/mesaControl";
import { ErroresMesaTab } from "./components/erroresMesa";
import { TiemposPickingTab } from "./components/tiemposPicking";
import {
  LayoutDashboard, PackageSearch, Repeat, MapPin, Users, Clock, Timer,
  Loader2, RefreshCw, AlertTriangle, FileSpreadsheet, ClipboardList,
  AlertOctagon,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { MonthRangePickerField, lastFullMonthRange } from "@/components/ui/date-range-field";
import { useDepositoData, useDepositoProd } from "@/lib/deposito/store";
import { filterDepositoByOperario } from "@/lib/deposito/parseDeposito";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymDe = (y: number, m0: number) => {
  const d = new Date(y, m0, 1); // normaliza desbordes de mes/año
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const primerDia = (ym: string) => `${ym}-01`;
const ultimoDia = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad2(new Date(y, m, 0).getDate())}`;
};

const TABS = [
  // { id: "resumen", label: "Resumen", icon: LayoutDashboard, needs: "prod" },
  { id: "picking", label: "Picking", icon: PackageSearch, needs: "prod" },
  { id: "librepo", label: "Libre + Reposición", icon: Repeat, needs: "prod" },
  { id: "reub", label: "Re-Ubicación", icon: MapPin, needs: "prod" },
  { id: "operarios", label: "Operarios", icon: Users, needs: "prod" },
  { id: "tiempos-picking", label: "Tiempos de Picking", icon: Timer, needs: "picking" },
  { id: "tiempo", label: "Tiempo de Pedidos", icon: Clock, needs: "tiempo" },
  { id: "mesa-control", label: "Mesas de Control", icon: ClipboardList, needs: "mesa" },
  { id: "errores-mesa", label: "Errores de Mesa", icon: AlertOctagon, needs: "errores" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function DepositoPage() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [operario, setOperario] = useState("__all__");
  const [tab, setTab] = useState<TabId>("picking");
  // false = el usuario todavía no tocó el selector de meses → el gráfico de
  // "Items recolectados por mes" muestra el mes en curso y 2 hacia atrás.
  const [mesesTocados, setMesesTocados] = useState(false);

  // Por defecto: el último mes calendario completo (cliente, evita mismatch
  // SSR). 2026-08-20 — antes arrancaba en "hoy".
  useEffect(() => {
    const [d, h] = lastFullMonthRange();
    setDesde(d);
    setHasta(h);
  }, []);

  const { prod, tiempo, loading, error, reload } = useDepositoData(desde, hasta);

  // Meses del gráfico "Items recolectados por mes" (cronológico, mínimo 3):
  //  - sin tocar el selector: mes en curso y hacia atrás;
  //  - con selección: los meses elegidos y, si son menos de 3, se agregan meses
  //    ANTERIORES al inicio hasta completar 3 columnas.
  const chartMeses = useMemo(() => {
    const hoy = new Date();
    const actual = ymDe(hoy.getFullYear(), hoy.getMonth());
    let lo = ymDe(hoy.getFullYear(), hoy.getMonth() - 2);
    let hi = actual;
    if (mesesTocados && desde && hasta) {
      lo = desde.slice(0, 7);
      hi = hasta.slice(0, 7);
    }
    const out: string[] = [];
    for (let [y, m] = lo.split("-").map(Number) as [number, number]; ymDe(y, m - 1) <= hi; m++) {
      out.push(ymDe(y, m - 1));
    }
    while (out.length < 3) {
      const [y, m] = out[0].split("-").map(Number);
      out.unshift(ymDe(y, m - 2));
    }
    return out;
  }, [mesesTocados, desde, hasta]);
  const chartDesde = primerDia(chartMeses[0]);
  const chartHasta = ultimoDia(chartMeses[chartMeses.length - 1]);
  // Si el rango del gráfico coincide con el filtro, se reutiliza `prod`.
  const mismoRango = chartDesde === desde && chartHasta === hasta;
  const chartFetch = useDepositoProd(chartDesde, chartHasta, !!desde && !mismoRango);
  const chartProd = mismoRango ? prod : chartFetch.prod;
  const chartRegs = useMemo(
    () =>
      chartProd
        ? operario === "__all__"
          ? chartProd.registros
          : chartProd.registros.filter((r) => r.operario === operario)
        : null,
    [chartProd, operario],
  );

  // Filtro por operario (cliente): recalcula agregados sin re-consultar SQL.
  const viewProd = useMemo(
    () => (prod ? filterDepositoByOperario(prod, operario) : null),
    [prod, operario],
  );

  // Si el operario elegido ya no está en el nuevo rango, volver a "Todos".
  useEffect(() => {
    if (operario !== "__all__" && prod && !prod.operarios.includes(operario)) {
      setOperario("__all__");
    }
  }, [prod, operario]);

  const current = TABS.find((t) => t.id === tab)!;
  const needs = current.needs;
  // "mesa" (Mesas de Control) se maneja sola: fetch propio por mes, no depende
  // de prod/tiempo (que vienen del store por rango de fechas día a día).
  const ready =
    needs === "tiempo"
      ? !!tiempo
      : needs === "mesa" || needs === "errores" || needs === "picking"
        ? true
        : !!viewProd;

  return (
    <div className="min-h-screen bg-[#111111] text-white relative">
      {/* Toasts */}
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

      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center justify-between px-8 h-16 gap-4">
        <div className="flex items-center gap-4 shrink-0">
          <InicioButton />
          <span className="font-bold text-yellow-400 text-2xl tracking-wide uppercase">
            EVER WEAR <span className="text-sm tracking-[3px] font-normal">S.A.</span>
          </span>
          <div className="w-px h-7 bg-yellow-400/30" />
          <span className="text-zinc-500 text-sm hidden lg:inline">
            Depósito · Producción WMS
          </span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {/* Filtro de fechas: único, en el header, para todas las pestañas
              (incluida Errores de Mesa — antes tenía su propio selector
              duplicado). Solo mes a mes, sin calendario de días (2026-08-20). Oculto solo en Mesas de Control, que filtra
              por checkbox de meses propio (ver mesaControl.tsx). */}
          <div className={tab === "mesa-control" ? "invisible pointer-events-none" : ""}>
            <MonthRangePickerField
              desde={desde}
              hasta={hasta}
              align="end"
              onChange={(d, h) => {
                setMesesTocados(true);
                setDesde(d);
                setHasta(h);
              }}
            />
          </div>
          <div
            className={`flex items-center gap-3 ${tab === "mesa-control" || tab === "errores-mesa" ? "invisible pointer-events-none" : ""}`}
          >
            <label className="flex items-center gap-1.5 text-zinc-400">
              Operario
              <select
                value={operario}
                onChange={(e) => setOperario(e.target.value)}
                className="bg-[#1f1f1f] border border-zinc-700 rounded-lg px-2.5 py-1.5 text-zinc-100 focus:border-yellow-400 outline-none cursor-pointer max-w-[180px]"
              >
                <option value="__all__">Todos</option>
                {(prod?.operarios ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                reload();
                chartFetch.reload();
              }}
              title="Refrescar"
              disabled={loading || chartFetch.loading}
              className="text-zinc-400 hover:text-yellow-400 transition-colors p-2 disabled:opacity-40"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
          <UsuarioActual />
        </div>
      </header>

      {/* Tabs */}
      <nav className="bg-[#242424] border-b border-zinc-800 px-8 flex gap-0 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-5 py-4 text-sm font-medium border-b-[3px] whitespace-nowrap transition-all duration-100 ${
              tab === id
                ? "text-yellow-400 border-yellow-400"
                : "text-zinc-500 border-transparent hover:text-zinc-200"
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      {/* Contenido */}
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        {!ready ? (
          <div className="flex flex-col items-center justify-center py-28 gap-4 text-center">
            {loading ? (
              <>
                <Loader2 size={40} className="text-yellow-400 animate-spin" />
                <p className="text-zinc-400 font-medium">Consultando la base…</p>
              </>
            ) : (
              <>
                <FileSpreadsheet size={48} className="text-zinc-700" />
                <div>
                  <p className="text-zinc-400 font-medium">
                    {needs === "tiempo"
                      ? "Sin datos de tiempos en el rango seleccionado"
                      : "Sin datos de producción en el rango seleccionado"}
                  </p>
                  <p className="text-zinc-600 text-sm mt-1">
                    Ajustá las fechas o el operario, o tocá refrescar.
                  </p>
                </div>
              </>
            )}
          </div>
        ) : (
            // {tab === "resumen" && viewProd && <ResumenTab d={viewProd} mes="__all__" />}
          <>
            {tab === "picking" && viewProd && (
              <ProcesoTab d={viewProd} proceso="Picking" mes="__all__" chartMeses={chartMeses} chartRegs={chartRegs} />
            )}
            {tab === "librepo" && viewProd && (
              <ProcesoTab d={viewProd} proceso="Libre + Reposicion" mes="__all__" chartMeses={chartMeses} chartRegs={chartRegs} />
            )}
            {tab === "reub" && viewProd && (
              <ProcesoTab d={viewProd} proceso="Re-Ubicacion" mes="__all__" chartMeses={chartMeses} chartRegs={chartRegs} />
            )}
            {tab === "operarios" && viewProd && <OperariosTab d={viewProd} />}
            {tab === "tiempos-picking" && (
              <TiemposPickingTab desde={desde} hasta={hasta} operario={operario} />
            )}
            {tab === "tiempo" && tiempo && <TiempoTab d={tiempo} mes="__all__" />}
            {tab === "mesa-control" && <MesaControlTab />}
            {tab === "errores-mesa" && <ErroresMesaTab desde={desde} hasta={hasta} />}
          </>
        )}
      </main>
    </div>
  );
}
