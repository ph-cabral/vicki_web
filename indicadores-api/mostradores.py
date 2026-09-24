"""
Mostradores — control de códigos patrón por línea.

Dos fuentes, todas chicas:
  · Magnus → las LÍNEAS y sus códigos patrón. "Línea" es el Nivel1 de Magnus
    (Stk_Parametros.DetalleNivel1 = 'Línea'; maestro Stk_Nivel1) y cada código
    patrón cuelga de una línea por StkFer_ArtParamet.Nivel1 (una fila por patrón,
    ~1.700, con su nombre en Detalle y el rubro en Nivel2 → Stk_Nivel2). Se trae
    todo junto UNA vez (3 consultas de maestros, sin tocar filas de venta) y se
    cachea 15 min: no hay razón para pegarle a Magnus por cada línea que se abre.
    OJO: NO es el catálogo de Postgres (`catalogo.*`, el de /ventas/lineas): acá
    las líneas que se muestran son las de Magnus.
  · Postgres `everwear.mostrador_control` → los controles (ver
    sql/mostradores_control.sql): uno pendiente por patrón como máximo, y los
    cerrados con su Excel (bytea). Se referencia al patrón por CÓDIGO.

Nada de esto toca filas de venta/pedido, así que no hay volumen que cuidar más
allá de no traer el bytea del Excel en los listados (sólo al descargar).
"""
import threading
import time
from decimal import Decimal, InvalidOperation

from db import get_connection
from db_pg import get_pg_connection

_TTL_SEG = 15 * 60
_cache_maestro: dict | None = None
_cache_maestro_ts: float = 0.0

# Máximo de controles cerrados que se muestran por patrón (los más nuevos).
MAX_CONTROLES_VISIBLES = 3

_SQL_LINEAS_MAGNUS = "SELECT Nivel1, RTRIM(Detalle) FROM Stk_Nivel1"
_SQL_RUBROS_MAGNUS = "SELECT Nivel2, RTRIM(Detalle) FROM Stk_Nivel2"
# Nivel1 = 0 → patrones sin línea asignada (6 filas de basura: 116, 797, BAJA…):
# no pertenecen a ninguna línea, quedan afuera.
_SQL_PATRONES_MAGNUS = """
SELECT LTRIM(RTRIM(ArticuloPatron)) AS Patron, Nivel1, Nivel2,
       RTRIM(Detalle) AS Detalle
FROM StkFer_ArtParamet
WHERE Nivel1 > 0
"""


def _limpiar_detalle(txt: str | None) -> str:
    """Hay detalles cargados con guiones de orden al principio
    ("-BULON PERFORADO", "--------FILTROS WEGA"): se sacan para mostrar."""
    return (txt or "").strip().lstrip("-").strip()


def _clave_codigo(codigo: str):
    """Código patrón numérico primero, por valor (139 < 1014); después el resto."""
    return (0, int(codigo), "") if codigo.isdigit() else (1, 0, codigo)


def maestro_magnus(forzar: bool = False) -> dict:
    """Líneas y patrones de Magnus, cacheado 15 min.

    {"lineas": {id: nombre}, "patrones": {codigo: {...}},
     "por_linea": {id: [codigo, ...] ordenados}}
    """
    global _cache_maestro, _cache_maestro_ts
    ahora = time.monotonic()
    if not forzar and _cache_maestro is not None and (ahora - _cache_maestro_ts) <= _TTL_SEG:
        return _cache_maestro

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute(_SQL_LINEAS_MAGNUS)
        lineas = {int(i): (n or "").strip() for i, n in cur.fetchall()}
        cur.execute(_SQL_RUBROS_MAGNUS)
        rubros = {int(i): (n or "").strip() for i, n in cur.fetchall()}
        cur.execute(_SQL_PATRONES_MAGNUS)
        filas = cur.fetchall()
    finally:
        conn.close()

    patrones: dict[str, dict] = {}
    por_linea: dict[int, list[str]] = {}
    for codigo, n1, n2, detalle in filas:
        codigo = (codigo or "").strip()
        n1 = int(n1)
        if not codigo or n1 not in lineas:
            continue
        patrones[codigo] = {
            "linea": n1,
            "rubro": rubros.get(int(n2 or 0), ""),
            "detalle": _limpiar_detalle(detalle),
        }
        por_linea.setdefault(n1, []).append(codigo)
    for lista in por_linea.values():
        lista.sort(key=_clave_codigo)

    _cache_maestro = {"lineas": lineas, "patrones": patrones, "por_linea": por_linea}
    _cache_maestro_ts = ahora
    return _cache_maestro


