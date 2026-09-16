"""
Clientes (Magnus, SOLO LECTURA).

Lookup por número de cliente para /manguera/corte. Solo se necesita número y
nombre. A Magnus nunca se le escribe.

Tabla (MAGNUS_SITD, misma usada en el JOIN de indicadores):
  · MAGNUS_SITD.dbo.Clientes → CodCliente, Cliente_Nombre
"""
from db import get_connection
from cartera import sql_join_cartera, cliente_es_de_vendedor

SQL_CLIENTE = """
SELECT TOP 1
    c.CodCliente                    AS numero,
    LTRIM(RTRIM(c.Cliente_Nombre))  AS nombre
FROM MAGNUS_SITD.dbo.Clientes c
WHERE c.CodCliente = ?
"""


def fetch_cliente(numero: int):
    """Devuelve {'numero': int, 'nombre': str} o None si no existe."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_CLIENTE, (int(numero),))
        row = cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in cur.description]
        d = dict(zip(cols, row))
        nombre = d.get("nombre")
        return {
            "numero": int(d["numero"]),
            "nombre": str(nombre).strip() if nombre is not None else None,
        }
    finally:
        conn.close()


# Búsqueda por código (substring numérico) o nombre (substring) — para el
# filtro de clientes de /ventas/vendedor (2026-08-14). A
# diferencia de fetch_cliente (lookup exacto por número), esto alimenta un
# autocomplete: el usuario tipea parte del código o parte del nombre y elige
# de la lista antes de "Filtrar".
SQL_CLIENTES_SEARCH = """
SELECT TOP ({limit})
    c.CodCliente                    AS numero,
    LTRIM(RTRIM(c.Cliente_Nombre))  AS nombre
FROM MAGNUS_SITD.dbo.Clientes c
WHERE CAST(c.CodCliente AS varchar(20)) LIKE ? OR c.Cliente_Nombre LIKE ?
ORDER BY c.Cliente_Nombre
"""


# ── Cartera del vendedor — acceso por vendedor de /ventas/vendedor ────────
#
# El criterio (qué clientes son de un vendedor) vive en cartera.py, que es el
# único lugar donde se define. Acá solo se lo enchufa al buscador.
#
# Historia, porque cuesta creerlo: hasta 2026-08-27 esto joineaba contra
# `Ped_Usu_Arma`, el maestro equivocado, y por eso la mayoría de los
# vendedores no encontraba NINGÚN cliente en el buscador (ver cartera.py).
# En el mismo lugar había además un `TOP ({limit})3` — una "3" perdida que
# rompía la query con error de sintaxis cuando venía un vendedor. Los dos
# bugs tapaban al otro: el que zafaba del error de sintaxis se comía la lista
# vacía.
# El JOIN de cartera se arma por vendedor (trae también los códigos de sus
# antecesores, ver vendedores.py) y NO consume parámetros: los dos únicos `?`
# de esta consulta son los del LIKE.
def _sql_clientes_search_por_vendedor(vendedor) -> str:
    return """
SELECT TOP ({limit})
    c.CodCliente                    AS numero,
    LTRIM(RTRIM(c.Cliente_Nombre))  AS nombre
FROM MAGNUS_SITD.dbo.Clientes c
""" + sql_join_cartera(vendedor) + """
WHERE (CAST(c.CodCliente AS varchar(20)) LIKE ? OR c.Cliente_Nombre LIKE ?)
ORDER BY c.Cliente_Nombre
"""


def fetch_clientes_por_codigos(codigos: list[int]) -> dict[int, str]:
    """Nombre de cliente para una LISTA de códigos, en una sola consulta
    (IN batch) — para /clientes/nombres, que usa /api/ventas/faltantes
    (Next.js) para resolver de una vez los nombres que faltan en
    preparado.faltante_wms (filas viejas persistidas antes de que esa tabla
    guardara `clienteNombre`, o sin match). Se llama UNA vez por request con
    todos los códigos sin nombre juntos, nunca uno por fila.
    Devuelve {codigo: nombre}; un código sin match en Magnus no aparece en
    el dict (el caller decide el fallback)."""
    codigos_i = sorted({int(c) for c in codigos if c is not None})
    if not codigos_i:
        return {}
    placeholders = ",".join("?" for _ in codigos_i)
    sql = f"""
SELECT c.CodCliente AS numero, LTRIM(RTRIM(c.Cliente_Nombre)) AS nombre
FROM MAGNUS_SITD.dbo.Clientes c
WHERE c.CodCliente IN ({placeholders})
"""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(sql, codigos_i)
        cols = [d[0] for d in cur.description]
        out: dict[int, str] = {}
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            nombre = d.get("nombre")
            if nombre:
                out[int(d["numero"])] = str(nombre).strip()
        return out
    finally:
        conn.close()


def fetch_vendedor_fijo_cliente(cod_cliente: int, vendedor: int) -> bool:
    """Compat: quedó como alias de cartera.cliente_es_de_vendedor. Antes
    devolvía UN código de vendedor (el "Vendedor por Defecto"), pero eso ya
    no alcanza: un cliente puede pertenecer a un vendedor por historial sin
    tener zona, y la zona puede apuntar a otro. Ahora se pregunta por la
    pertenencia, no por "cuál es su vendedor"."""
    return cliente_es_de_vendedor(cod_cliente, vendedor)


def fetch_clientes_search(q: str, limit: int = 20, vendedor: int | None = None):
    """Devuelve hasta `limit` clientes {'numero', 'nombre'} que matchean `q`
    por código o por nombre (substring, no exacto). Lista vacía si `q` está
    vacío — no se trae el padrón completo de clientes por accidente.

    `vendedor` si se pasa, SOLO devuelve clientes de SU cartera (la propia
    más la de sus antecesores, ver cartera.py y vendedores.py) —
    filtrado server-side en el mismo SELECT, no hay pool ni post-filtrado en
    Python. Un usuario no-admin nunca debe ni siquiera ENCONTRAR en el
    buscador un cliente que no es suyo. Admins llaman sin `vendedor` (ven
    todos)."""
    texto = (q or "").strip()
    if not texto:
        return []
    like = f"%{texto}%"
    limit_i = max(1, min(int(limit or 20), 50))
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        if vendedor is None:
            cur.execute(SQL_CLIENTES_SEARCH.format(limit=limit_i), (like, like))
        else:
            cur.execute(
                _sql_clientes_search_por_vendedor(vendedor).format(limit=limit_i),
                (like, like),
            )
        cols = [d[0] for d in cur.description]
        out = []
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            nombre = d.get("nombre")
            out.append({
                "numero": int(d["numero"]),
                "nombre": str(nombre).strip() if nombre is not None else None,
            })
        return out
    finally:
        conn.close()
