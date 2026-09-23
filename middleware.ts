import { NextRequest, NextResponse } from "next/server";
import {
  moduleForPath,
  viewForPath,
  isAdminPath,
  normalizarHrefs,
  type SessionPayload,
} from "@/lib/auth/modules";

// El middleware corre en runtime edge: verifica la firma de la cookie con Web Crypto.
// Debe usar EXACTAMENTE el mismo secreto y formato que lib/auth/session.ts (Node).
const SESSION_COOKIE = "ever_session";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  return "dev-insecure-secret-cambiar-en-produccion";
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  if (pad) s += "=".repeat(pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(body)),
    ) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    // Cookies firmadas antes de un cambio de URL de vista (LEGACY_VIEW_HREFS).
    payload.vistas = normalizarHrefs(payload.vistas);
    return payload;
  } catch {
    return null;
  }
}

// Rutas públicas: NO requieren sesión (el picker entra sin credenciales).
// Alcance mínimo a propósito: sólo la página del picker y los POST que esa
// página usa. El resto de /picking, /api/picking y /api/chat (incluido
// /picking/picker/responder y los GET/PATCH) sigue protegido.
function esRutaPublica(pathname: string, method: string): boolean {
  // Página del picker (coincidencia exacta).
  if (pathname === "/picking/picker") return true;
  // Estado del picking para el widget de escritorio (autoelevador):
  // sólo lectura del conteo de pendientes, GET exacto, sin datos sensibles.
  if (method === "GET" && pathname === "/api/picking/estado") return true;
  // APIs que el picker necesita, sólo en POST.
  if (
    method === "POST" &&
    (pathname === "/api/picking/eventos" || pathname === "/api/chat")
  ) {
    return true;
  }
  // Widget de escritorio "Errores Mesa de Control": mismo caso que
  // /api/picking/estado arriba (proceso en background, sin cookie de sesion
  // de navegador). Alcance minimo: solo estas rutas exactas.
  if (method === "GET" && /^\/api\/deposito\/pedido\/\d+$/.test(pathname)) return true;
  // Selector de Artículos del pedido (2026-07-21/22, ambos widgets): mismo caso, solo lectura.
  if (method === "GET" && /^\/api\/deposito\/pedido\/\d+\/articulos$/.test(pathname)) return true;
  if (method === "GET" && pathname === "/api/deposito/errores-mesa/opciones") return true;
  // Pantalla inicial (N° Operario) del widget rediseñado 2026-07-15.
  if (method === "GET" && pathname === "/api/deposito/errores-mesa/operario") return true;
  if (method === "POST" && pathname === "/api/deposito/errores-mesa") return true;
  // Botón "Finalizar" del widget Mesa de Control rediseñado (2026-08-04,
  // 1 error por artículo): mismo caso.
  if (method === "POST" && pathname === "/api/deposito/errores-mesa/items") return true;
  // Widget de escritorio "Errores Calidad" (2026-07-16): mismo caso.
  if (method === "POST" && pathname === "/api/deposito/errores-mesa/calidad") return true;
  // Botón "Asignar" del widget Mesa de Control (2026-07-29): mismo caso.
  if (method === "POST" && pathname === "/api/deposito/errores-mesa/asignar") return true;
  // Reserva por cliente (2026-09-23): polling del grupo + botones Tomar/Esperar.
  if (method === "GET" && pathname === "/api/deposito/errores-mesa/grupo") return true;
  if (method === "POST" && pathname === "/api/deposito/errores-mesa/grupo/decision") return true;
  // Lista de errores propia de Calidad + botón "Finalizar" del widget
  // portado a Python (REDISEÑO 2026-08-20): mismo caso que las rutas de
  // Mesa de arriba (opciones GET / alta en lote POST).
  if (method === "GET" && pathname === "/api/deposito/errores-mesa/calidad/opciones") return true;
  if (method === "POST" && pathname === "/api/deposito/errores-mesa/calidad/items") return true;
  // Widget de escritorio "Falta en Picking" (widgets/picking-falta-widget):
  // mismo caso que los de arriba — corre como proceso de fondo en la PC del
  // depósito, sin cookie de sesión de navegador. Sólo lectura, GET exacto, y
  // lo que devuelve es lo mismo que ya ve cualquiera parado frente al estante
  // (artículo, posición y cantidad). Sin esto el widget recibe 401 en cada
  // consulta y, como se queda sin filas, NUNCA aparece: se ve igual que si
  // estuviera todo bien.
  if (method === "GET" && pathname === "/api/deposito/picking-disponible") return true;
  // Carga automática de la OT de reposición (2026-09-22): el userscript corre
  // dentro de la pantalla del WMS (10.10.0.158), que no comparte cookie con
  // vicki_web, así que llega sin sesión. Mismo caso que el widget: GET exacto,
  // sólo lectura, y lo que devuelve es lo que el repositor ya lee parado frente
  // al estante (artículo, ubicación de origen y cantidad).
  if (method === "GET" && pathname === "/api/deposito/picking-disponible/armar-ot") return true;
  // Widget "Falta en Picking 2" (2026-09-22): arma y DA DE ALTA la OT de
  // reposición sin pasar por la pantalla del WMS. Corre como proceso de fondo
  // en la PC del depósito, sin cookie de sesión, igual que el widget original.
  // El POST escribe en el WMS, así que acá no hay "es sólo lectura" que lo
  // justifique: lo que lo acota es que el payload sólo puede pedir artículos
  // que ya están en falta y ubicaciones que el propio WMS valida del otro lado
  // (ver ot_reposicion.py), y que la OT queda marcada en OTObservaciones.
  if (method === "GET" && pathname === "/api/deposito/repo/pasillo") return true;
  if (method === "GET" && pathname === "/api/deposito/repo/operarios") return true;
  if (method === "POST" && pathname === "/api/deposito/repo/ot") return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // 0) Rutas públicas: el picker entra sin credenciales.
  if (esRutaPublica(pathname, req.method)) return NextResponse.next();

  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);

  // 1) Sin sesión válida
  if (!session) {
    if (isApi) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("returnTo", pathname + search);
    return NextResponse.redirect(url);
  }

  // 2) Rutas de admin
  if (isAdminPath(pathname) && session.rol !== "ADMIN") {
    if (isApi) return NextResponse.json({ error: "Requiere rol ADMIN" }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 3) Permiso por módulo (los ADMIN pasan siempre)
  const mod = moduleForPath(pathname);
  if (mod && session.rol !== "ADMIN" && !session.mods?.includes(mod)) {
    if (isApi) return NextResponse.json({ error: "Sin permiso para este módulo" }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("denied", mod);
    return NextResponse.redirect(url);
  }

  // 4) Permiso por vista (sub-ruta). Sólo páginas; cookies viejas (sin `vistas`) pasan.
  const view = viewForPath(pathname);
  if (
    view &&
    session.rol !== "ADMIN" &&
    Array.isArray(session.vistas) &&
    !session.vistas.includes(view.href)
  ) {
    if (isApi) return NextResponse.json({ error: "Sin permiso para esta vista" }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = view.href.split("/").slice(0, 2).join("/") || "/";
    url.search = "";
    url.searchParams.set("denied", view.href);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Runtime Node.js (estable desde Next 15.5): el middleware lee process.env.AUTH_SECRET
  // EN RUNTIME. Con el runtime edge (default) las env se "inlinean" en build, y como
  // AUTH_SECRET no existe durante `next build` (ver Dockerfile.prod) quedaba undefined ->
  // secret() caía al valor dev y rechazaba TODAS las cookies firmadas en Node (session.ts),
  // generando el loop /login <-> / (el login "entraba" pero volvía a /login).
  runtime: "nodejs",
  // Protege todo salvo /login, /api/auth/*, internos de Next y archivos estáticos.
  // api/vicki/asignar_foto se excluye del matcher (no solo de esRutaPublica):
  // con runtime nodejs, el middleware rompe los POST con body grande (foto en
  // base64) — "TypeError: Response body object should not be disturbed or
  // locked" en el route handler. Al excluirla, el middleware ni corre y el
  // body llega intacto. El endpoint igual exige un draft activo en vicki_chat.
  //
  // api/rrhh/documentos: MISMO BUG, ahora con multipart (subir el .docx/.pdf en
  // /rrhh/puestos). El `req.formData()` del handler explotaba con ese mismo
  // TypeError y el frontend solo veía "HTTP 500". Como acá sí hay datos que
  // proteger, las 3 rutas de documentos llaman a `bloqueoPorAcceso()`
  // (lib/auth/guard.ts) al entrar: reemplaza el chequeo que hacía el middleware.
  // REGLA: excluir del matcher SIN agregar ese guard = ruta abierta a cualquiera.
  matcher: [
    "/((?!login|api/auth|api/vicki/asignar_foto|api/rrhh/documentos|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|txt|json|woff|woff2|ttf)$).*)",
  ],
};
