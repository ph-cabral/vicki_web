"""
Mostradores — control de códigos patrón por línea.

Tres fuentes, todas chicas:
  · Postgres `catalogo.*`  → líneas (linea) y sus códigos patrón (patron →
    sub_linea → linea). Es el mismo catálogo de /ventas/lineas.
  · Magnus StkFer_Articulos → el DETALLE (DetallePatron) de cada código patrón.
    No está en el catálogo de Postgres. Se trae UNA vez para todos los patrones
    (un GROUP BY sobre ~41k filas → ~1.700 filas) y se cachea 15 min, igual que
    catalogo_pg: no hay razón para pegarle a Magnus por cada línea que se abre.
  · Postgres `everwear.mostrador_control` → los controles (ver
    sql/mostradores_control.sql): uno pendiente por patrón como máximo, y los
    cerrados con su Excel (bytea).

Nada de esto toca filas de venta/pedido, así que no hay volumen que cuidar más
allá de no traer el bytea del Excel en los listados (sólo al descargar).
"""
import time

from db import get_connection
from db_pg import get_pg_connection

_TTL_SEG = 15 * 60
_cache_detalle: dict[str, str] | None = None
_cache_detalle_ts: float = 0.0

# Mismo criterio que bulones.py (_DETALLE_PATRON): el patrón tiene un solo
# nombre, pero hay artículos con la descripción vieja → MAX(LTRIM(RTRIM())).
_SQL_DETALLES = """
SELECT LTRIM(RTRIM(ArticuloPatron)) AS Patron,
       MAX(LTRIM(RTRIM(DetallePatron))) AS Detalle
FROM StkFer_Articulos
WHERE ArticuloPatron <> ''
GROUP BY ArticuloPatron
"""


def _limpiar_detalle(txt: str | None) -> str:
    """Hay detalles cargados con guiones de orden al principio
    ("-BULON PERFORADO", "--------FILTROS WEGA"): se sacan para mostrar."""
    return (txt or "").strip().lstrip("-").strip()


def detalles_patron(forzar: bool = False) -> dict[str, str]:
    """codigo_patron -> detalle (Magnus), cacheado 15 min."""
    global _cache_detalle, _cache_detalle_ts
    ahora = time.monotonic()
    if forzar or _cache_detalle is None or (ahora - _cache_detalle_ts) > _TTL_SEG:
        conn = get_connection("EVERWEAR")
        try:
            cur = conn.cursor()
            cur.execute(_SQL_DETALLES)
            _cache_detalle = {
                (p or "").strip(): _limpiar_detalle(d) for p, d in cur.fetchall() if p
            }
        finally:
            conn.close()
        _cache_detalle_ts = ahora
    return _cache_detalle


# ── Líneas ────────────────────────────────────────────────────────────────
# `controlados` = patrones de la línea con al menos un control cerrado. El
# DISTINCT de la CTE evita contar dos veces un patrón controlado varias veces.
_SQL_LINEAS = """
WITH ctrl AS (
    SELECT DISTINCT "codigoPatron"
    FROM everwear.mostrador_control
    WHERE estado = 'cerrado'
)
SELECT l.id, l.nombre,
       COUNT(p.id)              AS patrones,
       COUNT(c."codigoPatron")  AS controlados
FROM catalogo.linea l
LEFT JOIN catalogo.sub_linea sl ON sl.linea_id = l.id
LEFT JOIN catalogo.patron p     ON p.sub_linea_id = sl.id
LEFT JOIN ctrl c                ON c."codigoPatron" = p.codigo_patron
GROUP BY l.id, l.nombre
ORDER BY l.nombre, l.id
"""


def fetch_lineas() -> dict:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_LINEAS)
        filas = cur.fetchall()
    finally:
        conn.close()
    # Nombres repetidos ("Varios" existe dos veces): se distinguen con el id.
    cuenta: dict[str, int] = {}
    for _, nombre, _, _ in filas:
        k = (nombre or "").strip().lower()
        cuenta[k] = cuenta.get(k, 0) + 1
    lineas = []
    for lid, nombre, patrones, controlados in filas:
        n = (nombre or "").strip()
        if cuenta.get(n.lower(), 0) > 1:
            n = f"{n} (#{lid})"
        lineas.append({
            "id": int(lid),
            "nombre": n,
            "patrones": int(patrones),
            "controlados": int(controlados),
        })
    return {"lineas": lineas}


# ── Patrones de una línea ─────────────────────────────────────────────────
# Código patrón numérico primero (por valor, no por texto: 139 < 1014).
_SQL_PATRONES = """
SELECT p.codigo_patron, sl.nombre
FROM catalogo.patron p
JOIN catalogo.sub_linea sl ON sl.id = p.sub_linea_id
WHERE sl.linea_id = %s
ORDER BY (CASE WHEN p.codigo_patron ~ '^[0-9]+$' THEN p.codigo_patron::bigint END) NULLS LAST,
         p.codigo_patron
"""

