import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Descarga el Excel guardado de un control cerrado.
//   GET -> archivo .xlsx (attachment)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Control inválido" }, { status: 400 });
  }
  try {
    const res = await fetch(`${API_URL}/mostradores/controles/${id}/excel`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo descargar el Excel" },
        { status: res.status },
      );
    }
    return new NextResponse(res.body, {
      headers: {
        "Content-Type":
          res.headers.get("content-type") ??
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": res.headers.get("content-disposition") ?? 'attachment; filename="control.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("GET /api/mostradores/controles/[id]/excel", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
