"use client";

/**
 * Barra de CVs del chat de Vicki (solo escritorio).
 *
 * Muestra las miniaturas de los candidatos que devolvió la búsqueda al costado
 * de la conversación: arriba los recomendados de la última respuesta, abajo el
 * resto de lo que fue apareciendo en la charla. Click abre el CV en un modal;
 * arrastrar la tarjeta al tacho lo saca de la conversación (no de la base).
 *
 * Las miniaturas y el PDF salen de /api/vicki/cv/<documento_id>/... — las
 * genera la ingesta (vicki_mail) y las sirve chat-agent desde el store
 * compartido, así que acá no hay ninguna llamada a Drive.
 */

import { useEffect, useState } from "react";

export type Candidato = {
  candidato_id: number | null;
  documento_id: number | null;
  nombre: string;
  email: string;
  score: number | null;
  archivo: boolean;
  thumb: boolean;
  nombre_archivo: string | null;
  mencionado: boolean;
};

export const claveCandidato = (c: Candidato) =>
  c.candidato_id != null ? `c${c.candidato_id}` : `d${c.documento_id ?? c.nombre}`;

function iniciales(nombre: string) {
  return nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/* ── tarjeta ───────────────────────────────────────────────────────────── */

function Tarjeta({
  c,
  destacado,
  onAbrir,
  onArrastrar,
}: {
  c: Candidato;
  destacado: boolean;
  onAbrir: () => void;
  onArrastrar: (c: Candidato | null) => void;
}) {
  const url = c.documento_id ? `/api/vicki/cv/${c.documento_id}/thumb` : null;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // texto por compatibilidad: Firefox no arranca el drag sin datos
        e.dataTransfer.setData("text/plain", claveCandidato(c));
        onArrastrar(c);
      }}
      onDragEnd={() => onArrastrar(null)}
      onClick={onAbrir}
      title={`${c.nombre}${c.email ? ` — ${c.email}` : ""}`}
      className={`group cursor-pointer rounded-lg border bg-zinc-900 p-1.5 transition-colors ${
        destacado
          ? "border-blue-600/70 hover:border-blue-500"
          : "border-zinc-800 hover:border-zinc-600"
      }`}
    >
      <div className="relative aspect-[1/1.3] w-full overflow-hidden rounded bg-zinc-800">
        {url && c.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={c.nombre}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-zinc-500">
            {iniciales(c.nombre) || "CV"}
          </div>
        )}
        {!c.archivo && (
          <span className="absolute bottom-1 left-1 rounded bg-zinc-950/80 px-1 text-[10px] text-zinc-400">
            sin archivo
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-[11px] leading-tight text-zinc-200">
        {c.nombre}
      </p>
      {c.score != null && (
        <p className="truncate text-[10px] text-zinc-500">
          afinidad {(c.score * 100).toFixed(0)}%
        </p>
      )}
    </div>
  );
}

/* ── modal ─────────────────────────────────────────────────────────────── */

