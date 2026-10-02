"""
Configuración de artículos — qué artículos de Magnus NO tienen línea.

El catálogo comercial Pool > Línea > Sub Línea > Patrón vive en Postgres
(esquema `catalogo`, ver catalogo_pg.py y cargar_depara.py). Un artículo
creado en Magnus después de la última carga del DePara no está en
`catalogo.articulo`, así que cae en "(Sin línea)" en todos los reportes.

Cada artículo de Magnus trae su patrón (StkFer_Articulos.ArticuloPatron), y
el patrón es la unidad de clasificación. Hay tres situaciones para un
artículo que NO está en `catalogo.articulo`:

  conocido    su patrón YA está en `catalogo.patron` -> sólo falta insertarlo
              en `catalogo.articulo` (botón "Sincronizar", sin decidir nada).
  nuevo       su patrón NO está en `catalogo.patron` -> alguien tiene que
              elegir a qué sub línea va (asignar_patron); eso crea el patrón
              y mete en el catálogo TODOS sus artículos de una.
  sin_patron  Magnus no le cargó patrón -> no se puede resolver acá, se
              corrige en Magnus.

Magnus (SQL Server) y Postgres son motores distintos: el cruce se hace en
Python. Se trae una foto de StkFer_Articulos (1 consulta, ~41k filas, ~22k
sólo activos) y el catálogo completo (2 consultas), y se cachea 60 s — las
escrituras la invalidan, así que después de asignar la pantalla ya se ve
actualizada.
"""
import threading
import time
from datetime import date, timedelta

from psycopg2.extras import execute_values

import catalogo_pg
from db import get_connection
from db_pg import get_pg_connection

# Magnus guarda las fechas como días desde 1800-12-28.
_BASE_FECHA = date(1800, 12, 28)
_TTL_SEG = 60
_LIMITE_MAX = 200

SIT_CLASIFICADO = "clasificado"
SIT_CONOCIDO = "conocido"
SIT_NUEVO = "nuevo"
SIT_SIN_PATRON = "sin_patron"

_lock = threading.Lock()
_snap: dict[bool, tuple[float, list]] = {}


def _fecha(dias) -> str | None:
    try:
        return (_BASE_FECHA + timedelta(days=int(dias))).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def _s(v) -> str:
    return str(v).strip() if v is not None else ""


def _cargar_magnus(solo_activos: bool) -> list[tuple]:
    """Una sola pasada por StkFer_Articulos. Estado=1 es "activo" (mismo
    criterio que las listas de precios)."""
    sql = (
        "SELECT RTRIM(CodArticulo), RTRIM(ArticuloPatron), RTRIM(DetallePatron), "
        "RTRIM(DetalleMedida), Estado, EnListaDePrecios, FechaAlta "
        "FROM StkFer_Articulos"
    )
    if solo_activos:
        sql += " WHERE Estado = 1"
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        return [
            (_s(r[0]), _s(r[1]), _s(r[2]), _s(r[3]), r[4], r[5], r[6])
            for r in cur.fetchall()
            if _s(r[0])
        ]
    finally:
        conn.close()


def _cargar_catalogo() -> tuple[dict[str, dict], dict[str, str]]:
    """(patrones, articulos): código de patrón -> jerarquía, y código de
    artículo -> código de patrón del catálogo."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT pa.codigo_patron, pa.id, sl.id, sl.nombre, l.id, l.nombre, po.nombre
            FROM catalogo.patron pa
            JOIN catalogo.sub_linea sl ON sl.id = pa.sub_linea_id
            JOIN catalogo.linea l      ON l.id  = sl.linea_id
            JOIN catalogo.pool po      ON po.id = l.pool_id
        """)
        patrones = {
            _s(cod): {
                "patronId": pid,
                "subLineaId": slid,
                "subLinea": _s(sln),
                "lineaId": lid,
                "linea": _s(ln),
                "pool": _s(pn),
            }
            for cod, pid, slid, sln, lid, ln, pn in cur.fetchall()
        }
        cur.execute("""
            SELECT a.codigo, pa.codigo_patron
            FROM catalogo.articulo a
            JOIN catalogo.patron pa ON pa.id = a.patron_id
        """)
        articulos = {_s(c): _s(p) for c, p in cur.fetchall() if _s(c)}
        return patrones, articulos
    finally:
        conn.close()