# Sin el bytea del Excel: sólo si tiene archivo. Usa el índice por código.
_SQL_CONTROLES = """
SELECT id, "codigoPatron", estado, "cerradoAt",
       ("archivoNombre" IS NOT NULL) AS tiene_archivo
FROM everwear.mostrador_control
WHERE "codigoPatron" = ANY(%s)
ORDER BY "codigoPatron", COALESCE("cerradoAt", "mandadoAt") DESC
"""


def fetch_patrones_linea(linea_id: int) -> dict:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, nombre FROM catalogo.linea WHERE id = %s", (linea_id,))
        lin = cur.fetchone()
        if not lin:
            raise LookupError("Línea inexistente")
        cur.execute(_SQL_PATRONES, (linea_id,))
        patrones = cur.fetchall()
        codigos = [c for c, _ in patrones]
        controles = []
        if codigos:
            cur.execute(_SQL_CONTROLES, (codigos,))
            controles = cur.fetchall()
    finally:
        conn.close()

    por_codigo: dict[str, dict] = {}
    for cid, codigo, estado, cerrado_at, tiene_archivo in controles:
        d = por_codigo.setdefault(codigo, {"pendiente": False, "controles": []})
        if estado == "pendiente":
            d["pendiente"] = True
        else:
            d["controles"].append({
                "id": int(cid),
                "fecha": cerrado_at.isoformat() if cerrado_at else None,
                "tieneArchivo": bool(tiene_archivo),
            })

    detalles = detalles_patron()
    filas = []
    for codigo, sub in patrones:
        d = por_codigo.get(codigo, {"pendiente": False, "controles": []})
        filas.append({
            "codigo": codigo,
            "detalle": detalles.get(codigo, ""),
            "subLinea": (sub or "").strip(),
            "pendiente": d["pendiente"],
            "controlado": len(d["controles"]) > 0,
            "controles": d["controles"],
        })
    return {"linea": {"id": int(lin[0]), "nombre": (lin[1] or "").strip()}, "patrones": filas}


# ── Mandar a control ──────────────────────────────────────────────────────
def mandar_a_control(codigo_patron: str, usuario_id: int | None) -> dict:
    """Deja el patrón pendiente de control. Máximo UNO pendiente por patrón
    (índice único parcial): mandarlo dos veces no duplica."""
    codigo = (codigo_patron or "").strip()
    if not codigo:
        raise ValueError("Falta el código patrón")
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM catalogo.patron WHERE codigo_patron = %s", (codigo,))
        if not cur.fetchone():
            raise LookupError("Código patrón inexistente")
        cur.execute(
            """
            INSERT INTO everwear.mostrador_control ("codigoPatron", estado, "mandadoPor")
            VALUES (%s, 'pendiente', %s)
            ON CONFLICT ("codigoPatron") WHERE estado = 'pendiente' DO NOTHING
            RETURNING id
            """,
            (codigo, usuario_id),
        )
        creado = cur.fetchone() is not None
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "yaPendiente": not creado}


# ── Pendientes (vista Control) ────────────────────────────────────────────
_SQL_PENDIENTES = """
SELECT mc.id, mc."codigoPatron", mc."mandadoAt", l.id, l.nombre
FROM everwear.mostrador_control mc
LEFT JOIN catalogo.patron p     ON p.codigo_patron = mc."codigoPatron"
LEFT JOIN catalogo.sub_linea sl ON sl.id = p.sub_linea_id
LEFT JOIN catalogo.linea l      ON l.id = sl.linea_id
WHERE mc.estado = 'pendiente'
ORDER BY mc."mandadoAt", mc.id
"""


def fetch_pendientes() -> dict:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_PENDIENTES)
        filas = cur.fetchall()
    finally:
        conn.close()
    detalles = detalles_patron() if filas else {}
    return {
        "pendientes": [
            {
                "id": int(i),
                "codigo": codigo,
                "detalle": detalles.get(codigo, ""),
                "lineaId": int(lid) if lid is not None else None,
                "linea": (lnom or "").strip(),
                "mandadoAt": m.isoformat() if m else None,
            }
            for i, codigo, m, lid, lnom in filas
        ]
    }


# ── Excel de un control cerrado ───────────────────────────────────────────
def fetch_excel(control_id: int) -> tuple[str, bytes] | None:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT "archivoNombre", archivo
            FROM everwear.mostrador_control
            WHERE id = %s AND estado = 'cerrado' AND archivo IS NOT NULL
            """,
            (control_id,),
        )
        fila = cur.fetchone()
    finally:
        conn.close()
    if not fila:
        return None
    nombre, archivo = fila
    return nombre, bytes(archivo)
