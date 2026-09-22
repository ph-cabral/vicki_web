import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: ALTA de la OT de reposición (OT1R) en el
// WMS. Es el único endpoint de vicki que escribe en la base del WMS
// (WMS.dbo.OT + WMS.dbo.OTItem) — ver indicadores-api/ot_reposicion.py.
//
// El 409 no es un error del sistema: es una validación de negocio con el
// motivo en claro para mostrarle al operario (el stock se movió mientras
// armaba la OT, ya hay una reposición viva hacia ese estante, la ubicación no
// es de guardado…). El widget lo muestra tal cual, así que el detalle se pasa
// sin reescribir.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Cuerpo inválido" },
      { status: 400, headers: CORS },
    );
  }

  try {
    const res = await fetch(`${API_URL}/deposito/repo/ot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            res.status === 409
              ? (data as { detail?: string })?.detail ?? "No se pudo crear la OT"
              : "Error en API de depósito (alta de OT)",
          detail: data,
        },
        { status: res.status, headers: CORS },
      );
    }
    return NextResponse.json(data, { headers: CORS });
  } catch (error) {
    console.error("POST /api/deposito/repo/ot", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503, headers: CORS },
    );
  }
}
