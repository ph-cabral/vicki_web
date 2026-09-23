"""
Catálogo comercial Pool > Línea > Sub Línea > Patrón — vive en POSTGRES
(esquema `catalogo`, ver cargar_depara.py en la raíz del repo y
depara_pool_linea_sublinea_patron.md), NO en Magnus.

Usado por fetch_top_lineas / fetch_clientes_por_linea (ventas.py) para
agrupar la venta de /ventas/vendedor por sub_línea/línea de Postgres en vez
del catálogo propio de Magnus (Stk_Nivel1) — reemplazado 2026-09-15 porque
Stk_Nivel1 no tiene noción de sub_línea.

Magnus (SQL Server) y este Postgres son motores distintos: no hay JOIN
posible en una sola consulta. La resolución es en dos pasos — acá se trae el
mapeo COMPLETO código de artículo -> (sub_línea, línea) UNA vez (cacheado en
memoria, no hay por qué pegarle a Postgres en cada request) y ventas.py lo
cruza en Python contra los renglones de venta de Magnus. Mismo patrón que
tenía el viejo `ventas.linea` de Postgres antes de deprecarse (ver el
comentario de "Catálogo de líneas" en ventas.py) — se reintroduce acá porque
esta clasificación no tiene equivalente server-side en SQL Server.
"""
import time

from db_pg import get_pg_connection

_CACHE_TTL_SEG = 15 * 60
_cache: dict[str, tuple[str, str]] | None = None
_cache_ts: float = 0.0

# Bucket de "no tiene clasificación" — mismo rol que el viejo SIN_LINEA de
# Stk_Nivel1, pero acá cubre DOS casos que no se pueden distinguir desde acá:
# el código de artículo no está en `catalogo.articulo`, o `catalogo.articulo`
# todavía no tiene filas porque el DePara no se cargó (cargar_depara.py).
LINEA_SIN_CLASIFICAR = "(Sin línea)"
SUB_LINEA_SIN_CLASIFICAR = "(Sin clasificar)"


def _cargar() -> dict[str, tuple[str, str]]:
    """codigo_articulo -> (sub_linea, linea). Una sola query, todo el
    catálogo de una — son miles de filas como mucho (~35k en el DePara
    completo), no varias decenas de miles de consultas por código."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT a.codigo, sl.nombre, l.nombre
            FROM catalogo.articulo a
            JOIN catalogo.patron pa    ON pa.id = a.patron_id
            JOIN catalogo.sub_linea sl ON sl.id = pa.sub_linea_id
            JOIN catalogo.linea l      ON l.id  = sl.linea_id
        """)
        return {
            (codigo or "").strip(): ((sub_linea or "").strip(), (linea or "").strip())
            for codigo, sub_linea, linea in cur.fetchall()
            if codigo and str(codigo).strip()
        }
    finally:
        conn.close()


def mapa_articulo_sub_linea(forzar: bool = False) -> dict[str, tuple[str, str]]:
    """Devuelve (y cachea 15 min) el mapeo código de artículo -> (sub_línea,
    línea). Vacío si `catalogo.articulo` todavía no tiene filas — quien
    llama debe tratar eso como "todo cae en Sin clasificar", nunca como
    error (la tabla puede estar legítimamente vacía entre que se corre el
    DDL y se carga el DePara completo)."""
    global _cache, _cache_ts
    ahora = time.monotonic()
    if forzar or _cache is None or (ahora - _cache_ts) > _CACHE_TTL_SEG:
        _cache = _cargar()
        _cache_ts = ahora
    return _cache


# Cache aparte de mapa_articulo_sub_linea: mismo TTL/patrón, pero el dato es
# distinto (nombre de línea -> se puede desplegar comercialmente) y cambia
# con mucha menos frecuencia que el mapeo de artículos, no tiene sentido
# atarlos al mismo _cache.
_cache_apertura: set[str] | None = None
_cache_apertura_ts: float = 0.0


def _cargar_apertura_comercial() -> set[str]:
    """Nombres de línea con AL MENOS UN patrón `apertura_comercial = true`
    (columna M "Apertura Comercial" del DePara, ver
    depara_pool_linea_sublinea_patron.md). En la práctica el flag es
    uniforme para todos los patrones de una misma línea salvo "Varios"
    (mezcla SI/NO) — ahí ANY, no ALL, es el criterio correcto: si algún
    patrón de la línea habilita apertura comercial, la línea se puede
    desplegar."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT DISTINCT l.nombre
            FROM catalogo.linea l
            JOIN catalogo.sub_linea sl ON sl.linea_id = l.id
            JOIN catalogo.patron pa    ON pa.sub_linea_id = sl.id
            WHERE pa.apertura_comercial = TRUE
        """)
        return {(nombre or "").strip() for (nombre,) in cur.fetchall() if nombre}
    finally:
        conn.close()


