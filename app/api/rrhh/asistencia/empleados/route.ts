import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Lista liviana de TODOS los legajos activos — universo del selector de
// empleado del botón "Nuevo estado" / "Nueva novedad" de /rrhh/asistencia
// (2026-09-18). A diferencia de /resumen (que arma una fila por día para un
// rango de fechas), esto es UNA sola consulta chica: el front la trae entera
// y filtra en memoria como un typeahead, mismo patrón que el selector de
// código de manguera (sin ida y vuelta al servidor por cada letra tipeada).
// Sirve para cargar novedades/estado de gente que ese día no aparece en la
// grilla (viajantes, gente que casi no ficha, etc.), sin tener que ir a
// buscar su fila.
//
// OJO 2026-09-18: al principio esto traía sólo legajos CON employeeNo (el
// mismo universo que /resumen), pero eso deja afuera justo a la gente para
// la que existe este botón — hoy 14 de 87 legajos activos no tienen
// employeeNo cargado (no pasan por el reloj). Ahora trae TODOS los activos;
// a quien no tiene employeeNo se le arma una clave sintética `L<id>` (nunca
// puede pisar un employeeNo real, que el reloj manda siempre numérico) —
// MISMA fórmula que usa /resumen para que después de guardar la novedad
// aparezca su fila en la grilla en vez de quedar huérfana en la base.
export async function GET() {
  try {
    const legajos = await prisma.legajo.findMany({
      where: { estado: "ACTIVO" },
      select: {
        id: true,
        employeeNo: true,
        nombre: true,
        sector: true,
        sectorRel: { select: { nombre: true } },
      },
      orderBy: { nombre: "asc" },
    });

    const empleados = legajos.map((l) => ({
      employee_no: l.employeeNo ?? `L${l.id}`,
      nombre: l.nombre,
      sector: l.sectorRel?.nombre ?? l.sector ?? null,
    }));

    return NextResponse.json({ empleados });
  } catch (e) {
    console.error("GET asistencia/empleados error:", e);
    return NextResponse.json({ error: "Error al listar empleados" }, { status: 500 });
  }
}