function ModalCv({
  c,
  onCerrar,
  onDescartar,
}: {
  c: Candidato;
  onCerrar: () => void;
  onDescartar: (c: Candidato) => void;
}) {
  const [texto, setTexto] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCerrar]);

  // sin PDF guardado (histórico que el backfill no pudo matchear): se muestra
  // el texto que ya está en la base
  useEffect(() => {
    if (c.archivo || !c.documento_id) return;
    let vivo = true;
    fetch(`/api/vicki/cv/${c.documento_id}/texto`)
      .then((r) => r.json())
      .then((d) => vivo && setTexto(d.texto ?? ""))
      .catch(() => vivo && setTexto(""));
    return () => {
      vivo = false;
    };
  }, [c]);

  const src = c.documento_id ? `/api/vicki/cv/${c.documento_id}/file` : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCerrar}
    >
      <div
        className="flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">
              {c.nombre}
            </h2>
            <p className="truncate text-xs text-zinc-500">
              {c.email || c.nombre_archivo || ""}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {c.archivo && src && (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                Abrir aparte
              </a>
            )}
            <button
              onClick={() => onDescartar(c)}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-red-700 hover:text-white"
            >
              Sacar de la charla
            </button>
            <button
              onClick={onCerrar}
              className="rounded-md px-2 py-1.5 text-lg leading-none text-zinc-400 hover:text-white"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto bg-zinc-950">
          {c.archivo && src ? (
            <iframe src={src} className="h-full w-full" title={`CV de ${c.nombre}`} />
          ) : texto === null ? (
            <p className="p-6 text-sm text-zinc-500">Cargando…</p>
          ) : texto ? (
            <pre className="whitespace-pre-wrap p-6 text-xs leading-relaxed text-zinc-300">
              {texto}
            </pre>
          ) : (
            <p className="p-6 text-sm text-zinc-500">
              No hay archivo guardado para este CV.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── barra ─────────────────────────────────────────────────────────────── */

export function CvBarra({
  candidatos,
  recomendados,
  descartados,
  onDescartar,
  onRecuperar,
  abierta = false,
  onCerrar,
}: {
  candidatos: Candidato[];
  recomendados: Set<string>;
  descartados: Candidato[];
  onDescartar: (c: Candidato) => void;
  onRecuperar: (c: Candidato) => void;
  // En pantallas angostas la barra no entra al costado del chat: se abre como
  // panel sobre la conversación con el botón «CVs» del encabezado. Desde lg
  // (1024px) va siempre fija a la derecha y estos dos no hacen nada.
  abierta?: boolean;
  onCerrar?: () => void;
}) {
  const [abierto, setAbierto] = useState<Candidato | null>(null);
  const [arrastrando, setArrastrando] = useState<Candidato | null>(null);
  const [sobreTacho, setSobreTacho] = useState(false);
  const [verDescartados, setVerDescartados] = useState(false);

  const destacados = candidatos.filter((c) => recomendados.has(claveCandidato(c)));
  const resto = candidatos.filter((c) => !recomendados.has(claveCandidato(c)));

  const tarjeta = (c: Candidato, destacado: boolean) => (
    <Tarjeta
      key={claveCandidato(c)}
      c={c}
      destacado={destacado}
      onAbrir={() => setAbierto(c)}
      onArrastrar={setArrastrando}
    />
  );

  return (
    <>
      {/* Antes era `hidden … xl:flex`: abajo de 1280px CSS la barra no se
          dibujaba nunca y el reclutador no veía ningún CV (en una notebook con
          escalado de Windows, 1280 no se alcanza). Ahora entra desde lg y, más
          abajo, se abre como panel con el botón «CVs» del encabezado. */}
      <aside
        className={`${
          abierta ? "fixed inset-y-0 right-0 z-40 flex shadow-2xl shadow-black/60" : "hidden"
        } w-60 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 lg:static lg:z-auto lg:flex lg:shadow-none`}
      >
        {onCerrar && (
          <button
            onClick={onCerrar}
            className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400 hover:text-white lg:hidden"
          >
            <span>CVs de la conversación</span>
            <span className="text-lg leading-none">×</span>
          </button>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {candidatos.length === 0 && (
            <p className="px-1 text-xs leading-relaxed text-zinc-600">
              Cuando busques candidatos van a aparecer acá sus CVs. Click para
              verlo, o arrastralo al tacho para sacarlo de la conversación.
            </p>
          )}

          {destacados.length > 0 && (
            <>
              <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-blue-400">
                Recomendados
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {destacados.map((c) => tarjeta(c, true))}
              </div>
            </>
          )}

          {resto.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                En la conversación
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {resto.map((c) => tarjeta(c, false))}
              </div>
            </>
          )}
        </div>

        {/* tacho: aparece cuando arrastrás una tarjeta */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setSobreTacho(true);
          }}
          onDragLeave={() => setSobreTacho(false)}
          onDrop={(e) => {
            e.preventDefault();
            setSobreTacho(false);
            if (arrastrando) onDescartar(arrastrando);
            setArrastrando(null);
          }}
          className={`m-3 rounded-lg border-2 border-dashed py-6 text-center text-xs transition-colors ${
            sobreTacho
              ? "border-red-500 bg-red-950/40 text-red-200"
              : arrastrando
                ? "border-zinc-600 text-zinc-400"
                : "border-zinc-800 text-zinc-600"
          }`}
        >
          🗑️ {sobreTacho ? "Soltá para sacarlo" : "Tacho de la conversación"}
        </div>

        {descartados.length > 0 && (
          <div className="border-t border-zinc-800 px-3 py-2">
            <button
              onClick={() => setVerDescartados((v) => !v)}
              className="w-full text-left text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              {descartados.length} descartado{descartados.length > 1 ? "s" : ""}{" "}
              {verDescartados ? "▾" : "▸"}
            </button>
            {verDescartados && (
              <ul className="mt-2 space-y-1 pb-2">
                {descartados.map((c) => (
                  <li
                    key={claveCandidato(c)}
                    className="flex items-center gap-2 text-[11px] text-zinc-400"
                  >
                    <span className="truncate">{c.nombre}</span>
                    <button
                      onClick={() => onRecuperar(c)}
                      className="ml-auto shrink-0 text-blue-400 hover:text-blue-300"
                    >
                      volver
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      {abierto && (
        <ModalCv
          c={abierto}
          onCerrar={() => setAbierto(null)}
          onDescartar={(c) => {
            onDescartar(c);
            setAbierto(null);
          }}
        />
      )}
    </>
  );
}