def lineas_con_apertura_comercial(forzar: bool = False) -> set[str]:
    """Devuelve (y cachea 15 min, mismo TTL que mapa_articulo_sub_linea) el
    set de nombres de línea que se pueden desplegar comercialmente — usado
    por fetch_top_lineas (ventas.py) para marcar `aperturaComercial` en cada
    línea del ranking y que el front sólo deje abrir el acordeón de esas.
    Vacío (nada desplegable) si `catalogo.patron` todavía no tiene filas,
    mismo criterio de "no es error" que mapa_articulo_sub_linea."""
    global _cache_apertura, _cache_apertura_ts
    ahora = time.monotonic()
    if forzar or _cache_apertura is None or (ahora - _cache_apertura_ts) > _CACHE_TTL_SEG:
        _cache_apertura = _cargar_apertura_comercial()
        _cache_apertura_ts = ahora
    return _cache_apertura


def codigos_de_sub_linea(sub_linea: str, linea: str) -> list[str]:
    """Códigos de artículo de una (línea, sub_línea) puntual — para la
    'variante rápida' de fetch_clientes_por_sub_linea (arrancar por los
    artículos de la sub_línea en vez de escanear todo Ven_CompRenglon).
    `linea` hace falta porque el mismo nombre de sub_línea puede repetirse
    bajo líneas distintas (UNIQUE(nombre, linea_id), no UNIQUE(nombre))."""
    mapa = mapa_articulo_sub_linea()
    return [cod for cod, (sl, l) in mapa.items() if sl == sub_linea and l == linea]


def codigos_de_linea(linea: str) -> list[str]:
    """Códigos de artículo de una línea COMPLETA (todas sus sub_líneas) —
    para la 'variante rápida' de fetch_clientes_por_linea (ventas.py):
    drill-down "línea de un cliente puntual -> quién más la compró", migrado
    de Stk_Nivel1 (Magnus) a este catálogo el 2026-09-15. Hermano de
    codigos_de_sub_linea, un nivel más arriba en la jerarquía."""
    mapa = mapa_articulo_sub_linea()
    return [cod for cod, (_, l) in mapa.items() if l == linea]


# ──────────────────────────────────────────────────────────────────────────
# Líneas por ID — para la vista de líneas (/ventas/bulones, 2026-09-23).
#
# Esa vista filtra por UNA línea del catálogo y la identifica por
# `catalogo.linea.id`, no por nombre: hay nombres repetidos ("Varios" existe
# dos veces con ids distintos) y los permisos por usuario
# (everwear.usuario_linea_venta) también guardan el id. Cache propio (mismo
# TTL de 15 min) porque codigos_de_linea() trabaja por nombre y juntaría las
# dos "Varios".
# ──────────────────────────────────────────────────────────────────────────
_cache_lineas: list[dict] | None = None
_cache_codigos_linea: dict[int, list[str]] | None = None
_cache_lineas_ts: float = 0.0

# Prefijo (minúsculas) de la línea que se abre por defecto cuando no se pide
# ninguna: Bulones, que es lo que la vista mostraba antes de abrirse a todas.
LINEA_DEFECTO_PREFIJO = "bulon"


def _cargar_lineas() -> tuple[list[dict], dict[int, list[str]]]:
    """Dos consultas chicas en la misma conexión: el catálogo de líneas (unas
    40 filas) y el par (línea, código de artículo) para TODO el catálogo
    (~35k filas). Se trae una vez y se cachea."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, nombre FROM catalogo.linea ORDER BY nombre, id")
        lineas = [
            {"id": int(i), "nombre": (n or "").strip()}
            for i, n in cur.fetchall()
            if i is not None
        ]
        cur.execute("""
            SELECT sl.linea_id, a.codigo
            FROM catalogo.articulo a
            JOIN catalogo.patron pa    ON pa.id = a.patron_id
            JOIN catalogo.sub_linea sl ON sl.id = pa.sub_linea_id
        """)
        codigos: dict[int, list[str]] = {}
        for lid, cod in cur.fetchall():
            c = (cod or "").strip()
            if lid is not None and c:
                codigos.setdefault(int(lid), []).append(c)
        return lineas, codigos
    finally:
        conn.close()


def _lineas_cacheadas(forzar: bool = False):
    global _cache_lineas, _cache_codigos_linea, _cache_lineas_ts
    ahora = time.monotonic()
    if (forzar or _cache_lineas is None
            or (ahora - _cache_lineas_ts) > _CACHE_TTL_SEG):
        _cache_lineas, _cache_codigos_linea = _cargar_lineas()
        _cache_lineas_ts = ahora
    return _cache_lineas, _cache_codigos_linea


def lineas_catalogo(forzar: bool = False) -> list[dict]:
    """[{id, nombre}] de TODAS las líneas del catálogo, ordenadas por nombre.
    Sin filtro de apertura comercial: en la vista de líneas se puede abrir
    cualquiera."""
    return _lineas_cacheadas(forzar)[0]


def linea_por_id(linea_id: int) -> dict | None:
    lid = int(linea_id)
    return next((l for l in lineas_catalogo() if l["id"] == lid), None)


def linea_por_defecto() -> dict | None:
    """La línea que se abre si no se pide ninguna (Bulones)."""
    ls = lineas_catalogo()
    return next(
        (l for l in ls if l["nombre"].lower().startswith(LINEA_DEFECTO_PREFIJO)),
        ls[0] if ls else None,
    )


def codigos_de_linea_id(linea_id: int) -> list[str]:
    """Códigos de artículo de una línea (por id). Lista vacía si la línea no
    tiene artículos cargados."""
    return _lineas_cacheadas()[1].get(int(linea_id), [])
