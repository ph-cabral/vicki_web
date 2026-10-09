"use client";

import { useEffect, useState, useRef } from "react";

export default function PickerPage() {
  const [pickerNombre, setPickerNombre] = useState<string | null>(null);
  const [nombreInput, setNombreInput] = useState("");
  const [codigo, setCodigo] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [estado, setEstado] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [mensaje, setMensaje] = useState("");
  const codigoRef = useRef<HTMLInputElement>(null);

  // Leer nombre del localStorage al montar
  useEffect(() => {
    const nombre = localStorage.getItem("picker_nombre");
    if (nombre) setPickerNombre(nombre);
  }, []);

  const guardarNombre = () => {
    const n = nombreInput.trim();
    if (!n) return;
    localStorage.setItem("picker_nombre", n);
    setPickerNombre(n);
  };

  const enviar = async () => {
    if (!codigo.trim() || !cantidad.trim()) return;

    setEstado("loading");

    try {
      const res = await fetch("/api/picking/eventos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigo: codigo.trim().toUpperCase(),
          cantidad: Number(cantidad),
          picker_nombre: pickerNombre,
        }),
      });

      if (res.ok) {
        setEstado("ok");
        setMensaje(`✓ Pedido enviado: ${codigo.trim().toUpperCase()} x${cantidad}`);
        setCodigo("");
        setCantidad("");
        setTimeout(() => {
          setEstado("idle");
          setMensaje("");
          codigoRef.current?.focus();
        }, 2500);
      } else {
        throw new Error("Error del servidor");
      }
    } catch {
      setEstado("error");
      setMensaje("Error al enviar. Intentá de nuevo.");
      setTimeout(() => {
        setEstado("idle");
        setMensaje("");
      }, 3000);
    }
  };

  // ── Pantalla: ingreso de nombre ──────────────────────────────
  if (!pickerNombre) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white">Picking EverWear</h1>
            <p className="text-gray-400 mt-2 text-sm">¿Cómo te llamás?</p>
          </div>
          <input
            type="text"
            placeholder="Tu nombre"
            value={nombreInput}
            onChange={(e) => setNombreInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && guardarNombre()}
            autoFocus
            className="w-full bg-gray-800 border border-gray-600 rounded-xl px-4 py-4 text-white text-lg focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={guardarNombre}
            disabled={!nombreInput.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold py-4 rounded-xl text-lg transition-colors"
          >
            Entrar
          </button>
        </div>
      </div>
    );
  }

  // ── Pantalla: formulario de pedido ───────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <div className="px-5 pt-8 pb-4">
        <p className="text-gray-400 text-sm">Hola,</p>
        <h1 className="text-2xl font-bold">{pickerNombre}</h1>
      </div>

      {/* Formulario */}
      <div className="flex-1 px-5 pt-4 space-y-5">
        {/* Código */}
        <div className="space-y-2">
          <label className="text-gray-400 text-sm font-medium uppercase tracking-wide">
            Código de producto
          </label>
          <input
            ref={codigoRef}
            type="text"
            inputMode="text"
            placeholder="Ej: ABC-1234"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-5 text-white text-xl font-mono focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Cantidad */}
        <div className="space-y-2">
          <label className="text-gray-400 text-sm font-medium uppercase tracking-wide">
            Cantidad
          </label>
          <input
            type="number"
            inputMode="numeric"
            placeholder="0"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            min={1}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-5 text-white text-xl font-mono focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Feedback */}
        {mensaje && (
          <div
            className={`rounded-xl px-4 py-4 text-center font-semibold text-base ${
              estado === "ok"
                ? "bg-green-900 text-green-300 border border-green-700"
                : "bg-red-900 text-red-300 border border-red-700"
            }`}
          >
            {mensaje}
          </div>
        )}
      </div>

      {/* Botón enviar — pegado al fondo */}
      <div className="px-5 pb-10 pt-4">
        <button
          onClick={enviar}
          disabled={!codigo.trim() || !cantidad.trim() || estado === "loading"}
          className="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 text-white font-bold py-5 rounded-xl text-xl transition-colors"
        >
          {estado === "loading" ? "Enviando..." : "Enviar pedido"}
        </button>

        {/* Cambiar nombre */}
        <button
          onClick={() => {
            localStorage.removeItem("picker_nombre");
            setPickerNombre(null);
            setNombreInput("");
          }}
          className="w-full mt-3 text-gray-600 text-sm py-2"
        >
          No soy {pickerNombre}
        </button>
      </div>
    </div>
  );
}

