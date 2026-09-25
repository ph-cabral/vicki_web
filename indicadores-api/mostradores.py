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
# Artículos contables por patrón — MISMO universo que el PDA
# (_SQL_ARTICULOS_PATRONES): activos/suspendidos + dados de baja con stock.
# Un patrón sin ninguno (todos sus artículos de baja y en 0, ej. 0004 "TABLEROS
# BAJA": 9 artículos Estado 3, StkReal 0) no tiene nada que contar: no se lista
# en Administrar ni se puede mandar a control. Al 2026-09-25 son 683 de 1.709
# patrones con línea. Una pasada agrupada (~24k filas), cacheada con el maestro.
_SQL_ARTICULOS_POR_PATRON = """
SELECT LTRIM(RTRIM(ArticuloPatron)), COUNT(*)
FROM StkFer_Articulos
WHERE Estado <> 3 OR StkReal <> 0
GROUP BY ArticuloPatron
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
        cur.execute(_SQL_ARTICULOS_POR_PATRON)
        n_arts = {(c or "").strip(): int(n) for c, n in cur.fetchall()}
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
            "articulos": n_arts.get(codigo, 0),
        }
        # Sin artículos contables → queda en `patrones` (para resolver el
        # detalle de controles viejos) pero no se lista en ninguna línea.
        if patrones[codigo]["articulos"] > 0:
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
    info = maestro_magnus()["patrones"].get(codigo)
    if info is None:
        raise LookupError("Código patrón inexistente")
    if codigo not in _codigos_validos():
        raise ValueError(
            f"El patrón {codigo} no tiene artículos para controlar "
            "(todos dados de baja y sin stock)"
        )
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


# ── En control (panel derecho de Administrar) ────────────────────────────
# Patrones pendientes con su avance: artículos contados en el PDA contra el
# total del patrón (el mismo universo que lista el PDA, _articulos_de_patrones,
# cacheado 10 min) y quién los está contando (usuarios de mostrador_conteo con
# cuántos contó cada uno). Todo sale de 2 consultas chicas a Postgres agrupadas
# por control (PK de mostrador_conteo empieza por "controlId") + el cache.
_SQL_PENDIENTES = """
SELECT c.id, c."codigoPatron", c."mandadoAt", u.nombre, t.nombre, c."tomadoPor", c."tomadoAt"
FROM everwear.mostrador_control c
LEFT JOIN everwear.usuario u ON u.id = c."mandadoPor"
LEFT JOIN everwear.usuario t ON t.id = c."tomadoPor"
WHERE c.estado = 'pendiente'
ORDER BY c."mandadoAt", c.id
"""
_SQL_AVANCE_USUARIOS = """
SELECT k."controlId", k."contadoPor", u.nombre, count(*), max(k."contadoAt")
FROM everwear.mostrador_conteo k
LEFT JOIN everwear.usuario u ON u.id = k."contadoPor"
WHERE k."controlId" = ANY(%s)
GROUP BY k."controlId", k."contadoPor", u.nombre
"""


# Pendientes de patrones que NO se consideran (sin artículos contables, o que
# ya no cuelgan de ninguna línea): se borran solos al listar/tomar, siempre que
# no tengan nada contado. Así no aparecen en el PDA ni en "En control" y no
# dejan trabado al usuario que los había tomado (índice único de toma).
_SQL_PURGAR_SIN_ARTICULOS = """
DELETE FROM everwear.mostrador_control c
WHERE c.estado = 'pendiente'
  AND NOT (c."codigoPatron" = ANY(%s))
  AND NOT EXISTS (SELECT 1 FROM everwear.mostrador_conteo k WHERE k."controlId" = c.id)
