"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AddMangueraModal } from "../../components/AddMangueraModal";
import {
  createTrabajoAction,
  getClienteAction,
  updateTrabajoAction,
} from "../../actions";

type Legajo = {
  id: number;
  nombre: string;
  sectorRel: { nombre: string } | null;
};
type Manguera = {
  id: number;
  codigo: string;
  metros: number;
  ubicacion: string | null;
};
type CorteRow = {
  mangueraId: number;
  codigo: string;
  metros: number;
  observacion: string | null;
};
type TrabajoEdit = {
  id: number;
  legajoId: number;
  clienteNumero: number | null;
  clienteNombre: string | null;
  ordenTrabajo: string | null;
  prioridad: string | null;
  producto: string | null;
  cantidadAProducir: number | null;
  observaciones: string | null;
  fechaPedido: string | Date;
  cortes: { codigo: string; metros: number; observacion: string | null }[];
};

const OBS_OPCIONES = ["SIN STOCK", "ESPERA DE RECEPCION"];

export function NuevoTrabajoClient({
  legajos,
  mangueras,
  trabajo,
}: {
  legajos: Legajo[];
  mangueras: Manguera[];
  trabajo?: TrabajoEdit;
}) {
  const router = useRouter();
  const isEdit = !!trabajo;

  const inicioRef = useRef<string>(
    trabajo?.fechaPedido
      ? new Date(trabajo.fechaPedido).toISOString()
      : new Date().toISOString(),
  );
  const codeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  // cabecera
  const [operarioId, setOperarioId] = useState<number | "">(
    trabajo?.legajoId ?? "",
  );
  const [numInterno, setNumInterno] = useState(trabajo?.ordenTrabajo ?? "");
  const [prioridad, setPrioridad] = useState(trabajo?.prioridad ?? "MEDIA");
  const [producto, setProducto] = useState(trabajo?.producto ?? "");
  const [cantidad, setCantidad] = useState(
    trabajo?.cantidadAProducir != null ? String(trabajo.cantidadAProducir) : "",
  );
  const [observaciones, setObservaciones] = useState(
    trabajo?.observaciones ?? "",
  );

  // cliente
  const [clienteNumero, setClienteNumero] = useState(
    trabajo?.clienteNumero != null ? String(trabajo.clienteNumero) : "",
  );
  const [clienteNombre, setClienteNombre] = useState<string | null>(
    trabajo?.clienteNombre ?? null,
  );
  const [clienteErr, setClienteErr] = useState(false);

  // cortes (los precargados usan id negativo: no descuentan stock mostrado)
  const [cortes, setCortes] = useState<CorteRow[]>(
    trabajo?.cortes.map((c, i) => ({
      mangueraId: -(i + 1),
      codigo: c.codigo,
      metros: c.metros,
      observacion: c.observacion,
    })) ?? [],
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Manguera | null>(null);
  const [qty, setQty] = useState("");
  const [obs, setObs] = useState("");

  const [modalManguera, setModalManguera] = useState(false);
  const [saving, setSaving] = useState(false);

  const operario = legajos.find((l) => l.id === operarioId);
  const sectorNombre = operario?.sectorRel?.nombre || "—";

  const stagedByRoll = useMemo(() => {
    const m: Record<number, number> = {};
    for (const c of cortes) m[c.mangueraId] = (m[c.mangueraId] || 0) + c.metros;
    return m;
  }, [cortes]);
  const avail = (m: Manguera) => m.metros - (stagedByRoll[m.id] || 0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return mangueras
      .filter((m) => m.codigo.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, mangueras]);

  const cant = cantidad ? parseInt(cantidad, 10) : null;

  const hayEspera = cortes.some(
    (c) => (c.observacion || "").toUpperCase() === "ESPERA DE RECEPCION",
  );
  const estadoCalc = hayEspera ? "ESPERA_RECEPCION" : "EN_PROCESO";

  const totalMetros = cortes.reduce((a, c) => a + c.metros, 0);
  const lock = !selected || !cant || cant <= 0 || cortes.length >= cant;

  function focus(ref: React.RefObject<HTMLInputElement>) {
    setTimeout(() => ref.current?.focus(), 30);
  }

  function selectManguera(m: Manguera) {
    setSelected(m);
    setQuery(m.codigo);
    setQty("");
    setObs("");
    focus(qtyRef);
  }

  function onCodeKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!selected && matches.length > 0) selectManguera(matches[0]);
    }
  }

  function commitCorte() {
    if (!selected) return;
    if (!cant || cant <= 0) return;
    if (cortes.length >= cant) return;
    const n = Math.round((parseFloat(qty) || 0) * 100) / 100;
    const o = obs.trim();
    if (n <= 0 && !o) return;
    setCortes((p) => [
      ...p,
      {
        mangueraId: selected.id,
        codigo: selected.codigo,
        metros: n,
        observacion: o || null,
      },
    ]);
    setSelected(null);
    setQuery("");
    setQty("");
    setObs("");
    focus(codeRef);
  }

  function onCommitKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCorte();
    }
  }

  function removeCorte(i: number) {
    setCortes((p) => p.filter((_, idx) => idx !== i));
  }
  function setCorteMetros(i: number, v: string) {
    const n = Math.max(0, Math.round((parseFloat(v) || 0) * 100) / 100);
    setCortes((p) => p.map((c, idx) => (idx === i ? { ...c, metros: n } : c)));
  }
  function setCorteObs(i: number, v: string) {
    setCortes((p) =>
      p.map((c, idx) => (idx === i ? { ...c, observacion: v || null } : c)),
    );
  }

  async function resolveCliente() {
    const n = parseInt(clienteNumero, 10);
    if (isNaN(n)) {
      setClienteNombre(null);
      setClienteErr(false);
      return;
    }
    const cli = await getClienteAction(n);
    setClienteNombre(cli?.nombre ?? null);
    setClienteErr(!cli);
  }

  async function submit(finalizar: boolean) {
    if (!operarioId) return alert("Elegí un operario");

    // auto-commit del corte pendiente
    let lista = cortes;
    if (
      selected &&
      (parseFloat(qty) > 0 || obs.trim()) &&
      cant &&
      cant > 0 &&
      cortes.length < cant
    ) {
      lista = [
        ...cortes,
        {
          mangueraId: selected.id,
          codigo: selected.codigo,
          metros: Math.round((parseFloat(qty) || 0) * 100) / 100,
          observacion: obs.trim() || null,
        },
      ];
      setCortes(lista);
      setSelected(null);
      setQuery("");
      setQty("");
      setObs("");
    }
    if (lista.length === 0) return alert("Agregá al menos un corte");

    const base = {
      legajoId: operarioId as number,
      clienteNumero: clienteNumero ? parseInt(clienteNumero, 10) : null,
      clienteNombre: clienteNombre || null,
      ordenTrabajo: numInterno,
      prioridad,
      producto,
      cantidadAProducir: cantidad ? parseInt(cantidad, 10) : null,
      observaciones,
      inicio: inicioRef.current,
      cortes: lista,
      finalizar,
    };

    setSaving(true);
    try {
      if (isEdit)
        await updateTrabajoAction({ trabajoId: trabajo!.id, ...base });
      else await createTrabajoAction(base);
      router.push("/fabrica/manguera/corte");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al guardar");
      setSaving(false);
    }
  }

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none";

  return (
    <main className="container mx-auto p-4 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {isEdit ? "Editar trabajo" : "Nuevo trabajo"}
        </h1>
        <Link
          href="/fabrica/manguera/corte"
          className="text-gray-500 hover:text-gray-700"
        >
          ← Volver
        </Link>
      </div>

      {/* CABECERA */}
      <div className="bg-white rounded-lg shadow p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Operario *
          </label>
          <select
            value={operarioId}
            onChange={(e) =>
              setOperarioId(e.target.value ? Number(e.target.value) : "")
            }
            className={inputCls}
          >
            <option value="">Elegí…</option>
            {legajos.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
          </select>
          {legajos.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">
              No hay legajos en sector “mangueras”.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Sector
          </label>
          <input
            value={sectorNombre}
            readOnly
            className={`${inputCls} bg-gray-100`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Fecha pedido
          </label>
          <input
            value={new Date(inicioRef.current).toLocaleDateString("es-AR")}
            readOnly
            className={`${inputCls} bg-gray-100`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Cliente (n°)
          </label>
          <input
            type="number"
            value={clienteNumero}
            onChange={(e) => setClienteNumero(e.target.value)}
            onBlur={resolveCliente}
            onKeyDown={(e) => e.key === "Enter" && resolveCliente()}
            placeholder="N° de cliente"
            className={inputCls}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Cliente
          </label>
          <input
            value={clienteErr ? "No encontrado" : clienteNombre || ""}
            readOnly
            placeholder="—"
            className={`${inputCls} bg-gray-100 ${clienteErr ? "text-red-600" : ""}`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            N° interno
          </label>
          <input
            value={numInterno}
            onChange={(e) => setNumInterno(e.target.value)}
            placeholder="Cruce de datos"
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Cantidad a producir (n° mangueras)
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Prioridad
          </label>
          <select
            value={prioridad}
            onChange={(e) => setPrioridad(e.target.value)}
            className={inputCls}
          >
            <option>ALTA</option>
            <option>MEDIA</option>
            <option>BAJA</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Estado (auto)
          </label>
          <input
            value={estadoCalc}
            readOnly
            className={`${inputCls} bg-gray-100 font-medium`}
          />
        </div>

        <div className="md:col-span-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Observaciones de corte
          </label>
          <textarea
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            rows={2}
            className={inputCls}
          />
        </div>
      </div>

      {/* CORTES */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Cortes</h2>
          <button
            onClick={() => setModalManguera(true)}
            className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg"
          >
            + Agregar manguera
          </button>
        </div>

        <div className="overflow-x-auto md:overflow-visible">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Código
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Mts / Kgs
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Observación
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {cortes.map((c, i) => (
                <tr key={i}>
                  <td className="px-4 py-2 text-gray-900 font-medium">
                    {c.codigo}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={c.metros}
                      onChange={(e) => setCorteMetros(i, e.target.value)}
                      className="w-24 px-2 py-1 border rounded text-gray-900"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={c.observacion || ""}
                      onChange={(e) => setCorteObs(i, e.target.value)}
                      className="w-44 px-2 py-1 border rounded text-gray-900"
                    >
                      <option value="">—</option>
                      {OBS_OPCIONES.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                      {c.observacion &&
                        !OBS_OPCIONES.includes(c.observacion) && (
                          <option value={c.observacion}>{c.observacion}</option>
                        )}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => removeCorte(i)}
                      className="text-red-500 hover:text-red-700 text-sm"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}

              {/* fila de carga */}
              <tr className="bg-green-50/40">
                <td className="px-4 py-2 relative">
                  <input
                    ref={codeRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value.toUpperCase());
                      if (selected) setSelected(null);
                    }}
                    onKeyDown={onCodeKeyDown}
                    placeholder="Código de manguera…"
                    className="w-full px-2 py-1 border rounded text-gray-900"
                    disabled={!cant || cant <= 0 || cortes.length >= cant}
                  />
                  {!selected && matches.length > 0 && (
                    <ul className="absolute z-20 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow max-h-56 overflow-auto">
                      {matches.map((m) => {
                        const disp = avail(m);
                        return (
                          <li key={m.id}>
                            <button
                              onClick={() => selectManguera(m)}
                              className="w-full text-left px-3 py-2 hover:bg-green-50 text-sm text-gray-900"
                            >
                              <span className="font-medium">{m.codigo}</span>
                              {disp > 0 ? (
                                ` · ${disp} mts`
                              ) : (
                                <span className="text-gray-400">
                                  {" "}
                                  · sin stock
                                </span>
                              )}
                              {m.ubicacion ? ` · ${m.ubicacion}` : ""}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </td>
                <td className="px-4 py-2">
                  <input
                    ref={qtyRef}
                    type="number"
                    min="0"
                    step="0.01"
                    value={qty}
                    disabled={lock}
                    onChange={(e) => setQty(e.target.value)}
                    onKeyDown={onCommitKey}
                    placeholder={selected ? "Metros" : ""}
                    className="w-28 px-2 py-1 border rounded text-gray-900 disabled:bg-gray-100"
                  />
                  {selected && parseFloat(qty) > avail(selected) && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      supera stock (se registra igual)
                    </p>
                  )}
                </td>
                <td className="px-4 py-2">
                  <select
                    value={obs}
                    disabled={lock}
                    onChange={(e) => setObs(e.target.value)}
                    className="w-44 px-2 py-1 border rounded text-gray-900 disabled:bg-gray-100"
                  >
                    <option value="">—</option>
                    {OBS_OPCIONES.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={commitCorte}
                    disabled={lock}
                    className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Agregar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-sm text-gray-600">
            {cortes.length} cortes · {totalMetros} mts · {estadoCalc}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => submit(false)}
              disabled={saving || (cortes.length === 0 && !selected)}
              className="px-5 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => submit(true)}
              disabled={saving || (cortes.length === 0 && !selected)}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Guardando…" : "Terminar y guardar"}
            </button>
          </div>
        </div>
      </div>

      <AddMangueraModal
        isOpen={modalManguera}
        onClose={() => {
          setModalManguera(false);
          router.refresh();
        }}
        codigoPrellenado={query}
      />
    </main>
  );
}