def _foto(solo_activos: bool, forzar: bool = False) -> list[tuple]:
    """Filas de Magnus ya clasificadas:
    (cod, patron, detalle_patron, medida, estado, en_lista, alta, situacion, info)
    `info` = jerarquía del catálogo (la del patrón propio si ya está
    clasificado, o la que le tocaría si su patrón es conocido), o None."""
    ahora = time.monotonic()
    with _lock:
        hit = _snap.get(solo_activos)
        if hit and not forzar and (ahora - hit[0]) < _TTL_SEG:
            return hit[1]
    filas = _cargar_magnus(solo_activos)
    patrones, articulos = _cargar_catalogo()
    out = []
    for cod, pat, dpat, med, est, lista, alta in filas:
        pc = articulos.get(cod)
        if pc is not None:
            sit, info = SIT_CLASIFICADO, patrones.get(pc)
        elif not pat:
            sit, info = SIT_SIN_PATRON, None
        elif pat in patrones:
            sit, info = SIT_CONOCIDO, patrones[pat]
        else:
            sit, info = SIT_NUEVO, None
        out.append((cod, pat, dpat, med, est, lista, alta, sit, info))
    with _lock:
        _snap[solo_activos] = (time.monotonic(), out)
    return out


def invalidar() -> None:
    with _lock:
        _snap.clear()
    catalogo_pg.invalidar_caches()


# ── Lecturas ──────────────────────────────────────────────────────────────

def resumen(solo_activos: bool = True) -> dict:
    filas = _foto(solo_activos)
    cuenta = {SIT_CLASIFICADO: 0, SIT_CONOCIDO: 0, SIT_NUEVO: 0, SIT_SIN_PATRON: 0}
    patrones_nuevos: set[str] = set()
    for f in filas:
        cuenta[f[7]] += 1
        if f[7] == SIT_NUEVO:
            patrones_nuevos.add(f[1])
    return {
        "total": len(filas),
        "clasificados": cuenta[SIT_CLASIFICADO],
        "sinLinea": len(filas) - cuenta[SIT_CLASIFICADO],
        "conocidos": cuenta[SIT_CONOCIDO],
        "nuevos": cuenta[SIT_NUEVO],
        "sinPatron": cuenta[SIT_SIN_PATRON],
        "patronesNuevos": len(patrones_nuevos),
    }


def patrones_nuevos(solo_activos: bool = True) -> list[dict]:
    """Patrones de Magnus que no están en el catálogo, con sus artículos sin
    línea. Es la lista de trabajo: cada fila se resuelve con una sub línea."""
    grupos: dict[str, dict] = {}
    for cod, pat, dpat, med, est, lista, alta, sit, _ in _foto(solo_activos):
        if sit != SIT_NUEVO:
            continue
        g = grupos.get(pat)
        if g is None:
            g = grupos[pat] = {
                "patron": pat,
                "detalle": dpat,
                "articulos": 0,
                "enListaPrecios": 0,
                "ultimaAlta": None,
                "ejemplos": [],
            }
        g["articulos"] += 1
        if lista:
            g["enListaPrecios"] += 1
        if not g["detalle"] and dpat:
            g["detalle"] = dpat
        f = _fecha(alta)
        if f and (g["ultimaAlta"] is None or f > g["ultimaAlta"]):
            g["ultimaAlta"] = f
        if len(g["ejemplos"]) < 3:
            g["ejemplos"].append({"codigo": cod, "medida": med})
    return sorted(grupos.values(), key=lambda g: (-g["articulos"], g["patron"]))


def articulos(
    modo: str = "sin_linea",
    solo_activos: bool = True,
    q: str | None = None,
    offset: int = 0,
    limite: int = 100,
) -> dict:
    """Listado paginado. modo='sin_linea' = sólo los que no están en el
    catálogo; modo='todos' = todos, con su línea actual. Más nuevos primero."""
    if modo not in ("sin_linea", "todos"):
        raise ValueError("modo inválido (sin_linea | todos)")
    limite = max(1, min(int(limite), _LIMITE_MAX))
    offset = max(0, int(offset))
    filas = _foto(solo_activos)
    if modo == "sin_linea":
        filas = [f for f in filas if f[7] != SIT_CLASIFICADO]
    t = (q or "").strip().lower()
    if t:
        def _coincide(f) -> bool:
            info = f[8]
            texto = " ".join(
                (f[0], f[1], f[2], f[3], info["linea"] if info else "", info["subLinea"] if info else "")
            ).lower()
            return t in texto
        filas = [f for f in filas if _coincide(f)]
    filas = sorted(filas, key=lambda f: (-(f[6] or 0), f[0]))
    total = len(filas)
    pagina = filas[offset: offset + limite]
    return {
        "total": total,
        "offset": offset,
        "limite": limite,
        "items": [
            {
                "codigo": cod,
                "medida": med,
                "patron": pat,
                "detallePatron": dpat,
                "estado": est,
                "enListaPrecios": bool(lista),
                "alta": _fecha(alta),
                "situacion": sit,
                "linea": info["linea"] if info else None,
                "subLinea": info["subLinea"] if info else None,
            }
            for cod, pat, dpat, med, est, lista, alta, sit, info in pagina
        ],
    }