"""


def _codigos_validos() -> set[str]:
    """Patrones que se consideran: con línea y con ≥1 artículo contable."""
    return {c for cods in maestro_magnus()["por_linea"].values() for c in cods}


def _purgar_sin_articulos(cur) -> None:
    validos = _codigos_validos()
    if not validos:  # maestro vacío (falla de lectura): no borrar nada
        return
    _asegurar_tabla_conteo(cur)
    cur.execute(_SQL_PURGAR_SIN_ARTICULOS, (list(validos),))
    if cur.rowcount:
        cur.connection.commit()


def fetch_pendientes() -> dict:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_toma(cur)
        _purgar_sin_articulos(cur)
        cur.execute(_SQL_PENDIENTES)
        filas = cur.fetchall()
        avance: dict[int, list] = {}
        if filas:
            _asegurar_tabla_conteo(cur)
            cur.execute(_SQL_AVANCE_USUARIOS, ([int(f[0]) for f in filas],))
            for cid, uid, nombre, n, ult in cur.fetchall():
                avance.setdefault(int(cid), []).append((uid, (nombre or "").strip(), int(n), ult))
    finally:
        conn.close()
    if not filas:
        return {"pendientes": []}

    m = maestro_magnus()
    arts = _articulos_de_patrones([f[1] for f in filas])
    salida = []
    for i, codigo, mandado, mandado_por, tomado_nom, tomado_por, tomado_at in filas:
        cid = int(i)
        info = m["patrones"].get(codigo)
        lid = info["linea"] if info else None
        total = len(arts.get(codigo, []))
        usuarios = sorted(avance.get(cid, []), key=lambda u: (-u[2], u[1]))
        contados = sum(u[2] for u in usuarios)
        ultimo = max((u[3] for u in usuarios if u[3]), default=None)
        salida.append({
            "id": cid,
            "codigo": codigo,
            "detalle": info["detalle"] if info else "",
            "lineaId": lid,
            "linea": _nombre_linea(lid, m["lineas"][lid]) if lid is not None else "",
            "mandadoAt": mandado.isoformat() if mandado else None,
            "mandadoPor": (mandado_por or "").strip(),
            "tomadoPor": (tomado_nom or "").strip() or (f"Usuario #{tomado_por}" if tomado_por is not None else ""),
            "tomadoAt": tomado_at.isoformat() if tomado_at else None,
            "total": total,
            "contados": contados,
            "avance": round(contados * 100 / total, 1) if total else 0,
            "usuarios": [
                {"nombre": nom or (f"Usuario #{uid}" if uid is not None else "Sin usuario"), "contados": n}
                for uid, nom, n, _ in usuarios
            ],
            "ultimoConteoAt": ultimo.isoformat() if ultimo else None,
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


# ── Toma de patrón (PDA) ──────────────────────────────────────────────────
# En el PDA cada usuario TOMA un patrón pendiente y trabaja sólo ese: de a uno
# por usuario (para tomar otro tiene que finalizar el activo) y un patrón tomado
# no lo puede tomar otro usuario. Columnas "tomadoPor"/"tomadoAt" en
# mostrador_control (sql/mostradores_toma.sql; también se agregan solas) +
# índice único parcial por usuario sobre los pendientes: la regla "uno por
# usuario" la garantiza la base aunque dos PDA tomen a la vez. Al finalizar el
# control pasa a 'cerrado' y sale del índice (el usuario queda libre).
_DDL_TOMA = (
    'ALTER TABLE everwear.mostrador_control ADD COLUMN IF NOT EXISTS "tomadoPor" INT',
    'ALTER TABLE everwear.mostrador_control ADD COLUMN IF NOT EXISTS "tomadoAt" TIMESTAMPTZ',
    """CREATE UNIQUE INDEX IF NOT EXISTS mostrador_control_tomado_uk
         ON everwear.mostrador_control ("tomadoPor")
         WHERE estado = 'pendiente' AND "tomadoPor" IS NOT NULL""",
)
_ddl_toma_ok = False


def _asegurar_toma(cur) -> None:
    global _ddl_toma_ok
    if _ddl_toma_ok:
        return
    with _ddl_lock:
        if not _ddl_toma_ok:
            cur.execute(
                """SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'everwear' AND table_name = 'mostrador_control'
                     AND column_name = 'tomadoAt'"""
            )
            if not cur.fetchone():
                for ddl in _DDL_TOMA:
                    cur.execute(ddl)
            else:
                cur.execute(_DDL_TOMA[2])
            cur.connection.commit()
            _ddl_toma_ok = True


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
SELECT c.id, c."codigoPatron", c."tomadoPor", u.nombre, c."tomadoAt"
FROM everwear.mostrador_control c
LEFT JOIN everwear.usuario u ON u.id = c."tomadoPor"
WHERE c.estado = 'pendiente'
ORDER BY c."mandadoAt", c.id
"""
# Contados por control (entra por la PK de mostrador_conteo, que empieza por
# "controlId"): para la lista de patrones no hace falta traer las filas.
_SQL_CONTADOS_POR_CONTROL = """
SELECT "controlId", count(*) FROM everwear.mostrador_conteo
WHERE "controlId" = ANY(%s) GROUP BY "controlId"
"""
_SQL_CONTEOS = """
SELECT "controlId", "codArticulo", cantidad, "contadoAt"
FROM everwear.mostrador_conteo WHERE "controlId" = %s
"""


def _num(v) -> float | int | None:
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