def _nombre_linea(lid: int, nombre: str) -> str:
    """La línea 9 se llama literalmente "-" en Magnus (555 patrones)."""
    n = _limpiar_detalle(nombre)
    return n or f"(Sin nombre) #{lid}"


# ── Líneas ────────────────────────────────────────────────────────────────
# `controlados` = patrones de la línea con al menos un control cerrado. Se pide
# UNA vez la lista de códigos con control cerrado (DISTINCT: un patrón controlado
# varias veces cuenta uno) y se cruza en memoria con el maestro de Magnus.
_SQL_CODIGOS_CONTROLADOS = """
SELECT DISTINCT "codigoPatron"
FROM everwear.mostrador_control
WHERE estado = 'cerrado'
"""


def fetch_lineas() -> dict:
    m = maestro_magnus()
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_CODIGOS_CONTROLADOS)
        controlados = {c for (c,) in cur.fetchall()}
    finally:
        conn.close()

    lineas = []
    for lid, codigos in m["por_linea"].items():  # sólo líneas con patrones
        lineas.append({
            "id": lid,
            "nombre": _nombre_linea(lid, m["lineas"][lid]),
            "patrones": len(codigos),
            "controlados": sum(1 for c in codigos if c in controlados),
        })
    lineas.sort(key=lambda x: (x["nombre"].lower(), x["id"]))
    return {"lineas": lineas}


# ── Patrones de una línea ─────────────────────────────────────────────────
# Sin el bytea del Excel: sólo si tiene archivo. Usa el índice por código.
# Cerrados: los MAX_CONTROLES_VISIBLES más nuevos por patrón (ROW_NUMBER sobre
# el índice (codigoPatron, cerradoAt DESC)). Pendientes: a lo sumo uno por patrón.
_SQL_CONTROLES = """
SELECT id, "codigoPatron", estado, "cerradoAt", tiene_archivo
FROM (
    SELECT id, "codigoPatron", estado, "cerradoAt",
           ("archivoNombre" IS NOT NULL) AS tiene_archivo,
           ROW_NUMBER() OVER (
               PARTITION BY "codigoPatron"
               ORDER BY "cerradoAt" DESC NULLS LAST, id DESC
           ) AS rn
    FROM everwear.mostrador_control
    WHERE "codigoPatron" = ANY(%s) AND estado = 'cerrado'
) t
WHERE rn <= %s
UNION ALL
SELECT id, "codigoPatron", estado, NULL, FALSE
FROM everwear.mostrador_control
WHERE "codigoPatron" = ANY(%s) AND estado = 'pendiente'
"""


