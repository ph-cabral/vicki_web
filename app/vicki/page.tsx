"use client";

import { Fragment, useEffect, useRef, useState, useCallback} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import {
  CvBarra,
  claveCandidato,
  type Candidato,
} from "@/components/vicki/CvBarra";

type Msg = { role: "user" | "assistant"; content: string };

const GENEROS = [
  { label: "Masculino", value: "male" },
  { label: "Femenino", value: "female" },
];
const UBICACIONES = [
  { label: "Fábrica", value: "Fabrica" },
  { label: "Lilser", value: "Lilser" },
  { label: "Oficina", value: "Oficina" },
];

// Detecta si el último mensaje del asistente abrió el flujo de creación
function isAwaitingEmployeeData(messages: Msg[]) {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return false;
  return /Foto tomada/i.test(last.content);
}

function parseInlineBold(line: string, keyBase: string) {
  const boldRegex = /\*\*(.+?)\*\*/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = boldRegex.exec(line)) !== null) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    nodes.push(
      <strong key={`${keyBase}-b${idx++}`} className="font-semibold text-white">
        {m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

function renderTextBlock(text: string, keyBase: string) {
  const cleaned = text.replace(
    /\[(LOC_PICK|UPLOAD_PICK|CONFIRM_PICK|NAME_PICK:[^\]]*)\]/g,
    "",
  );
  const paragraphs = cleaned.split(/\n{2,}/);

  return paragraphs.map((para, pi) => {
    const lines = para.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;

    const isList = lines.every((l) => /^\s*[-•]\s+/.test(l));
    if (isList) {
      return (
        <ul key={`${keyBase}-p${pi}`} className="list-disc pl-5 my-2 space-y-1">
          {lines.map((l, li) => (
            <li key={`${keyBase}-p${pi}-l${li}`}>
              {parseInlineBold(
                l.replace(/^\s*[-•]\s+/, ""),
                `${keyBase}-p${pi}-l${li}`,
              )}
            </li>
          ))}
        </ul>
      );
    }

    return (
      <p key={`${keyBase}-p${pi}`} className="my-2 leading-relaxed first:mt-0 last:mb-0">
        {lines.map((l, li) => (
          <Fragment key={`${keyBase}-p${pi}-l${li}`}>
            {li > 0 && <br />}
            {parseInlineBold(l, `${keyBase}-p${pi}-l${li}`)}
          </Fragment>
        ))}
      </p>
    );
  });
}

function renderContent(
  text: string,
  onCancel?: () => void,
  onRetake?: () => void,
) {
  const imgRegex = /!\[[^\]]*\]\((data:image\/[^)]+)\)/g;
  const parts: Array<{ t: "text" | "img"; v: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
    parts.push({ t: "img", v: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });

  return parts.map((p, i) =>
    p.t === "img" ? (
      <div key={i} className="my-2 flex flex-col sm:flex-row items-start gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={p.v}
          alt="foto"
          className="rounded-lg w-full max-w-xs border border-zinc-700"
        />
        {(onCancel || onRetake) && (
          <div className="flex flex-row sm:flex-col gap-2">
            {onRetake && (
              <button
                onClick={onRetake}
                className="rounded-md bg-zinc-600 hover:bg-zinc-500 px-3 py-1.5 text-xs text-white shrink-0"
              >
                🔄 Sacar de nuevo
              </button>
            )}
            {onCancel && (
              <button
                onClick={onCancel}
                className="rounded-md bg-red-600 hover:bg-red-700 px-3 py-1.5 text-xs text-white shrink-0"
              >
                Cancelar
              </button>
            )}
          </div>
        )}
      </div>
    ) : (
      <div key={i}>{renderTextBlock(p.v, `t${i}`)}</div>
    ),
  );
}

