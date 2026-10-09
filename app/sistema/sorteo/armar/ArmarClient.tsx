"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./armar.module.css";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

type Prz = { file: string; nombre: string; cantidad?: number };
type Inst = { premios: Prz[] };

const MAX = 10;
const urlOf = (f: string) => `/premios/${encodeURIComponent(f)}`;
const MEDALLAS = ["🥇", "🥈", "🥉"];
const qty = (p: Prz) => Math.max(1, p.cantidad ?? 1);
const hideImg = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = "hidden";
};

export default function ArmarClient() {
  const [paletaAll, setPaletaAll] = useState<{ file: string; nombre: string }[]>([]);
  const [instancias, setInstancias] = useState<Inst[]>([]);
  const [dropQty, setDropQty] = useState<Record<string, number>>({});
  const [locked, setLocked] = useState(false);
  const [ganadores, setGanadores] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  const [target, setTarget] = useState(0); // instancia destino para el botón ＋

  const drag = useRef<{ file: string; nombre: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [pr, rd] = await Promise.all([
          fetch("/api/sorteo/premios").then((r) => r.json()),
          fetch("/api/sorteo/ronda").then((r) => r.json()),
        ]);
        if (Array.isArray(pr?.premios))
          setPaletaAll(pr.premios.map((p: Prz) => ({ file: p.file, nombre: p.nombre })));
        const insts = Array.isArray(rd?.ronda?.instancias) ? rd.ronda.instancias : [];
        setInstancias(
          insts.map((i: { premios?: Prz[] }) => ({
            premios: Array.isArray(i?.premios)
              ? i.premios.map((p) => ({ file: p.file, nombre: p.nombre, cantidad: qty(p) }))
              : [],
          })),
        );
        const album = Array.isArray(rd?.album) ? rd.album : [];
        setGanadores(album.length);
        setLocked(album.length > 0);
      } catch {
        setMsg("No se pudo cargar.");
      }
      setCargando(false);
    })();
  }, []);

  // unidades ya colocadas por imagen (para mostrar feedback en la paleta)
  const placed = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of instancias) for (const p of i.premios) m.set(p.file, (m.get(p.file) ?? 0) + qty(p));
    return m;
  }, [instancias]);
  // total = unidades totales (suma de cantidades en todas las instancias)
  const total = useMemo(
    () => instancias.reduce((s, i) => s + i.premios.reduce((a, p) => a + qty(p), 0), 0),
    [instancias],
  );
  const getDrop = (file: string) => Math.max(1, dropQty[file] ?? 1);

  // ---- mutaciones ----
  // Suma `n` unidades del premio a la instancia idx (el premio NO se consume de la paleta).
  const addUnits = (idx: number, file: string, nombre: string, n: number) => {
    let add = Math.max(1, Math.floor(n || 1));
    if (total + add > MAX) add = MAX - total;
    if (add <= 0) {
      setMsg(`Tope de ${MAX} premios en la cancha.`);
      return;
    }
    setInstancias((prev) => {
      const next = prev.map((i) => ({ premios: i.premios.map((p) => ({ ...p })) }));
      const inst = next[idx];
      if (!inst) return prev;
      const f = inst.premios.find((p) => p.file === file);
      if (f) f.cantidad = qty(f) + add;
      else inst.premios.push({ file, nombre, cantidad: add });
      return next;
    });
    setMsg("");
  };

  const quitarDeInst = (idx: number, file: string) =>
    setInstancias((prev) => {
      const next = prev.map((i) => ({ premios: [...i.premios] }));
      if (next[idx]) next[idx].premios = next[idx].premios.filter((p) => p.file !== file);
      return next;
    });

  const cambiarUnidad = (idx: number, pos: number, delta: number) =>
    setInstancias((prev) => {
      const next = prev.map((i) => ({ premios: i.premios.map((p) => ({ ...p })) }));
      const fila = next[idx]?.premios[pos];
      if (!fila) return prev;
      if (delta > 0 && total >= MAX) {
        setMsg(`Tope de ${MAX} premios en la cancha.`);
        return prev;
      }
      const v = qty(fila) + delta;
      if (v <= 0) next[idx].premios = next[idx].premios.filter((_, j) => j !== pos);
      else fila.cantidad = v;
      return next;
    });

  const moverPremio = (idx: number, pos: number, dir: -1 | 1) =>
    setInstancias((prev) => {
      const next = prev.map((i) => ({ premios: [...i.premios] }));
      const arr = next[idx]?.premios;
      const j = pos + dir;
      if (arr && j >= 0 && j < arr.length) [arr[pos], arr[j]] = [arr[j], arr[pos]];
      return next;
    });

  const moverInstancia = (idx: number, dir: -1 | 1) =>
    setInstancias((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j >= 0 && j < next.length) [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const agregarInstancia = () => {
    setInstancias((prev) => [...prev, { premios: [] }]);
    setTarget(instancias.length);
  };

  const quitarInstancia = (idx: number) => {
    setInstancias((prev) => prev.filter((_, i) => i !== idx));
    setTarget(0);
  };

  // ---- guardar / nuevo ----
  const guardar = async () => {
    if (instancias.length === 0) return setMsg("Agregá al menos una instancia.");
    if (instancias.some((i) => i.premios.length === 0))
      return setMsg("Hay instancias vacías: quitalas o agregales premios.");
    setGuardando(true);
    setMsg("");
    try {
      const body = {
        instancias: instancias.map((inst, i) => ({
          orden: i + 1,
          premios: inst.premios.map((p) => ({ file: p.file, nombre: p.nombre, cantidad: qty(p) })),
        })),
      };
      const r = await fetch("/api/sorteo/ronda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setMsg(d.ok ? "✓ Guardado. Ya podés ir al sorteo." : d.msg || "No se pudo guardar.");
      if (!d.ok && r.status === 409) setLocked(true);
    } catch {
      setMsg("Error de conexión.");
    }
    setGuardando(false);
  };

  const nuevoSorteo = async () => {
    const clv = window.prompt("Contraseña para cerrar la ronda actual y empezar otra:");
    if (clv == null) return;
    try {
      const r = await fetch("/api/sorteo/ronda", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "nuevo", clave: clv }),
      });
      const d = await r.json();
      if (d.ok) {
        setInstancias([]);
        setGanadores(0);
        setLocked(false);
        setMsg("Nuevo sorteo creado. Armá los premios.");
      } else window.alert(d.msg || "No autorizado");
    } catch {
      window.alert("Error de conexión");
    }
  };

  if (cargando)
    return (
      <div className={styles.wrap}>
        <div className={styles.cargando}>Cargando…</div>
      </div>
    );

  const destino = Math.min(target, Math.max(instancias.length - 1, 0));

  return (
    <div className={styles.wrap}>
      <header className={styles.top}>
        <Link href="/" className={styles.volver}>
          ← Inicio
        </Link>
        <Link href="/sistema/sorteo" className={styles.volver}>
          ← Sorteo
        </Link>
        <h1 className={styles.titulo}>🎁 Armar premios</h1>
        <span className={styles.contador} data-full={total >= MAX || undefined}>
          {total}/{MAX}
        </span>
        <UsuarioActual className="ml-auto" />
      </header>

      {locked && (
        <div className={styles.aviso}>
          Ronda en curso ({ganadores} {ganadores === 1 ? "ganador" : "ganadores"}). Para
          rearmar premios tenés que cerrarla y empezar otra.
          <button className={styles.btnNuevo} onClick={nuevoSorteo}>
            Nuevo sorteo
          </button>
        </div>
      )}

      <div className={styles.cols} data-locked={locked || undefined}>
        {/* PALETA */}
        <section className={styles.paletaCol}>
          <div className={styles.colTit}>
            Premios <small>(elegí la cantidad y arrastrá; se pueden repetir en varias instancias)</small>
          </div>
          <div className={styles.paleta}>
            {paletaAll.length === 0 && (
              <div className={styles.vacio}>No hay imágenes en /public/premios.</div>
            )}
            {paletaAll.map((p) => {
              const usados = placed.get(p.file) ?? 0;
              return (
                <div
                  key={p.file}
                  className={styles.tile}
                  draggable={!locked}
                  onDragStart={() => (drag.current = { file: p.file, nombre: p.nombre })}
                  title={p.nombre}
                >
                  <img src={urlOf(p.file)} alt={p.nombre} onError={hideImg} />
                  <span className={styles.tileNom}>{p.nombre}</span>
                  <div className={styles.tileQty} onClick={(e) => e.stopPropagation()}>
                    <span>×</span>
                    <input
                      type="number"
                      min={1}
                      value={getDrop(p.file)}
                      disabled={locked}
                      onChange={(e) =>
                        setDropQty((q) => ({ ...q, [p.file]: Math.max(1, parseInt(e.target.value) || 1) }))
                      }
                    />
                    <button
                      className={styles.addBtn}
                      disabled={locked}
                      title="Agregar a la instancia seleccionada"
                      onClick={() => {
                        if (instancias.length === 0) return setMsg("Agregá una instancia primero.");
                        addUnits(destino, p.file, p.nombre, getDrop(p.file));
                      }}
                    >
                      ＋
                    </button>
                  </div>
                  {usados > 0 ? <span className={styles.usados}>en cancha: {usados}</span> : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* INSTANCIAS */}
        <section className={styles.instCol}>
          <div className={styles.colTit}>
            Instancias <small>(orden de tirada · premios de mejor a peor)</small>
          </div>

          {instancias.map((inst, idx) => {
            const giros = inst.premios.reduce((a, p) => a + qty(p), 0);
            return (
              <div
                key={idx}
                className={styles.inst}
                data-target={target === idx || undefined}
                onClick={() => setTarget(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (drag.current) addUnits(idx, drag.current.file, drag.current.nombre, getDrop(drag.current.file));
                  drag.current = null;
                }}
              >
                <div className={styles.instHead}>
                  <strong>Instancia {idx + 1}</strong>
                  <span className={styles.instInfo}>
                    {inst.premios.length} {inst.premios.length === 1 ? "premio" : "premios"} · {giros} giros
                  </span>
                  <span className={styles.instBtns}>
                    <button onClick={() => moverInstancia(idx, -1)} disabled={idx === 0} title="Subir">
                      ▲
                    </button>
                    <button
                      onClick={() => moverInstancia(idx, 1)}
                      disabled={idx === instancias.length - 1}
                      title="Bajar"
                    >
                      ▼
                    </button>
                    <button className={styles.del} onClick={() => quitarInstancia(idx)} title="Quitar instancia">
                      ✕
                    </button>
                  </span>
                </div>

                <div className={styles.instBody}>
                  {inst.premios.length === 0 && (
                    <div className={styles.dropHint}>Arrastrá premios acá (o usá ＋)</div>
                  )}
                  {inst.premios.map((p, pos) => (
                    <div key={p.file} className={styles.przRow}>
                      <span className={styles.puesto}>{MEDALLAS[pos] ?? `${pos + 1}°`}</span>
                      <img src={urlOf(p.file)} alt={p.nombre} onError={hideImg} />
                      <span className={styles.przNom}>{p.nombre}</span>
                      <span className={styles.qtyCtl}>
                        <button onClick={() => cambiarUnidad(idx, pos, -1)} title="Menos">
                          −
                        </button>
                        <b>×{qty(p)}</b>
                        <button onClick={() => cambiarUnidad(idx, pos, 1)} title="Más">
                          ＋
                        </button>
                      </span>
                      <span className={styles.przBtns}>
                        <button onClick={() => moverPremio(idx, pos, -1)} disabled={pos === 0} title="Mejor">
                          ▲
                        </button>
                        <button
                          onClick={() => moverPremio(idx, pos, 1)}
                          disabled={pos === inst.premios.length - 1}
                          title="Peor"
                        >
                          ▼
                        </button>
                        <button className={styles.del} onClick={() => quitarDeInst(idx, p.file)} title="Quitar">
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <button className={styles.btnInst} onClick={agregarInstancia} disabled={locked}>
            ＋ Agregar instancia
          </button>
        </section>
      </div>

      <div className={styles.barra}>
        <span className={styles.msg}>{msg}</span>
        <Link href="/sistema/sorteo" className={styles.btnSec}>
          Ir al sorteo
        </Link>
        <button className={styles.btnGuardar} onClick={guardar} disabled={guardando || locked}>
          {guardando ? "Guardando…" : "Guardar plan"}
        </button>
      </div>
    </div>
  );
}