def fetch_patrones_linea(linea_id: int) -> dict:
    m = maestro_magnus()
    if linea_id not in m["lineas"] or linea_id not in m["por_linea"]:
        raise LookupError("Línea inexistente")
    codigos = m["por_linea"][linea_id]

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_CONTROLES, (codigos, MAX_CONTROLES_VISIBLES, codigos))
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
                "_orden": (cerrado_at.timestamp() if cerrado_at else 0.0, int(cid)),
            })

    filas = []
    for codigo in codigos:
        info = m["patrones"][codigo]
        d = por_codigo.get(codigo, {"pendiente": False, "controles": []})
        # Más nuevo arriba → más viejo abajo (el UNION no garantiza el orden).
        ctrls = sorted(d["controles"], key=lambda c: c["_orden"], reverse=True)
        for c in ctrls:
            del c["_orden"]
        filas.append({
            "codigo": codigo,
            "detalle": info["detalle"],
            "subLinea": info["rubro"],
            "pendiente": d["pendiente"],
            "controlado": len(ctrls) > 0,
            "controles": ctrls[:MAX_CONTROLES_VISIBLES],
        })
    return {
        "linea": {"id": linea_id, "nombre": _nombre_linea(linea_id, m["lineas"][linea_id])},
        "patrones": filas,
    }


# ── Mandar a control ──────────────────────────────────────────────────────
def mandar_a_control(codigo_patron: str, usuario_id: int | None) -> dict:
    """Deja el patrón pendiente de control. Máximo UNO pendiente por patrón
    (índice único parcial): mandarlo dos veces no duplica."""
    codigo = (codigo_patron or "").strip()
    if not codigo:
        raise ValueError("Falta el código patrón")
    if codigo not in maestro_magnus()["patrones"]:
        raise LookupError("Código patrón inexistente")
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
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
SELECT id, "codigoPatron", "mandadoAt"
FROM everwear.mostrador_control
WHERE estado = 'pendiente'
ORDER BY "mandadoAt", id
"""


def fetch_pendientes() -> dict:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_PENDIENTES)
        filas = cur.fetchall()
    finally:
        conn.close()
    m = maestro_magnus() if filas else {"lineas": {}, "patrones": {}}
    salida = []
    for i, codigo, mandado in filas:
        info = m["patrones"].get(codigo)
        lid = info["linea"] if info else None
        salida.append({
            "id": int(i),
            "codigo": codigo,
            "detalle": info["detalle"] if info else "",
            "lineaId": lid,
            "linea": _nombre_linea(lid, m["lineas"][lid]) if lid is not None else "",
            "mandadoAt": mandado.isoformat() if mandado else None,
        })
    return {"pendientes": salida}


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


# ── Conteo en PDA (vista Control) ─────────────────────────────────────────
# El PDA lista los ARTÍCULOS de los patrones pendientes (sólo esos: se arranca y
# se termina patrón por patrón) y guarda una cantidad contada por artículo.
#
# Tabla `everwear.mostrador_conteo` (sql/mostradores_conteo.sql; también se crea
# sola la primera vez que se usa): PK ("controlId","codArticulo") → un valor por
# artículo y control; volver a contar REEMPLAZA la cantidad. Se guarda además
# la foto del stock de sistema (StkFer_Articulos.StkReal) al momento de contar,
# para comparar al cerrar el control. El PDA no muestra el stock (conteo ciego).
_DDL_CONTEO = """
CREATE TABLE IF NOT EXISTS everwear.mostrador_conteo (
  "controlId"    BIGINT        NOT NULL REFERENCES everwear.mostrador_control(id) ON DELETE CASCADE,
  "codArticulo"  TEXT          NOT NULL,
  cantidad       NUMERIC(13,3) NOT NULL CHECK (cantidad >= 0),
  "stockSistema" NUMERIC(13,3),
  "contadoPor"   INT,
  "contadoAt"    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY ("controlId", "codArticulo")
)
"""
_ddl_conteo_ok = False
_ddl_lock = threading.Lock()


def _asegurar_tabla_conteo(cur) -> None:
    global _ddl_conteo_ok
    if _ddl_conteo_ok:
        return
    with _ddl_lock:
        if not _ddl_conteo_ok:
            cur.execute(_DDL_CONTEO)
            cur.connection.commit()
            _ddl_conteo_ok = True


# Artículos de los patrones: entra por el índice KF_ART_Cla_ArticuloPatron y
# por K_BAR_Cla_ArticuloBarra (CodArticulo, CodBarra). Medido: 3.400 filas
# (patrones 1678 + 139, los más grandes) en < 1 ms de servidor.
# Universo: activos/suspendidos (Estado <> 3) + los dados de baja que todavía
# tienen stock (hay que contarlos igual). Estado 1 = 22,5k, 2 = 1,3k, 3 = 17,4k.
# Un artículo puede tener varios códigos de barra (Stk_ArticBarras), algunos de
# contenedor ("Caja" x100): todos sirven para escanear.
_SQL_ARTICULOS_PATRONES = """
SELECT RTRIM(s.ArticuloPatron), RTRIM(s.CodArticulo), RTRIM(s.DetalleMedida),
       RTRIM(s.CodBarra), RTRIM(b.CodBarra), b.ContenedorCantContenida,
       RTRIM(b.ContendorNombre)