export default function VickiPage() {
  // session_id real del usuario logueado (antes era "user_1" fijo para
  // todo el mundo: no se podía separar historial ni filtrar datos por
  // persona — ver /api/vicki/chat/route.ts para el filtro de ventas).
  // USER_ID vacío hasta que responde /api/auth/me: SESSION_ID queda "" y los
  // efectos que dependen de él esperan a que haya uno real.
  const [userId, setUserId] = useState<string>("");
  const sessionId = userId ? `user_${userId}` : "";
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.usuario?.uid != null) setUserId(String(d.usuario.uid));
      })
      .catch(() => {});
  }, []);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [gender, setGender] = useState<string>("");
  const [location, setLocation] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [pickingLocation, setPickingLocation] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [namePick, setNamePick] = useState<string[]>([]);
  // Barra de CVs: `candidatos` acumula lo que fue apareciendo en la charla y
  // `recomendados` marca los de la última respuesta. `descartados` son los que
  // se tiraron al tacho (salen de la barra y de las próximas búsquedas).
  const [candidatos, setCandidatos] = useState<Candidato[]>([]);
  const [recomendados, setRecomendados] = useState<Set<string>>(new Set());
  // Sólo para pantallas angostas (abajo de lg la barra no entra al costado).
  const [barraAbierta, setBarraAbierta] = useState(false);
  const [descartados, setDescartados] = useState<Candidato[]>([]);
  // Mensajes que quedaron atrás del corte de «Nueva conversación»: están en
  // la base, sólo que no se muestran hasta que los pidas.
  const [anteriores, setAnteriores] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Cargar historial (espera a tener el session_id real del usuario).
  // Por defecto trae la conversación EN CURSO; con `todo` trae también lo
  // anterior al corte de «Nueva conversación» (nada se borra nunca).
  const cargarHistorial = useCallback(
    async (todo = false) => {
      if (!sessionId) return;
      try {
        const r = await fetch(
          `/api/vicki/history/${sessionId}${todo ? "?todo=1" : ""}`,
        );
        if (!r.ok) return;
        const data = await r.json();
        const map: Record<string, "user" | "assistant"> = {
          human: "user",
          ai: "assistant",
        };
        const hist: Msg[] = (data.history ?? []).map((m: any) => ({
          role: map[m.role] ?? m.role,
          content: m.content,
        }));
        setMessages(hist);
        setAnteriores(todo ? 0 : Number(data.anteriores ?? 0));

        // Reconstruir la barra de CVs: cada mensaje "ai" de búsqueda guardó
        // sus candidatos en metadata. Se recorre al revés para que los de la
        // última respuesta queden primeros y marcados como recomendados.
        const vistos = new Set<string>();
        const acum: Candidato[] = [];
        let ultimos: Candidato[] = [];
        for (const m of [...(data.history ?? [])].reverse()) {
          const cands: Candidato[] = m?.metadata?.candidatos ?? [];
          if (!cands.length) continue;
          if (!ultimos.length) ultimos = cands;
          for (const c of cands) {
            const k = claveCandidato(c);
            if (vistos.has(k)) continue;
            vistos.add(k);
            acum.push(c);
          }
        }
        const ids: number[] = data.descartados ?? [];
        const fuera = new Set(ids);
        setCandidatos(acum.filter((c) => !(c.candidato_id != null && fuera.has(c.candidato_id))));
        setDescartados(acum.filter((c) => c.candidato_id != null && fuera.has(c.candidato_id)));
        setRecomendados(
          new Set(
            ultimos
              .filter((c) => !(c.candidato_id != null && fuera.has(c.candidato_id)))
              .map(claveCandidato),
          ),
        );
      } catch {}
    },
    [sessionId],
  );

  useEffect(() => {
    cargarHistorial();
  }, [cargarHistorial]);

  // «Nueva conversación»: Vicki arranca de cero (deja de arrastrar el puesto y
  // el tema de la charla anterior). Los mensajes NO se borran — quedan atrás
  // del corte y se vuelven a ver con «Ver anteriores».
  async function nuevaConversacion() {
    if (!sessionId || loading) return;
    try {
      const r = await fetch(`/api/vicki/conversacion/${sessionId}`, { method: "POST" });
      if (!r.ok) return;
      await cargarHistorial();
    } catch {}
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const [awaitingEmp, setAwaitingEmp] = useState(false);

  // useEffect(() => {
  //   const last = [...messages].reverse().find((m) => m.role === "assistant");
  //   setPickingLocation(!!last && /\[LOC_PICK\]/.test(last.content));
  //   fetch(`/api/vicki/draft_status/${SESSION_ID}`)
  //     .then((r) => r.json())
  //     .then((d) => setAwaitingEmp(!!d.has_draft));
  // }, [messages]);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    setPickingLocation(!!last && /\[LOC_PICK\]/.test(last.content));
    setShowUpload(!!last && /\[UPLOAD_PICK\]/.test(last.content));
    setShowConfirm(!!last && /\[CONFIRM_PICK\]/.test(last.content));
    const np = last?.content.match(/\[NAME_PICK:([^\]]*)\]/);
    setNamePick(np ? np[1].split("|").filter(Boolean) : []);
    if (last && /Foto tomada/i.test(last.content)) setAwaitingEmp(true);
    if (!sessionId) return;
    fetch(`/api/vicki/draft_status/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setAwaitingEmp(!!d.has_draft));
  }, [messages, sessionId]);

  const inputLocked = awaitingEmp && (!gender || !location);
  const placeholder = awaitingEmp
    ? !gender || !location
      ? "Seleccioná sexo y ubicación primero"
      : "Nombre y apellido del empleado…"
    : "Escribí tu mensaje… (ej: /crea empleado)";

  // Los nuevos van primero (son los de la última respuesta) y se deduplica
  // contra lo que ya estaba: el mismo candidato puede volver a salir en varias
  // búsquedas de la misma conversación.
  function mergeCandidatos(nuevos: Candidato[]) {
    if (!nuevos?.length) {
      setRecomendados(new Set());
      return;
    }
    setRecomendados(new Set(nuevos.map(claveCandidato)));
    setCandidatos((prev) => {
      const claves = new Set(nuevos.map(claveCandidato));
      return [...nuevos, ...prev.filter((c) => !claves.has(claveCandidato(c)))];
    });
  }

  function quitarDeBarra(c: Candidato) {
    const clave = claveCandidato(c);
    setCandidatos((prev) => prev.filter((x) => claveCandidato(x) !== clave));
    setRecomendados((prev) => {
      const s = new Set(prev);
      s.delete(clave);
      return s;
    });
  }

  async function descartar(c: Candidato) {
    quitarDeBarra(c);
    setDescartados((prev) => [c, ...prev.filter((x) => claveCandidato(x) !== claveCandidato(c))]);
    // sin candidato_id (puntos viejos de Qdrant sin esa metadata) no se puede
    // persistir el descarte: se oculta solo en esta pantalla
    if (c.candidato_id == null) return;
    try {
      await fetch(`/api/vicki/descartes/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidato_id: c.candidato_id }),
      });
    } catch {}
  }

  async function recuperar(c: Candidato) {
    setDescartados((prev) => prev.filter((x) => claveCandidato(x) !== claveCandidato(c)));
    setCandidatos((prev) => [c, ...prev.filter((x) => claveCandidato(x) !== claveCandidato(c))]);
    if (c.candidato_id == null) return;
    try {
      await fetch(`/api/vicki/descartes/${sessionId}/${c.candidato_id}`, {
        method: "DELETE",
      });
    } catch {}
  }

  async function send(message: string) {
    if (!message.trim() || loading || !sessionId) return;
    const userMsg: Msg = { role: "user", content: message };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const payload: any = {
      message,
      session_id: sessionId,
      user_id: userId,
    };
    if (awaitingEmp && gender && location) {
      payload.gender = gender;
      payload.location = location;
    }

    try {
      const r = await fetch("/api/vicki/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      const answer = data.response ?? `Error: ${data.error ?? "desconocido"}`;
      setMessages((prev) => [...prev, { role: "assistant", content: answer }]);
      mergeCandidatos(data.candidatos ?? []);

      if (/Empleado \*\*\d+\*\*/.test(answer) || answer.startsWith("✅")) {
        setGender("");
        setLocation("");
      }
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error de conexión: ${e?.message ?? e}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function cancelEmployee() {
    try {
      await fetch(`/api/vicki/cancel_employee/${sessionId}`, {
        method: "POST",
      });
    } catch {}
    setGender("");
    setLocation("");
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "❌ Operación cancelada." },
    ]);
  }

  async function pickLocation(loc: string, retake = false) {
    if (!sessionId) return;
    setLoading(true);
    try {
      const r = await fetch("/api/vicki/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: loc,
          session_id: sessionId,
          user_id: userId,
          location: loc,
          retake,
        }),
      });
      const data = await r.json();
      setMessages((prev) => [
        ...prev,
        { role: "user", content: retake ? `🔄 ${loc}` : `📍 ${loc}` },
        { role: "assistant", content: data.response },
      ]);
      setLocation(loc);
    } finally {
      setLoading(false);
    }
  }

  async function retakePhoto() {
    if (!location || loading) return;
    await pickLocation(location, true);
  }

  // Reduce la imagen en el navegador (max 800px, JPEG) para no mandar
  // megas de base64: el reloj igual la recibe achicada a 640px.
  async function fileToJpegDataUrl(file: File, maxSide = 800): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas no disponible");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function uploadImage(file: File) {
    if (loading || !sessionId) return;
    setLoading(true);
    try {
      let dataUrl: string;
      try {
        dataUrl = await fileToJpegDataUrl(file);
      } catch {
        // formato que el navegador no decodifica (ej. HEIC): mandar crudo
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(file);
        });
      }
      const r = await fetch("/api/vicki/asignar_foto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, photo_b64: dataUrl }),
      });
      const txt = await r.text();
      let data: any;
      try {
        data = JSON.parse(txt);
      } catch {
        data = { error: `HTTP ${r.status} (respuesta no-JSON)` };
      }
      const answer =
        data.response ?? `Error: ${data.detail ?? data.error ?? "desconocido"}`;
      setMessages((prev) => [
        ...prev,
        { role: "user", content: `📎 ${file.name}` },
        { role: "assistant", content: answer },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error subiendo imagen: ${e?.message ?? e}` },
      ]);
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center gap-3">
        <InicioButton className="text-zinc-400 hover:text-white transition-colors p-1.5" />
        <h1 className="text-lg font-semibold">Vicki — Selección de Personal</h1>
        <button
          type="button"
          onClick={nuevaConversacion}
          disabled={loading || !sessionId}
          title="Vicki arranca de cero y deja de arrastrar el puesto y el tema de la charla anterior. No se borra nada: los mensajes quedan y se vuelven a ver con «Ver anteriores»."
          className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-40"
        >
          Nueva conversación
        </button>
        {/* Abajo de 1024px la barra de CVs no entra al costado: se abre desde
            acá. Con recomendados nuevos el botón se marca en azul, para que no
            haya que adivinar que hay CVs esperando. */}
        <button
          type="button"
          onClick={() => setBarraAbierta((v) => !v)}
          title="CVs de la conversación"
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors lg:hidden ${
            recomendados.size
              ? "border-blue-600/70 text-blue-300 hover:bg-blue-950/40"
              : "border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white"
          }`}
        >
          CVs{candidatos.length ? ` (${candidatos.length})` : ""}
        </button>
        <UsuarioActual />
      </header>

      {/* chat a la izquierda, barra de CVs a la derecha (panel en pantallas angostas) */}
      <div className="flex flex-1 min-h-0">
      <div className="flex flex-1 min-w-0 flex-col">
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl flex flex-col gap-4">
          {/* Lo anterior al corte de «Nueva conversación» sigue guardado: acá
              se vuelve a traer. Vicki no lo lee, es para que lo veas vos. */}
          {anteriores > 0 && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => cargarHistorial(true)}
                className="text-xs text-zinc-500 underline underline-offset-4 transition-colors hover:text-zinc-300"
              >
                Ver los {anteriores} mensajes anteriores
              </button>
            </div>
          )}

          {messages.length === 0 && (
            <div className="text-zinc-500 text-sm text-center py-12">
              Escribí{" "}
              <code className="bg-zinc-800 px-1.5 py-0.5 rounded">
                /crea empleado
              </code>{" "}
              para empezar.
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                // className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm overflow-hidden break-words ${
                  m.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 text-zinc-100"
                }`}
              >
                {/* {renderContent(m.content)}
                 */}
                {renderContent(
                  m.content,
                  awaitingEmp &&
                    m.role === "assistant" &&
                    i === messages.length - 1
                    ? cancelEmployee
                    : undefined,
                  awaitingEmp &&
                    m.role === "assistant" &&
                    i === messages.length - 1 &&
                    /!\[[^\]]*\]\(data:image\//.test(m.content)
                    ? retakePhoto
                    : undefined,
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-800 text-zinc-400 rounded-2xl px-4 py-2.5 text-sm">
                Pensando…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="border-t border-zinc-800 px-4 py-4">
        <form
          onSubmit={onSubmit}
          className="mx-auto max-w-2xl flex flex-col gap-2"
        >
          {namePick.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {namePick.map((n) => (
                <Button
                  key={n}
                  type="button"
                  onClick={() => send(n)}
                  disabled={loading}
                  className="flex-1 min-w-[45%]"
                >
                  {n}
                </Button>
              ))}
            </div>
          )}
          {(pickingLocation || showUpload) && (
            <div className="flex gap-2">
              {pickingLocation &&
                UBICACIONES.map((u) => (
                  <Button
                    key={u.value}
                    type="button"
                    onClick={() => pickLocation(u.value)}
                    disabled={loading}
                    className="flex-1"
                  >
                    {u.label}
                  </Button>
                ))}
              {showUpload && (
                <Button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={loading}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600"
                >
                  📎 Subir imagen
                </Button>
              )}
            </div>
          )}
          {showConfirm && (
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => send("si")}
                disabled={loading}
                className="flex-1 bg-green-600 hover:bg-green-700"
              >
                ✅ Guardar en los 3 relojes
              </Button>
              <Button
                type="button"
                onClick={() => send("no")}
                disabled={loading}
                className="flex-1 bg-red-600 hover:bg-red-700"
              >
                ❌ Cancelar
              </Button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadImage(f);
            }}
          />
          {awaitingEmp && (
            <div className="flex gap-2">
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Sexo…</option>
                {GENEROS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Ubicación…</option>
                {UBICACIONES.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              disabled={inputLocked || loading}
              className="flex-1 bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            />
            <Button
              type="submit"
              disabled={inputLocked || loading || !input.trim()}
            >
              Enviar
            </Button>
          </div>
        </form>
      </footer>
      </div>

      <CvBarra
        candidatos={candidatos}
        recomendados={recomendados}
        descartados={descartados}
        onDescartar={descartar}
        onRecuperar={recuperar}
        abierta={barraAbierta}
        onCerrar={() => setBarraAbierta(false)}
      />
      </div>
    </div>
  );
}