def sub_lineas() -> list[dict]:
    """Opciones para el selector: todas las sub líneas con su línea y pool."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT sl.id, sl.nombre, l.id, l.nombre, po.nombre
            FROM catalogo.sub_linea sl
            JOIN catalogo.linea l ON l.id = sl.linea_id
            JOIN catalogo.pool po ON po.id = l.pool_id
            ORDER BY l.nombre, sl.nombre, sl.id
        """)
        return [
            {"id": slid, "subLinea": _s(sln), "lineaId": lid, "linea": _s(ln), "pool": _s(pn)}
            for slid, sln, lid, ln, pn in cur.fetchall()
        ]
    finally:
        conn.close()


# ── Escrituras (sólo Postgres; Magnus no se toca) ─────────────────────────

def _insertar_articulos(cur, pares: list[tuple[str, int]]) -> int:
    """(codigo, patron_id) -> catalogo.articulo. ON CONFLICT DO NOTHING: un
    artículo que ya está clasificado (aunque sea bajo otro patrón) no se
    pisa. Devuelve cuántos se insertaron de verdad."""
    if not pares:
        return 0
    filas = execute_values(
        cur,
        "INSERT INTO catalogo.articulo (codigo, patron_id) VALUES %s "
        "ON CONFLICT (codigo) DO NOTHING RETURNING codigo",
        pares,
        page_size=1000,
        fetch=True,
    )
    return len(filas)


def asignar_patron(patron: str, sub_linea_id: int) -> dict:
    """Clasifica un patrón NUEVO en una sub línea: crea `catalogo.patron` y
    mete en `catalogo.articulo` todos los artículos de Magnus con ese patrón
    (de cualquier estado: el mapeo es por patrón, y las ventas históricas
    pueden referirse a artículos hoy inactivos).

    `apertura_comercial` del patrón nuevo hereda la de sus hermanos de la
    sub línea (cualquiera en SI => SI, mismo criterio ANY que usa
    lineas_con_apertura_comercial); sin hermanos queda en NO."""
    patron = _s(patron)
    if not patron or len(patron) > 20:
        raise ValueError("Patrón inválido")
    sub_linea_id = int(sub_linea_id)

    # `=` sobre CHAR ignora el relleno de espacios: no hace falta RTRIM(col)
    # (que anularía un índice).
    conn_m = get_connection()
    try:
        cur_m = conn_m.cursor()
        cur_m.execute(
            "SELECT RTRIM(CodArticulo) FROM StkFer_Articulos WHERE ArticuloPatron = ?",
            patron,
        )
        codigos = [_s(r[0]) for r in cur_m.fetchall() if _s(r[0])]
    finally:
        conn_m.close()
    if not codigos:
        raise ValueError(f"Magnus no tiene artículos con el patrón {patron}")

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM catalogo.sub_linea WHERE id = %s", (sub_linea_id,))
        if cur.fetchone() is None:
            raise ValueError("La sub línea elegida no existe")
        cur.execute("SELECT 1 FROM catalogo.patron WHERE codigo_patron = %s", (patron,))
        if cur.fetchone() is not None:
            raise ValueError(
                f"El patrón {patron} ya está clasificado; sus artículos pendientes se cargan con «Sincronizar»"
            )
        cur.execute(
            """
            INSERT INTO catalogo.patron (codigo_patron, unidad, apertura_comercial, sub_linea_id)
            VALUES (%s, NULL,
                    COALESCE((SELECT bool_or(apertura_comercial) FROM catalogo.patron
                              WHERE sub_linea_id = %s), FALSE),
                    %s)
            RETURNING id
            """,
            (patron, sub_linea_id, sub_linea_id),
        )
        patron_id = cur.fetchone()[0]
        insertados = _insertar_articulos(cur, [(c, patron_id) for c in codigos])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    invalidar()
    return {"patron": patron, "patronId": patron_id, "articulos": insertados,
            "yaClasificados": len(codigos) - insertados}


def sincronizar() -> dict:
    """Mete en `catalogo.articulo` los artículos de Magnus cuyo patrón ya
    está clasificado pero que todavía no figuran (alta posterior a la carga
    del DePara). No decide nada: usa la sub línea que el patrón ya tiene."""
    filas = _foto(False, forzar=True)
    pares: list[tuple[str, int]] = []
    patrones: set[str] = set()
    for cod, pat, _d, _m, _e, _l, _a, sit, info in filas:
        if sit == SIT_CONOCIDO and info:
            pares.append((cod, info["patronId"]))
            patrones.add(pat)
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        insertados = _insertar_articulos(cur, pares)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    invalidar()
    return {"articulos": insertados, "patrones": len(patrones)}