FROM StkFer_Articulos s
LEFT JOIN Stk_ArticBarras b ON b.CodArticulo = s.CodArticulo
WHERE s.ArticuloPatron IN ({marcas})
  AND (s.Estado <> 3 OR s.StkReal <> 0)
"""

_ART_TTL_SEG = 10 * 60
_cache_articulos: dict[str, tuple[float, list[dict]]] = {}


def _articulos_de_patrones(codigos: list[str]) -> dict[str, list[dict]]:
    """{patron: [{cod, medida, barras:[{codigo, cant, envase}]}]} — cache 10 min
    por patrón (el maestro de artículos casi no cambia durante un conteo)."""
    ahora = time.monotonic()
    salida: dict[str, list[dict]] = {}
    faltan = []
    for c in codigos:
        hit = _cache_articulos.get(c)
        if hit and ahora - hit[0] <= _ART_TTL_SEG:
            salida[c] = hit[1]
        else:
            faltan.append(c)
    if faltan:
        conn = get_connection("EVERWEAR")
        try:
            cur = conn.cursor()
            cur.execute(
                _SQL_ARTICULOS_PATRONES.format(marcas=",".join("?" * len(faltan))),
                faltan,
            )
            filas = cur.fetchall()
        finally:
            conn.close()
        por_pat: dict[str, dict[str, dict]] = {c: {} for c in faltan}
        for pat, cod, medida, barra_ppal, barra, cant, envase in filas:
            pat = (pat or "").strip()
            cod = (cod or "").strip()
            if not cod or pat not in por_pat:
                continue
            a = por_pat[pat].setdefault(cod, {"cod": cod, "medida": (medida or "").strip(), "barras": {}})
            for bc, n, env in ((cod, 1, ""), ((barra_ppal or "").strip(), 1, ""),
                               ((barra or "").strip(), int(cant or 0), (envase or "").strip())):
                if bc and (bc not in a["barras"] or n > 1):
                    a["barras"][bc] = {"codigo": bc, "cant": n if n > 1 else 1, "envase": env if n > 1 else ""}
        for pat, arts in por_pat.items():
            lista = []
            for a in arts.values():
                a["barras"] = list(a["barras"].values())
                lista.append(a)
            lista.sort(key=lambda a: (a["medida"].lower(), a["cod"]))
            _cache_articulos[pat] = (ahora, lista)
            salida[pat] = lista
    return salida


_SQL_PENDIENTES_CONTEO = """
SELECT id, "codigoPatron" FROM everwear.mostrador_control
WHERE estado = 'pendiente' ORDER BY "mandadoAt", id
"""
_SQL_CONTEOS = """
SELECT "controlId", "codArticulo", cantidad, "contadoAt"
FROM everwear.mostrador_conteo WHERE "controlId" = ANY(%s)
"""


def _num(v) -> float | int | None:
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


def fetch_conteo() -> dict:
    """Todo lo que necesita el PDA en una sola llamada: patrones pendientes y
    sus artículos con lo ya contado."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_tabla_conteo(cur)
        cur.execute(_SQL_PENDIENTES_CONTEO)
        pend = [(int(i), c) for i, c in cur.fetchall()]
        conteos = {}
        if pend:
            cur.execute(_SQL_CONTEOS, ([i for i, _ in pend],))
            for cid, cod, cant, at in cur.fetchall():
                conteos[(int(cid), cod)] = (_num(cant), at.isoformat() if at else None)
    finally:
        conn.close()
    if not pend:
        return {"patrones": [], "articulos": []}

    m = maestro_magnus()
    arts = _articulos_de_patrones([c for _, c in pend])
    patrones, articulos = [], []
    for cid, codigo in pend:
        info = m["patrones"].get(codigo, {})
        det_pat = info.get("detalle", "")
        lista = arts.get(codigo, [])
        contados = 0
        for a in lista:
            c = conteos.get((cid, a["cod"]))
            if c:
                contados += 1
            articulos.append({
                "controlId": cid,
                "patron": codigo,
                "cod": a["cod"],
                "detalle": f"{det_pat} {a['medida']}".strip(),
                "barras": a["barras"],
                "contado": c[0] if c else None,
                "contadoAt": c[1] if c else None,
            })
        lid = info.get("linea")
        patrones.append({
            "controlId": cid,
            "codigo": codigo,
            "detalle": det_pat,
            "linea": _nombre_linea(lid, m["lineas"][lid]) if lid in m["lineas"] else "",
            "total": len(lista),
            "contados": contados,
        })
    return {"patrones": patrones, "articulos": articulos}


