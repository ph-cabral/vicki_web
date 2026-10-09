"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import styles from "./sorteo.module.css";

type P = {
  fila: number;
  dni: string;
  nombre: string;
  img?: string;
  sector?: string;
};
type AlbumItem = {
  orden: number;
  dni: string;
  nombre: string;
  marco: string;
  premio?: string | null;
  premioImg?: string | null;
  instancia?: number;
  sector?: string | null;
};
type Prz = { file: string; nombre: string; cantidad?: number };
type Inst = { premios: Prz[] };
type Pend = { instIdx: number; offset: number; restante: number; premios: Prz[] };
const qty = (p: Prz) => Math.max(1, p.cantidad ?? 1);
const girosDe = (premios: Prz[]) => premios.reduce((s, p) => s + qty(p), 0);
// Mapea una unidad (giro) dentro de la instancia → premio y su índice (tier).
const premioDeUnidad = (premios: Prz[], unidad: number): { prz?: Prz; idx: number } => {
  let acc = 0;
  for (let j = 0; j < premios.length; j++) {
    if (unidad < acc + qty(premios[j])) return { prz: premios[j], idx: j };
    acc += qty(premios[j]);
  }
  const last = premios.length - 1;
  return { prz: premios[last], idx: Math.max(0, last) };
};

const NS = "http://www.w3.org/2000/svg";
const COLS = 5;
const MAX_ALBUM = 10;
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* Marcos disponibles → /public/marcos/<color>.jpg ; el puesto dentro de la instancia define el color */
const MARCOS = ["oro", "plata", "bronce", "celeste"] as const;
const MEDALLAS = ["🥇", "🥈", "🥉"];
const marcoFile = (m: string) => `/marcos/${m || "oro"}.jpg`;
const premioUrl = (f?: string | null) => (f ? `/premios/${encodeURIComponent(f)}` : "");

/* Formación de la cancha (10 posiciones, se llenan por orden 1..10) */
const POS = [
  { x: 50, y: 90, rol: "ARQ" },
  { x: 17, y: 70, rol: "DEF" },
  { x: 39, y: 73, rol: "DEF" },
  { x: 61, y: 73, rol: "DEF" },
  { x: 83, y: 70, rol: "DEF" },
  { x: 25, y: 48, rol: "MED" },
  { x: 50, y: 50, rol: "MED" },
  { x: 75, y: 48, rol: "MED" },
  { x: 36, y: 25, rol: "DEL" },
  { x: 64, y: 25, rol: "DEL" },
];

const hideEl = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = "none";
};


