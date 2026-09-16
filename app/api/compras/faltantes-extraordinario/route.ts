import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ──────────────────────────────────────────────────────────────────────────────
// /compras/faltantes — marca "extraordinario" / "comprar" por (fecha,
// artículo, CLIENTE) — 2026-09-16, reemplaza la marca vieja por artículo
// entero. Un pedido extraordinario es de UN cliente puntual que pidió mucho
// más de lo habitual; el resto de la demanda de ese artículo ese día sigue
// su compra normal (ver faltantes-consumo/route.ts, que resta `cantidad` del
// faltante del bucket antes de acumularlo).
//   POST { fecha, codArticulo, codCliente, clienteNombre?, cantidad?, comprar? }
//     Upsert. `cantidad` es lo que ese cliente tiene marcado como
//     extraordinario (editable, puede ser MENOS que todo lo que pidió):
//     — si la clave NO viene en el body (ej. /ventas/faltantes decidiendo
//       "comprar", que no conoce ni debe tocar la cantidad), se PRESERVA la
//       que ya estaba guardada.
//     — si viene como null explícito, se guarda null = "todo lo pendiente
//       del cliente en ese bucket" (lo resuelve faltantes-consumo al leer).
//     — si viene un número, ese es el nuevo tope.
//     `comprar` es tri-state: null = pendiente de que /ventas/faltantes le
//     pregunte al cliente.
//   DELETE ?fecha&codArticulo&codCliente
//     Desmarca: borra la fila. La cantidad vuelve a sumar al faltante normal
//     del artículo en la próxima lectura.
//   Tabla: preparado.faltante_extraordinario (sql/compras_faltante_extraordinario.sql).
// ──────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const fecha = body?.fecha;
  const codArticulo = body?.codArticulo;
  const codCliente = body?.codCliente;
  if (
    !fecha || typeof fecha !== "string" ||
    !codArticulo || typeof codArticulo !== "string" ||
    !codCliente || typeof codCliente !== "string"
  ) {
    return NextResponse.json(
      { error: "fecha, codArticulo y codCliente son requeridos" },
      { status: 400 },
    );
  }
  const clienteNombre: string | null =
    typeof body?.clienteNombre === "string" && body.clienteNombre.trim() ? body.clienteNombre : null;
  // Distingue "la clave no vino" (preservar cantidad existente, caso
  // /ventas/faltantes decidiendo comprar) de "vino explícita" (null = todo lo
  // pendiente del cliente; número = tope editado a mano).
  const cantidadProvided = !!body && Object.prototype.hasOwnProperty.call(body, "cantidad");
  const cantidad: number | null =
    cantidadProvided && body.cantidad !== null ? Number(body.cantidad) : null;
  // Tri-state: null = pendiente de decisión, true/false = decidido.
  const comprar: boolean | null = body?.comprar === null || body?.comprar === undefined ? null : !!body.comprar;

  try {
    if (cantidadProvided) {
      await prisma.$executeRaw`
        INSERT INTO preparado.faltante_extraordinario
          (fecha, "codArticulo", "codCliente", "clienteNombre", cantidad, extraordinario, comprar, "updatedAt")
        VALUES (${fecha}::date, ${codArticulo}, ${codCliente}, ${clienteNombre}, ${cantidad}, true, ${comprar}, now())
        ON CONFLICT (fecha, "codArticulo", "codCliente") DO UPDATE SET
          "clienteNombre" = COALESCE(EXCLUDED."clienteNombre", preparado.faltante_extraordinario."clienteNombre"),
          cantidad        = EXCLUDED.cantidad,
          extraordinario  = true,
          comprar         = EXCLUDED.comprar,
          "updatedAt"     = now()
      `;
    } else {
      // No tocar `cantidad` — preserva lo que compras haya marcado.
      await prisma.$executeRaw`
        INSERT INTO preparado.faltante_extraordinario
          (fecha, "codArticulo", "codCliente", "clienteNombre", cantidad, extraordinario, comprar, "updatedAt")
        VALUES (${fecha}::date, ${codArticulo}, ${codCliente}, ${clienteNombre}, NULL, true, ${comprar}, now())
        ON CONFLICT (fecha, "codArticulo", "codCliente") DO UPDATE SET
          "clienteNombre" = COALESCE(EXCLUDED."clienteNombre", preparado.faltante_extraordinario."clienteNombre"),
          extraordinario  = true,
          comprar         = EXCLUDED.comprar,
          "updatedAt"     = now()
      `;
    }
    return NextResponse.json({ ok: true, fecha, codArticulo, codCliente, clienteNombre, cantidad, comprar });
  } catch (e) {
    return NextResponse.json(
      { error: "No se pudo guardar la marca (¿falta aplicar compras_faltante_extraordinario.sql?)", detail: String(e) },
      { status: 503 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const fecha = sp.get("fecha");
  const codArticulo = sp.get("codArticulo");
  const codCliente = sp.get("codCliente");
  if (!fecha || !codArticulo || !codCliente) {
    return NextResponse.json(
      { error: "fecha, codArticulo y codCliente son requeridos" },
      { status: 400 },
    );
  }
  try {
    await prisma.$executeRaw`
      DELETE FROM preparado.faltante_extraordinario
      WHERE fecha = ${fecha}::date
        AND "codArticulo" = ${codArticulo}
        AND "codCliente" = ${codCliente}
    `;
    return NextResponse.json({ ok: true, fecha, codArticulo, codCliente });
  } catch (e) {
    return NextResponse.json(
      { error: "No se pudo desmarcar", detail: String(e) },
      { status: 503 },
    );
  }
}