def guardar_conteo(control_id: int, cod_articulo: str, cantidad, usuario_id: int | None) -> dict:
    """Guarda (o reemplaza) la cantidad contada de un artículo. Valida que el
    control siga pendiente y que el artículo sea de ese patrón; toma la foto del
    stock de sistema en la misma lectura (una fila, por PK)."""
    cod = (cod_articulo or "").strip()
    if not cod:
        raise ValueError("Falta el artículo")
    try:
        cant = Decimal(str(cantidad))
    except (InvalidOperation, ValueError):
        raise ValueError("Cantidad inválida")
    if not cant.is_finite() or cant < 0 or cant >= Decimal("1e10"):
        raise ValueError("Cantidad inválida")
    cant = cant.quantize(Decimal("0.001"))

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_tabla_conteo(cur)
        cur.execute(
            """SELECT "codigoPatron" FROM everwear.mostrador_control
               WHERE id = %s AND estado = 'pendiente'""",
            (control_id,),
        )
        fila = cur.fetchone()
        if not fila:
            raise LookupError("El patrón ya no está en control")
        patron = fila[0]

        mconn = get_connection("EVERWEAR")
        try:
            mcur = mconn.cursor()
            mcur.execute(
                "SELECT RTRIM(ArticuloPatron), StkReal FROM StkFer_Articulos WHERE CodArticulo = ?",
                (cod,),
            )
            art = mcur.fetchone()
        finally:
            mconn.close()
        if not art or (art[0] or "").strip() != patron:
            raise LookupError("El artículo no es de este patrón")

        cur.execute(
            """
            INSERT INTO everwear.mostrador_conteo
                ("controlId", "codArticulo", cantidad, "stockSistema", "contadoPor")
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT ("controlId", "codArticulo") DO UPDATE
               SET cantidad = EXCLUDED.cantidad,
                   "stockSistema" = EXCLUDED."stockSistema",
                   "contadoPor" = EXCLUDED."contadoPor",
                   "contadoAt" = now()
            RETURNING "contadoAt"
            """,
            (control_id, cod, cant, art[1], usuario_id),
        )
        at = cur.fetchone()[0]
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "controlId": control_id, "cod": cod,
            "cantidad": _num(cant), "contadoAt": at.isoformat() if at else None}
