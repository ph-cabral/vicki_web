import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Lista liviana de legajos activos con employeeNo asignado — universo del
// selector de empleado del botón "Nuevo estado" / "Nueva novedad" de
// /rrhh/asistencia (2026-09-18). A diferencia de /resumen (que arma una fila
// por día para un rango de fechas), esto es UNA sola consulta chica: el
// front la trae entera y filtra en memoria como un typeahead, mismo patrón
// que el selector de código de manguera (sin ida y vuelta al servidor por
// cada letra tipeada). Sirve para cargar novedades/estado de gente que ese
// día no aparece en la grilla (viajantes, gente que casi no ficha, etc.),
// sin tener que ir a buscar su fila.
export async function GET() {
  try {
    const legajos = await prisma.legajo.findMany({
      where: { estado: "ACTIVO", employeeNo: { not: null } },
      select: {
        employeeNo: true,
        nombre: true,
        sector: true,
        sectorRel: { select: { nombre: true } },
      },
      orderBy: { nombre: "asc" },
    });

    const empleados = legajos.map((l) => ({
      employee_no: l.employeeNo as string,
      nombre: l.nombre,
      sector: l.sectorRel?.nombre ?? l.sector ?? null,
    }));

    return NextResponse.json({ empleados });
  } catch (e) {
    console.error("GET asistencia/empleados error:", e);
    return NextResponse.json({ error: "Error al listar empleados" }, { status: 500 });
  }
}
