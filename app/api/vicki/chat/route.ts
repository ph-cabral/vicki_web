import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoVickiRrhh } from "@/lib/rrhh/vickiRrhhAcceso";
import { resolverAccesoVickiVentas } from "@/lib/ventas/vickiVentasAcceso";
import { resolverAccesoVickiCompras } from "@/lib/compras/vickiComprasAcceso";
import { resolverAccesoVickiDeposito } from "@/lib/deposito/vickiDepositoAcceso";
import { sessionIdVicki } from "@/lib/vicki/sesionChat";
import { resolverIdentidadVicki } from "@/lib/vicki/identidad";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // El session_id se impone acá, igual que los permisos: venía del browser,
    // así que cambiándolo se podía escribir y leer la conversación de otro
    // usuario. Ver lib/vicki/sesionChat.ts.
    const sid = await sessionIdVicki();
    if (!sid) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }
    body.session_id = sid;

    // Acceso a datos de ventas (intent "ventas" en vicki_chat): se resuelve
    // ACÁ, server-side contra la cookie de sesión, y se pisa lo que haya
    // mandado el browser en el body. vicki_chat confía en estos campos
    // porque vienen de este backend, nunca del cliente — si se leyeran del
    // body tal cual, cualquiera podría mandar `vendedorCodigo` de otra
    // persona. Ver lib/ventas/vickiVentasAcceso.ts.
    // Los permisos se resuelven en paralelo: son lookups distintos sobre la
    // misma sesión y esto corre en CADA mensaje del chat.
    const [acceso, accesoRrhh, accesoCompras, accesoDeposito] = await Promise.all([
      resolverAccesoVickiVentas(),
      resolverAccesoVickiRrhh(),
      resolverAccesoVickiCompras(),
      resolverAccesoVickiDeposito(),
    ]);
    if (!acceso.ok) {
      return NextResponse.json({ error: acceso.error }, { status: acceso.status });
    }
    body.vicki_ventas_habilitado = acceso.habilitado;
    body.vicki_ventas_admin = acceso.isAdmin;
    body.vicki_ventas_vendedor_codigo = acceso.habilitado ? acceso.vendedorCodigo : null;
    // Asistencia (intent "rrhh"): todo o nada, sin filtro por persona — ver
    // lib/rrhh/vickiRrhhAcceso.ts.
    body.vicki_rrhh_habilitado = accesoRrhh.ok && accesoRrhh.habilitado;
    // Compras (intent "compras"): el permiso ES el de la vista /compras, leído
    // de la cookie de sesión — ver lib/compras/vickiComprasAcceso.ts.
    body.vicki_compras_habilitado = accesoCompras.ok && accesoCompras.habilitado;
    // Depósito (intent "deposito"): el permiso ES el de la vista /deposito,
    // leído de la cookie de sesión — ver lib/deposito/vickiDepositoAcceso.ts.
    body.vicki_deposito_habilitado = accesoDeposito.ok && accesoDeposito.habilitado;

    // Identidad para el agente de vicki_chat (app/agente.py): admin = SQL libre,
    // el resto solo lo propio (su vendedor y su legajo). Se pisa lo que mande el
    // browser, igual que los permisos de arriba.
    const ident = await resolverIdentidadVicki();
    body.vicki_es_admin = ident.esAdmin;
    body.vicki_usuario_nombre = ident.nombre;
    body.vicki_legajo_id = ident.legajoId;
    body.vicki_vendedor_codigo = ident.esAdmin ? null : ident.vendedorCodigo;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Secreto compartido con chat-agent (CHAT_API_TOKEN allá, VICKI_API_TOKEN acá).
    if (process.env.VICKI_API_TOKEN) headers["X-Vicki-Token"] = process.env.VICKI_API_TOKEN;

    const r = await fetch(`${VICKI_URL}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // El agente puede encadenar varias consultas (vicki_chat corta a los 100s).
      signal: AbortSignal.timeout(110000),
    });
    const txt = await r.text();
    return new NextResponse(txt, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Error de conexión a Vicki" },
      { status: 502 },
    );
  }
}