def fetch_conteo(usuario_id: int | None) -> dict:
    """Todo lo que necesita el PDA en una sola llamada:
      · patrones: TODOS los pendientes (la vista principal), con avance y quién
        lo tomó;
      · activoId: el patrón que tiene tomado este usuario (a lo sumo uno);
      · articulos: SÓLO los del patrón activo, con lo ya contado (los demás no
        se mandan: hay patrones de miles de artículos)."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_tabla_conteo(cur)
        _asegurar_toma(cur)
        _purgar_sin_articulos(cur)
        cur.execute(_SQL_PENDIENTES_CONTEO)
        pend = [(int(i), c, tp, (nom or "").strip(), ta) for i, c, tp, nom, ta in cur.fetchall()]
        activo = next((p for p in pend if usuario_id is not None and p[2] == usuario_id), None)
        contados_por: dict[int, int] = {}
        conteos = {}
        if pend:
            cur.execute(_SQL_CONTADOS_POR_CONTROL, ([p[0] for p in pend],))
            contados_por = {int(cid): int(n) for cid, n in cur.fetchall()}
        if activo:
            cur.execute(_SQL_CONTEOS, (activo[0],))
            for cid, cod, cant, at in cur.fetchall():
                conteos[cod] = (_num(cant), at.isoformat() if at else None)
    finally:
        conn.close()
    if not pend:
        return {"patrones": [], "activoId": None, "articulos": []}

    m = maestro_magnus()
    arts = _articulos_de_patrones([p[1] for p in pend])
    patrones, articulos = [], []
    for cid, codigo, tomado_por, tomado_nom, tomado_at in pend:
        info = m["patrones"].get(codigo, {})
        det_pat = info.get("detalle", "")
        lista = arts.get(codigo, [])
        lid = info.get("linea")
        patrones.append({
            "controlId": cid,
            "codigo": codigo,
            "detalle": det_pat,
            "linea": _nombre_linea(lid, m["lineas"][lid]) if lid in m["lineas"] else "",
            "total": len(lista),
            "contados": contados_por.get(cid, 0),
            "tomadoPorId": tomado_por,
            "tomadoPor": tomado_nom or (f"Usuario #{tomado_por}" if tomado_por is not None else ""),
            "tomadoAt": tomado_at.isoformat() if tomado_at else None,
        })
        if activo and cid == activo[0]:
            for a in lista:
                c = conteos.get(a["cod"])
                articulos.append({
                    "controlId": cid,
                    "patron": codigo,
                    "cod": a["cod"],
                    "detalle": f"{det_pat} {a['medida']}".strip(),
                    "barras": a["barras"],
                    "contado": c[0] if c else None,
                    "contadoAt": c[1] if c else None,
                })
    return {"patrones": patrones, "activoId": activo[0] if activo else None, "articulos": articulos}


def tomar_control(control_id: int, usuario_id: int | None) -> dict:
    """El usuario toma un patrón pendiente para contarlo en el PDA. De a uno por
    usuario (índice único parcial) y un patrón tomado no lo toma otro."""
    import psycopg2

    if usuario_id is None:
        raise ValueError("Falta el usuario")
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_toma(cur)
        _purgar_sin_articulos(cur)
        cur.execute(
            """SELECT "codigoPatron" FROM everwear.mostrador_control
               WHERE estado = 'pendiente' AND "tomadoPor" = %s AND id <> %s""",
            (usuario_id, control_id),
        )
        otro = cur.fetchone()
        if otro:
            raise LookupError(f"Ya tenés el patrón {otro[0]} activo: finalizalo antes de tomar otro")
        try:
            cur.execute(
                """
                UPDATE everwear.mostrador_control
                   SET "tomadoPor" = %s,
                       "tomadoAt" = CASE WHEN "tomadoPor" = %s THEN "tomadoAt" ELSE now() END
                 WHERE id = %s AND estado = 'pendiente'
                   AND ("tomadoPor" IS NULL OR "tomadoPor" = %s)
                RETURNING "codigoPatron"
                """,
                (usuario_id, usuario_id, control_id, usuario_id),
            )
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            raise LookupError("Ya tenés otro patrón activo: finalizalo antes de tomar otro")
        fila = cur.fetchone()
        if not fila:
            conn.rollback()
            cur.execute(
                """SELECT c.estado, u.nombre FROM everwear.mostrador_control c
                   LEFT JOIN everwear.usuario u ON u.id = c."tomadoPor"
                   WHERE c.id = %s""",
                (control_id,),
            )
            est = cur.fetchone()
            if not est or est[0] != "pendiente":
                raise LookupError("El patrón ya no está en control")
            raise LookupError(f"El patrón lo tomó {(est[1] or 'otro usuario').strip()}")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "controlId": control_id, "patron": fila[0]}


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
        _asegurar_toma(cur)
        cur.execute(
            """SELECT "codigoPatron", "tomadoPor" FROM everwear.mostrador_control
               WHERE id = %s AND estado = 'pendiente'""",
            (control_id,),
        )
        fila = cur.fetchone()
        if not fila:
            raise LookupError("El patrón ya no está en control")
        if fila[1] != usuario_id:
            raise LookupError("El patrón no está tomado por vos")
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


# ── Finalizar control (PDA) ───────────────────────────────────────────────
# Al finalizar un patrón se pasa el control a 'cerrado' y se guarda el RESULTADO
# en `everwear.mostrador_control_detalle` (sql/mostradores_control_detalle.sql;
# también se crea sola), una fila por artículo:
#   codigo      → CodArticulo
#   controlado  → cantidad contada en el PDA
#   sistema     → StkReal de Magnus AL MOMENTO DE CONTAR ese artículo (foto
#                 tomada en guardar_conteo: se sigue vendiendo mientras se cuenta)
#   diferencia  → controlado - sistema (columna generada)
#   usuario     → quién contó el artículo (nombre; "usuarioId" = id)
# Los artículos del patrón que NO se contaron pero tienen stock en sistema
# (StkReal <> 0) se registran con controlado = 0, sistema = StkReal al finalizar,
# usuario = quien finalizó y "controladoAt" NULL (así se distinguen de los
# contados). Los no contados con stock 0 no generan fila (no hay diferencia).
# El Excel de Administrar se arma al descargar desde esta tabla (no se guarda
# el bytea): "archivoNombre" queda seteado para que el front muestre el link.
_DDL_DETALLE = """
CREATE TABLE IF NOT EXISTS everwear.mostrador_control_detalle (
  "controlId"    BIGINT        NOT NULL REFERENCES everwear.mostrador_control(id) ON DELETE CASCADE,
  codigo         TEXT          NOT NULL,
  controlado     NUMERIC(13,3) NOT NULL,
  sistema        NUMERIC(13,3) NOT NULL,
  diferencia     NUMERIC(14,3) GENERATED ALWAYS AS (controlado - sistema) STORED,
  usuario        TEXT,
  "usuarioId"    INT,
  "controladoAt" TIMESTAMPTZ,
  PRIMARY KEY ("controlId", codigo)
)
"""
_ddl_detalle_ok = False


def _asegurar_tabla_detalle(cur) -> None:
    global _ddl_detalle_ok
    if _ddl_detalle_ok:
        return
    with _ddl_lock:
        if not _ddl_detalle_ok:
            cur.execute(_DDL_DETALLE)
            cur.connection.commit()
            _ddl_detalle_ok = True


# Stock de los artículos del patrón que tienen stock ≠ 0 (índice por
# ArticuloPatron; a lo sumo unos miles de filas en los patrones más grandes).
_SQL_STOCK_PATRON = """
SELECT RTRIM(CodArticulo), StkReal
FROM StkFer_Articulos
WHERE ArticuloPatron = ? AND StkReal <> 0
"""


def finalizar_control(control_id: int, usuario_id: int | None, usuario_nombre: str | None) -> dict:
    """Cierra un control pendiente y guarda el detalle controlado vs sistema."""
    from psycopg2.extras import execute_values

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_tabla_conteo(cur)
        _asegurar_tabla_detalle(cur)
        # FOR UPDATE: dos PDA finalizando a la vez → el segundo espera y ya lo
        # encuentra cerrado (409).
        _asegurar_toma(cur)
        cur.execute(
            """SELECT "codigoPatron", "tomadoPor" FROM everwear.mostrador_control
               WHERE id = %s AND estado = 'pendiente' FOR UPDATE""",
            (control_id,),
        )
        fila = cur.fetchone()
        if not fila:
            conn.rollback()
            raise LookupError("El control ya fue finalizado o no existe")
        if fila[1] is not None and fila[1] != usuario_id:
            conn.rollback()
            raise LookupError("El patrón lo tiene tomado otro usuario")
        patron = fila[0]

        cur.execute(
            """
            SELECT k."codArticulo", k.cantidad, COALESCE(k."stockSistema", 0),
                   k."contadoPor", u.nombre, k."contadoAt"
            FROM everwear.mostrador_conteo k
            LEFT JOIN everwear.usuario u ON u.id = k."contadoPor"
            WHERE k."controlId" = %s
            """,
            (control_id,),
        )
        contados = cur.fetchall()
        if not contados:
            # Patrón sin nada que contar (todos sus artículos de baja y sin
            # stock; ej. mandado antes de que existiera el filtro, o dados de
            # baja durante el control): se QUITA de control — se borra el
            # pendiente, no queda como "controlado". Si tiene artículos, hay
            # que contar al menos uno.
            patron_arts = _articulos_de_patrones([patron]).get(patron, [])
            if patron_arts:
                conn.rollback()
                raise ValueError("No hay artículos contados en este control")
            cur.execute("DELETE FROM everwear.mostrador_control WHERE id = %s", (control_id,))
            conn.commit()
            return {
                "ok": True,
                "anulado": True,
                "controlId": control_id,
                "patron": patron,
                "contados": 0,
                "sinContarConStock": 0,
                "conDiferencia": 0,
                "cerradoAt": None,
            }

        mconn = get_connection("EVERWEAR")
        try:
            mcur = mconn.cursor()
            mcur.execute(_SQL_STOCK_PATRON, (patron,))
            con_stock = mcur.fetchall()
        finally:
            mconn.close()

        filas = [(control_id, cod, cant, sist, nom, uid, at)
                 for cod, cant, sist, uid, nom, at in contados]
        ya = {cod for cod, *_ in contados}
        sin_contar = 0
        for cod, stk in con_stock:
            cod = (cod or "").strip()
            if cod and cod not in ya:
                filas.append((control_id, cod, 0, stk, usuario_nombre, usuario_id, None))
                sin_contar += 1

        cur.execute('DELETE FROM everwear.mostrador_control_detalle WHERE "controlId" = %s', (control_id,))
        execute_values(
            cur,
            """INSERT INTO everwear.mostrador_control_detalle
               ("controlId", codigo, controlado, sistema, usuario, "usuarioId", "controladoAt")
               VALUES %s""",
            filas,
            page_size=1000,
        )
        cur.execute(
            """
            UPDATE everwear.mostrador_control
               SET estado = 'cerrado', "cerradoPor" = %s, "cerradoAt" = now(),
                   "archivoNombre" = %s
             WHERE id = %s
            RETURNING "cerradoAt"
            """,
            (usuario_id, f"Control patron {patron}.xlsx", control_id),
        )
        cerrado_at = cur.fetchone()[0]
        cur.execute(
            """SELECT count(*) FILTER (WHERE diferencia <> 0)
               FROM everwear.mostrador_control_detalle WHERE "controlId" = %s""",
            (control_id,),
        )
        con_dif = int(cur.fetchone()[0])
        conn.commit()
    finally:
        conn.close()

    # El nombre del Excel lleva la fecha de cierre (se arma recién acá).
    return {
        "ok": True,
        "controlId": control_id,
        "patron": patron,
        "contados": len(contados),
        "sinContarConStock": sin_contar,
        "conDiferencia": con_dif,
        "cerradoAt": cerrado_at.isoformat() if cerrado_at else None,
    }


# ── Detalle de un control cerrado (para el Excel) ─────────────────────────
def fetch_detalle_control(control_id: int) -> dict | None:
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        _asegurar_tabla_detalle(cur)
        cur.execute(
            """SELECT "codigoPatron", "cerradoAt" FROM everwear.mostrador_control
               WHERE id = %s AND estado = 'cerrado'""",
            (control_id,),
        )
        cab = cur.fetchone()
        if not cab:
            return None
        cur.execute(
            """
            SELECT codigo, controlado, sistema, diferencia, usuario, "controladoAt"
            FROM everwear.mostrador_control_detalle
            WHERE "controlId" = %s
            ORDER BY codigo
            """,
            (control_id,),
        )
        filas = cur.fetchall()
    finally:
        conn.close()
    patron, cerrado_at = cab
    info = maestro_magnus()["patrones"].get(patron, {})
    det_pat = info.get("detalle", "")
    # Detalle por artículo desde el cache de artículos del patrón (no se guarda).
    medidas = {a["cod"]: a["medida"] for a in _articulos_de_patrones([patron]).get(patron, [])}
    return {
        "controlId": control_id,
        "patron": patron,
        "detallePatron": det_pat,
        "cerradoAt": cerrado_at.isoformat() if cerrado_at else None,
        "filas": [
            {
                "codigo": cod,
                "detalle": f"{det_pat} {medidas.get(cod, '')}".strip(),
                "controlado": _num(ctl),
                "sistema": _num(sis),
                "diferencia": _num(dif),
                "usuario": usr or "",
                "controladoAt": at.isoformat() if at else None,
            }
            for cod, ctl, sis, dif, usr, at in filas
        ],
    }
