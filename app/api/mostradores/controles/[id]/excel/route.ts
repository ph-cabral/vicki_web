import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

interface FilaDetalle {
  codigo: string;
  detalle: string;
  controlado: number;
  sistema: number;
  diferencia: number;
  usuario: string;
  controladoAt: string | null;
}

// Excel de un control cerrado, armado al descargar desde
// everwear.mostrador_control_detalle (GET /mostradores/controles/{id}/detalle).
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
    const res = await fetch(`${API_URL}/mostradores/controles/${id}/detalle`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = (await res.json().catch(() => null)) as
      | { patron?: string; detallePatron?: string; cerradoAt?: string | null; filas?: FilaDetalle[]; detail?: unknown }
      | null;
    if (!res.ok || !json) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo descargar el Excel" },
        { status: res.status || 503 },
      );
    }

    const data = (json.filas ?? []).map((f) => ({
      Código: f.codigo,
      Detalle: f.detalle,
      Controlado: f.controlado,
      Sistema: f.sistema,
      Diferencia: f.diferencia,
      Usuario: f.usuario,
      "Contado el": f.controladoAt
        ? new Date(f.controladoAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })
        : "Sin contar",
    }));
    const ws = XLSX.utils.json_to_sheet(data, {
      header: ["Código", "Detalle", "Controlado", "Sistema", "Diferencia", "Usuario", "Contado el"],
    });
    ws["!cols"] = [{ wch: 16 }, { wch: 48 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Control");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const fecha = (json.cerradoAt ?? "").slice(0, 10);
    const nombre = `control_patron_${json.patron ?? id}_${fecha}.xlsx`.replace(/[^\w.\-]/g, "_");
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nombre}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("GET /api/mostradores/controles/[id]/excel", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