export default function SorteoClient() {
  const [participantes, setParticipantes] = useState<P[]>([]);
  const [corriendo, setCorriendo] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [clave, setClave] = useState("");
  const [modalMsg, setModalMsg] = useState("");
  const [album, setAlbum] = useState<AlbumItem[]>([]);
  const [instancias, setInstancias] = useState<Inst[]>([]);
  const [instSel, setInstSel] = useState(0); // instancia elegida para sortear
  const [reveal, setReveal] = useState<
    { dni: string; nombre: string; marco: string; sector?: string; premioImg?: string | null; premioNom?: string } | null
  >(null);

  const stripRefs = useRef<(HTMLDivElement | null)[]>([]);
  const reelsRef = useRef<HTMLDivElement>(null);
  const lineasRef = useRef<SVGSVGElement>(null);
  const canchaRef = useRef<HTMLDivElement>(null);
  const revealCardRef = useRef<HTMLDivElement>(null);
  const revealNomRef = useRef<HTMLDivElement>(null);

  const cargarRonda = useCallback(() => {
    return fetch("/api/sorteo/ronda")
      .then((r) => r.json())
      .then((d) => {
        const alb: AlbumItem[] = Array.isArray(d.album) ? d.album : [];
        const raw = Array.isArray(d?.ronda?.instancias) ? d.ronda.instancias : [];
        const insts: Inst[] = raw.map((i: { premios?: Prz[] }) => ({
          premios: Array.isArray(i?.premios)
            ? i.premios.map((p) => ({ file: p.file, nombre: p.nombre, cantidad: qty(p) }))
            : [],
        }));
        setAlbum(alb);
        setInstancias(insts);
        // elegir por defecto la primera instancia no completa
        const done = (k: number) => alb.filter((a) => (a.instancia ?? 0) === k).length;
        const first = insts.findIndex((i, k) => girosDe(i.premios) > 0 && done(k) < girosDe(i.premios));
        setInstSel(first >= 0 ? first : 0);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/sorteo/participantes")
      .then((r) => r.json())
      .then((d) => setParticipantes(d.participantes || []))
      .catch(() => {});
    cargarRonda();
  }, [cargarRonda]);

  // ---- construcción de rodillos (ruleta) ----
  const makeSym = (p: P, win: boolean) => {
    const d = document.createElement("div");
    d.className = styles.sym;
    if (win) d.setAttribute("data-win", "1");
    const img = document.createElement("img");
    img.src = `/api/sorteo/foto/${encodeURIComponent(p.dni)}`;
    img.alt = "";
    img.onerror = () => {
      d.classList.add(styles.noimg);
      d.textContent = p.nombre;
    };
    d.appendChild(img);
    return d;
  };

  const buildStrip = (
    el: HTMLDivElement,
    pool: P[],
    ganador: P,
    steps: number,
    esG: boolean,
    filaObj: number,
  ) => {
    el.style.transition = "none";
    el.style.transform = "translateY(0)";
    el.innerHTML = "";
    const fin = steps + filaObj;
    const len = steps + 3;
    const fp = pool.length ? pool : [ganador];
    for (let i = 0; i < len; i++) {
      const win = esG && i === fin;
      el.appendChild(makeSym(win ? ganador : fp[Math.floor(Math.random() * fp.length)], win));
    }
  };

  const animar = (el: HTMLDivElement, dist: number, dur: number) =>
    new Promise<void>((res) => {
      const t0 = performance.now();
      const frame = (now: number) => {
        const p = Math.min((now - t0) / dur, 1);
        const e = 1 - Math.pow(1 - p, 3);
        el.style.transform = `translateY(${-dist * e}px)`;
        if (p < 1) requestAnimationFrame(frame);
        else res();
      };
      requestAnimationFrame(frame);
    });

  const tirada = (todos: P[], ganador: P) => {
    limpiarReveal();
    const pool = todos.length > 1 ? todos.filter((p) => p.fila !== ganador.fila) : todos;
    const cols = [0, 1, 2, 3, 4];
    const fuera = cols.splice(Math.floor(Math.random() * COLS), 1)[0]; // 1 columna sin ganador → 4 caras
    return Promise.all(
      stripRefs.current.map((el, c) => {
        if (!el) return Promise.resolve();
        const steps = 10 + c * 3;
        const dur = 1400 + c * 550;
        const esG = c !== fuera;
        const filaObj = Math.floor(Math.random() * 3);
        buildStrip(el, pool, ganador, steps, esG, filaObj);
        const ih = (el.firstChild as HTMLElement)?.offsetHeight || 90;
        return animar(el, steps * ih, dur);
      }),
    ).then(() => {});
  };

  // ---- revelar ganador ----
  const dibujarConexion = (wins: NodeListOf<Element>) => {
    const svg = lineasRef.current;
    const reels = reelsRef.current;
    if (!svg || !reels) return;
    const box = reels.getBoundingClientRect();
    svg.setAttribute("width", String(box.width));
    svg.setAttribute("height", String(box.height));
    svg.innerHTML = "";
    const pts = Array.from(wins)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2] as [number, number];
      })
      .sort((a, b) => a[0] - b[0]);
    const poly = document.createElementNS(NS, "polyline") as SVGPolylineElement;
    poly.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
    poly.setAttribute("class", styles.poly);
    svg.appendChild(poly);
    pts.forEach((p) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(p[0]));
      c.setAttribute("cy", String(p[1]));
      c.setAttribute("r", "8");
      c.setAttribute("class", styles.dot);
      svg.appendChild(c);
    });
    const len = poly.getTotalLength();
    poly.style.strokeDasharray = String(len);
    poly.style.strokeDashoffset = String(len);
    poly.getBoundingClientRect();
    poly.style.transition = "stroke-dashoffset .7s ease";
    poly.style.strokeDashoffset = "0";
  };

  const jackpot = (g: P, marco: string, prz?: Prz) => {
    const wins = reelsRef.current?.querySelectorAll("[data-win]");
    if (wins) {
      wins.forEach((e) => e.classList.add(styles.win));
      dibujarConexion(wins);
    }
    setReveal({
      dni: g.dni,
      nombre: g.nombre,
      marco,
      sector: g.sector,
      premioImg: prz?.file ?? null,
      premioNom: prz?.nombre ?? "",
    });
    confeti();
  };

  const limpiarReveal = () => {
    if (lineasRef.current) lineasRef.current.innerHTML = "";
  };

  const confeti = () => {
    const cols = ["#6cb4ee", "#ffffff", "#ffd23f", "#4a90d9", "#f7b500", "#9fd0f5"];
    for (let i = 0; i < 32; i++) {
      const d = document.createElement("div");
      d.className = styles.confeti;
      d.style.left = Math.random() * 100 + "vw";
      d.style.background = cols[i % cols.length];
      d.style.animationDuration = 1.1 + Math.random() * 1.1 + "s";
      d.style.animationDelay = Math.random() * 0.3 + "s";
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 2600);
    }
  };

  // ---- persistencia (tabla Prisma vía /api/sorteo/album, scoped a la ronda activa) ----
  const persistirAlbum = async (
    g: P,
    marco: string,
    premio: string,
    premioImg: string | null,
    instancia: number,
  ): Promise<AlbumItem | null> => {
    try {
      const r = await fetch("/api/sorteo/album", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dni: g.dni, nombre: g.nombre, marco, premio, premioImg, instancia }),
      });
      const d = await r.json();
      if (d.ok && d.item) {
        const it = { ...(d.item as AlbumItem), sector: (d.item.sector ?? g.sector) ?? null };
        setAlbum((prev) => {
          const without = prev.filter((a) => a.dni !== it.dni);
          return [...without, it].sort((a, b) => a.orden - b.orden);
        });
        return it;
      }
    } catch {
      /* noop */
    }
    return null;
  };

  // Vuela la carta grande hasta el slot (índice idx) y la ubica en la cancha.
  const volarACancha = (idx: number) =>
    new Promise<void>((resolve) => {
      const inner = revealCardRef.current;
      const slot = canchaRef.current?.querySelector(`[data-idx="${idx}"]`);
      const slotCard = slot?.querySelector("[data-card]") as HTMLElement | null;
      if (!inner || !slotCard) {
        resolve();
        return;
      }
      if (revealNomRef.current) revealNomRef.current.style.opacity = "0";
      inner.style.animation = "none";
      inner.style.transition = "none";
      inner.style.transform = "none";
      inner.style.transformOrigin = "top left";
      void inner.getBoundingClientRect();
      const s = inner.getBoundingClientRect();
      const d = slotCard.getBoundingClientRect();
      const dx = d.left - s.left;
      const dy = d.top - s.top;
      const sc = s.width ? d.width / s.width : 0.3;
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        inner.removeEventListener("transitionend", fin);
        resolve();
      };
      requestAnimationFrame(() => {
        inner.style.transition = "transform .7s cubic-bezier(.5,0,.2,1), opacity .5s";
        inner.style.transform = `translate(${dx}px, ${dy}px) scale(${sc})`;
        inner.addEventListener("transitionend", fin);
        setTimeout(fin, 850);
      });
    });

  // Ubica al ganador en la cancha al instante (no depende de la DB)
  const agregarLocal = (
    g: P,
    marco: string,
    premio: string,
    premioImg: string | null,
    instancia: number,
    idx: number,
  ) => {
    setAlbum((prev) =>
      prev.some((a) => a.dni === g.dni)
        ? prev
        : [...prev, { orden: idx + 1, dni: g.dni, nombre: g.nombre, marco, premio, premioImg, instancia }].sort(
            (a, b) => a.orden - b.orden,
          ),
    );
  };

  // ---- flujo ----
  const correrSecuencia = async (todos: P[], gs: P[], pend: Pend, real: boolean, clv: string) => {
    setCorriendo(true);
    limpiarReveal();
    const base = album.length;
    for (let i = 0; i < gs.length; i++) {
      const idx = base + i;
      if (idx >= MAX_ALBUM) break;
      const unidad = pend.offset + i; // unidad (giro) dentro de la instancia (0 = mejor)
      const { prz, idx: pIdx } = premioDeUnidad(pend.premios, unidad);
      const marco = MARCOS[Math.min(pIdx, MARCOS.length - 1)];
      const premioNom = prz?.nombre ?? "";
      const premioImg = prz?.file ?? null;
      await tirada(todos, gs[i]);
      jackpot(gs[i], marco, prz);
      await esperar(1600);
      await volarACancha(idx);
      agregarLocal(gs[i], marco, premioNom, premioImg, pend.instIdx, idx);
      if (real) {
        fetch("/api/sorteo/marcar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fila: gs[i].fila, clave: clv }),
        }).catch(() => {});
        await persistirAlbum(gs[i], marco, premioNom, premioImg, pend.instIdx);
      }
      await esperar(150);
      setReveal(null);
      limpiarReveal();
      await esperar(250);
    }
    setCorriendo(false);
    await cargarRonda(); // sincroniza con DB (en prueba descarta lo no persistido; en real trae sector/orden)
  };

  const hechosDe = useCallback(
    (k: number) => album.filter((a) => (a.instancia ?? 0) === k).length,
    [album],
  );
  // Pendiente de la instancia elegida (offset = unidades de ESA instancia ya sorteadas).
  const pendDe = useCallback(
    (k: number): Pend | null => {
      const ins = instancias[k];
      if (!ins) return null;
      const giros = girosDe(ins.premios);
      const done = hechosDe(k);
      if (giros === 0 || done >= giros) return null;
      return { instIdx: k, offset: done, restante: giros - done, premios: ins.premios };
    },
    [instancias, hechosDe],
  );
  const pendActual = pendDe(instSel);

  const iniciar = () => {
    if (corriendo) return;
    if (!pendActual) {
      alert(
        instancias.length === 0
          ? "No hay premios armados. Entrá a «Armar premios»."
          : "El sorteo está completo. Creá un nuevo sorteo para empezar otro.",
      );
      return;
    }
    if (album.length >= MAX_ALBUM) {
      alert("La cancha ya tiene 10. Reiniciá o creá un nuevo sorteo.");
      return;
    }
    setClave("");
    setModalMsg("");
    setModalOpen(true);
  };

  const ejecutar = async (modo: "prueba" | "real") => {
    const pend = pendDe(instSel);
    if (!pend) {
      setModalMsg("No hay instancias pendientes");
      return;
    }
    const n = Math.min(pend.restante, MAX_ALBUM - album.length);
    try {
      const r = await fetch("/api/sorteo/sortear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modo, n, clave }),
      });
      const d = await r.json();
      if (!d.ok) {
        setModalMsg(d.msg || "Error");
        return;
      }
      if (!d.ganadores?.length) {
        setModalMsg("Sin participantes");
        return;
      }
      setModalOpen(false);
      setModalMsg("");
      await correrSecuencia(d.todos as P[], d.ganadores as P[], pend, modo === "real", clave);
    } catch {
      setModalMsg("Error de conexión");
    }
  };

  const reiniciarRonda = async () => {
    if (corriendo) return;
    const clv = window.prompt("Contraseña para vaciar la cancha (pruebas):");
    if (clv == null) return;
    try {
      const r = await fetch("/api/sorteo/ronda", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clave: clv }),
      });
      const d = await r.json();
      if (d.ok) setAlbum([]);
      else window.alert(d.msg || "No autorizado");
    } catch {
      window.alert("Error de conexión");
    }
  };

  const nuevoSorteo = async () => {
    if (corriendo) return;
    const clv = window.prompt("Contraseña para cerrar este sorteo y empezar otro:");
    if (clv == null) return;
    try {
      const r = await fetch("/api/sorteo/ronda", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "nuevo", clave: clv }),
      });
      const d = await r.json();
      if (d.ok) {
        setAlbum([]);
        setInstancias([]);
        window.alert("Nuevo sorteo creado. Entrá a «Armar premios».");
      } else window.alert(d.msg || "No autorizado");
    } catch {
      window.alert("Error de conexión");
    }
  };

  const totalPremios = instancias.reduce((s, i) => s + girosDe(i.premios), 0);
  const cupos = Math.min(totalPremios || MAX_ALBUM, MAX_ALBUM);
  const restanteN = pendActual ? Math.min(pendActual.restante, MAX_ALBUM - album.length) : 0;
  const startPrize = pendActual ? premioDeUnidad(pendActual.premios, pendActual.offset).idx : 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.logoWrap}>
        <img className={styles.logoImg} src="/logo-everwear.svg" alt="Ever Wear 50 años" />
      </div>
      <div className={styles.albiBar} />
      <div className={styles.count}>{participantes.length} participantes registrados</div>

      <div className={styles.arena}>
        {/* IZQUIERDA: álbum cancha */}
        <section className={styles.albumCard}>
          <div className={styles.colTit}>
            🏆 Álbum de Campeones
            <span className={styles.badge}>
              {album.length}/{cupos}
            </span>
          </div>

          <div ref={canchaRef} className={styles.cancha}>
            <div className={`${styles.line} ${styles.lineMid}`} />
            <div className={`${styles.line} ${styles.lineCircle}`} />
            <div className={`${styles.line} ${styles.lineSpot}`} />
            <div className={`${styles.line} ${styles.areaT}`} />
            <div className={`${styles.line} ${styles.sixT}`} />
            <div className={`${styles.line} ${styles.areaB}`} />
            <div className={`${styles.line} ${styles.sixB}`} />

            {POS.map((p, i) => {
              const g = album[i];
              const cls = styles.slot + (g ? "" : " " + styles.vacia);
              return (
                <div key={i} data-idx={i} className={cls} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
                  <div className={styles.dorsal}>{g ? g.orden : i + 1}</div>
                  {g ? (
                    <div className={styles.card} data-card>
                      <img className={styles.marco} src={marcoFile(g.marco)} alt="" onError={hideEl} />
                      <img
                        className={styles.foto}
                        src={`/api/sorteo/foto/${encodeURIComponent(g.dni)}`}
                        alt=""
                        onError={hideEl}
                      />
                      {g.premioImg ? (
                        <img className={styles.premioThumb} src={premioUrl(g.premioImg)} alt="" onError={hideEl} />
                      ) : null}
                      <div className={styles.nom}>{g.nombre}</div>
                      {g.sector ? <div className={styles.sec}>{g.sector}</div> : null}
                    </div>
                  ) : (
                    <div className={styles.card} data-card>
                      <span className={styles.rol}>{p.rol}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.albumFoot}>
            <span className={styles.cont}>
              Equipo: {album.length}/{cupos}
              {pendActual ? "" : album.length > 0 ? " ¡Completo!" : ""}
            </span>
            <button className={styles.btnMini} onClick={reiniciarRonda} disabled={corriendo}>
              ↺ Reiniciar
            </button>
            <button className={styles.btnMini} onClick={nuevoSorteo} disabled={corriendo}>
              ✚ Nuevo sorteo
            </button>
          </div>
        </section>

        {/* DERECHA: ruleta */}
        <section>
          <div className={styles.colTit}>
            🎰 Ruleta
            <Link href="/sistema/sorteo/armar" className={styles.armarLink}>
              🎁 Armar premios
            </Link>
          </div>
          <div className={styles.machine}>
            <div ref={reelsRef} className={styles.reels}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={styles.reel}>
                  <div
                    ref={(el) => {
                      stripRefs.current[i] = el;
                    }}
                    className={styles.strip}
                  />
                </div>
              ))}
              <svg ref={lineasRef} className={styles.lineas} />
            </div>
          </div>

          <div className={styles.controles}>
            {instancias.length > 0 && (
              <div className={styles.instSelRow}>
                <span className={styles.instSelLbl}>Instancia:</span>
                {instancias.map((ins, k) => {
                  const giros = girosDe(ins.premios);
                  const completa = giros > 0 && hechosDe(k) >= giros;
                  return (
                    <button
                      key={k}
                      className={styles.instChip}
                      data-sel={instSel === k || undefined}
                      data-done={completa || undefined}
                      disabled={corriendo || completa || giros === 0}
                      onClick={() => setInstSel(k)}
                      title={`Instancia ${k + 1} · ${giros} ${giros === 1 ? "giro" : "giros"}${completa ? " (completa)" : ""}`}
                    >
                      {k + 1}
                      {completa ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
            )}
            {pendActual && (
              <div className={styles.proxPrem}>
                {pendActual.premios.slice(startPrize).map((p, i) => {
                  const j = startPrize + i;
                  return (
                    <div key={p.file} className={styles.proxItem} title={p.nombre}>
                      <span className={styles.proxPuesto}>{MEDALLAS[j] ?? `${j + 1}°`}</span>
                      <img src={premioUrl(p.file)} alt={p.nombre} onError={hideEl} />
                      {qty(p) > 1 ? <span className={styles.proxCant}>×{qty(p)}</span> : null}
                    </div>
                  );
                })}
              </div>
            )}
            <button
              className={styles.principal}
              onClick={iniciar}
              disabled={corriendo || !pendActual || album.length >= MAX_ALBUM}
            >
              {totalPremios === 0
                ? "▶ Iniciar sorteo"
                : !pendActual
                  ? "✓ Sorteo completo"
                  : `▶ Iniciar — Instancia ${pendActual.instIdx + 1} (${restanteN} ${restanteN === 1 ? "giro" : "giros"})`}
            </button>
            {totalPremios === 0 ? (
              <Link href="/sistema/sorteo/armar" className={styles.btnArmar}>
                🎁 Armar premios
              </Link>
            ) : !pendActual ? (
              <span className={styles.sinPend}>Creá un nuevo sorteo para empezar otro.</span>
            ) : null}
          </div>
        </section>
      </div>

      {modalOpen && (
        <div className={styles.modal} onClick={() => setModalOpen(false)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <h3>Contraseña</h3>
            <input
              type="password"
              placeholder="Contraseña"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
            />
            <div className={styles.modalMsg}>{modalMsg}</div>
            <div className={styles.modalBtns}>
              <button className={styles.btnSec} onClick={() => ejecutar("prueba")}>
                Probar
              </button>
              <button className={styles.principal} onClick={() => ejecutar("real")}>
                Aceptar
              </button>
            </div>
            <button className={styles.cerrar} onClick={() => setModalOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {reveal && (
        <div className={styles.reveal}>
          <div className={styles.revealStack}>
            <div ref={revealCardRef} className={`${styles.revealInner} ${styles.card}`} data-card>
              <img className={styles.marco} src={marcoFile(reveal.marco)} alt="" onError={hideEl} />
              <img
                className={styles.foto}
                src={`/api/sorteo/foto/${encodeURIComponent(reveal.dni)}`}
                alt=""
                onError={hideEl}
              />
              {reveal.premioImg ? (
                <img className={styles.premioThumb} src={premioUrl(reveal.premioImg)} alt="" onError={hideEl} />
              ) : null}
              <div className={styles.nom}>{reveal.nombre}</div>
              {reveal.sector ? <div className={styles.sec}>{reveal.sector}</div> : null}
            </div>
            <div ref={revealNomRef} className={styles.revealNom}>
              {reveal.nombre}
              {reveal.premioNom ? <span className={styles.revealPrz}>{reveal.premioNom}</span> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
