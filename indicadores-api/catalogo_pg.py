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


def codigos_de_sub_linea(sub_linea: str, linea: str) -> list[str]:
    """Códigos de artículo de una (línea, sub_línea) puntual — para la
    'variante rápida' de fetch_clientes_por_linea (arrancar por los
    artículos de la sub_línea en vez de escanear todo Ven_CompRenglon).
    `linea` hace falta porque el mismo nombre de sub_línea puede repetirse
    bajo líneas distintas (UNIQUE(nombre, linea_id), no UNIQUE(nombre))."""
    mapa = mapa_articulo_sub_linea()
    return [cod for cod, (sl, l) in mapa.items() if sl == sub_linea and l == linea]
