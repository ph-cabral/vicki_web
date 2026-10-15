"""
Módulo CALIDAD — controles de mesa en línea de tiempo vertical.

Por pedido: nodo "Toma" (el controlador toma el pedido = `asignadoEn` de
deposito.control_asignacion, UTC → local), un nodo por ítem y nodo "Cierre"
(Ven_PedImpresoCP.FechaControl/HoraControl). Duración de cada ítem = su hora −
hora del nodo anterior (el primero cuenta desde la toma).

Hora por ítem: Magnus NO la guarda. La fuente es deposito.control_item_log
(Postgres; una fila por cada cambio de cantidad de control — ver
sql/deposito_control_item_log.sql). Mientras esa tabla no exista o no tenga filas
del pedido, los ítems salen en el orden del renglón, sin hora ni duración, y el
resto de la línea de tiempo (toma → cierre, tiempo total) sigue funcionando.

Búsqueda por cliente: sobre deposito.control_asignacion (Postgres, ~cientos de
filas) → sin tocar Magnus; Magnus sólo se consulta por PK del pedido elegido.
"""
import time
from datetime import datetime, timedelta

from db import get_connection
from db_pg import get_pg_connection

_TZ_LOCAL = "America/Argentina/Buenos_Aires"
_MAGNUS_BASE = datetime(1800, 12, 28)


def _magnus_dt(fecha, hora) -> datetime | None:
    """Clarion: fecha = días desde 1800-12-28, hora = centésimas de segundo."""
    try:
        f = int(fecha or 0)
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    try:
        h = int(hora or 0)
    except (TypeError, ValueError):
        h = 0
    return _MAGNUS_BASE + timedelta(days=f, seconds=h / 100.0)


def _iso(v: datetime | None) -> str | None:
    return v.replace(microsecond=0).isoformat() if v is not None else None


def buscar_clientes(q: str, limite: int = 15) -> list[dict]:
    """Clientes con controles de mesa cuyo nombre contiene `q` (o código exacto)."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT "codCliente", MAX(cliente) AS cliente, COUNT(DISTINCT "nroPedido") AS controles,
                   MAX("asignadoEn" AT TIME ZONE 'UTC' AT TIME ZONE %(tz)s) AS ultimo
            FROM deposito.control_asignacion
            WHERE "codCliente" IS NOT NULL AND "asignadoEn" IS NOT NULL
              AND (cliente ILIKE %(like)s OR "codCliente"::text = %(q)s)
            GROUP BY "codCliente"
            ORDER BY MAX("asignadoEn") DESC
            LIMIT %(lim)s
            """,
            {"tz": _TZ_LOCAL, "like": f"%{q}%", "q": q, "lim": limite},
        )
        return [
            {"codCliente": int(c), "cliente": (n or "").strip(), "controles": int(k), "ultimo": _iso(u)}
            for c, n, k, u in cur.fetchall()
        ]
    finally:
        conn.close()


def fetch_controles_cliente(cod_cliente: int, dias: int = 90) -> dict:
    """Pedidos tomados en mesa por un cliente (más recientes primero)."""
    dias = max(1, min(int(dias), 365))
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT "nroPedido", "nroRemito", cliente, "asignadoA", "nroOperarioAsignado", lineas, unidades,
                   ("asignadoEn" AT TIME ZONE 'UTC' AT TIME ZONE %(tz)s) AS toma,
                   "cerradoEn"
            FROM deposito.control_asignacion
            WHERE "codCliente" = %(c)s AND "asignadoEn" IS NOT NULL
              AND "asignadoEn" > now() - make_interval(days => %(d)s)
            ORDER BY "asignadoEn" DESC
            LIMIT 200
            """,
            {"tz": _TZ_LOCAL, "c": cod_cliente, "d": dias},
        )
        filas = []
        cliente = None
        for ped, rem, cli, op, nop, lin, uni, toma, cierre in cur.fetchall():
            cliente = cliente or (cli or "").strip()
            seg = int((cierre - toma).total_seconds()) if toma and cierre and cierre >= toma else None
            filas.append({
                "nroPedido": int(ped), "nroRemito": int(rem or 0),
                "operario": (op or "").strip() or None,
                "items": int(lin) if lin is not None else None,
                "unidades": float(uni) if uni is not None else None,
                "toma": _iso(toma), "cierre": _iso(cierre), "segundos": seg,
            })
    finally:
        conn.close()
    return {"codCliente": cod_cliente, "cliente": cliente, "dias": dias, "controles": filas}


_SQL_RENGLONES = """
SELECT r.NroRenglon, RTRIM(r.CodArticu), r.CantidadPedida, r.CantidadCumplida, r.Estado,
       RTRIM(a.DetallePatron), RTRIM(a.DetalleMedida)
FROM dbo.VenFer_PedidoReng r
LEFT JOIN dbo.StkFer_Articulos a ON a.CodArticulo = r.CodArticu
WHERE r.NroMovVenta = ?
ORDER BY r.NroRenglon
"""

_SQL_CONTROL = """
SELECT TOP 1 CodControlador1, CodControlador2, FechaControl, HoraControl
FROM dbo.Ven_PedImpresoCP
WHERE NroMovVenta = ? AND CodCentroPrep <> 2 AND (CodControlador1 > 0 OR CodControlador2 > 0)
ORDER BY CodCentroPrep
"""

_SQL_LOG = """
SELECT "nroRenglon", codigo, origen, (registrado AT TIME ZONE 'UTC' AT TIME ZONE %(tz)s)
FROM deposito.control_item_log
WHERE "nroPedido" = %(p)s
ORDER BY registrado
"""

# ── Captura desde el widget de Mesa de Control ───────────────────────────────
# El widget (PC de la mesa) escucha el teclado, deja pasar SOLO los códigos que
# coinciden con un artículo del pedido asignado (escaneados = ráfaga rápida,
# manuales = tipeados) y los manda acá. Magnus no guarda nada por ítem.
_DDL_LOG = (
    """CREATE TABLE IF NOT EXISTS deposito.control_item_log (
        id bigserial PRIMARY KEY, "nroPedido" integer NOT NULL, "nroRenglon" integer NOT NULL,
        cantidad numeric(13,3), registrado timestamp NOT NULL DEFAULT now(), usuario smallint)""",
    "ALTER TABLE deposito.control_item_log ADD COLUMN IF NOT EXISTS codigo text",
    "ALTER TABLE deposito.control_item_log ADD COLUMN IF NOT EXISTS origen text",
    "ALTER TABLE deposito.control_item_log ADD COLUMN IF NOT EXISTS eid text",
    """CREATE UNIQUE INDEX IF NOT EXISTS ux_control_item_log_eid
       ON deposito.control_item_log ("nroPedido", eid) WHERE eid IS NOT NULL""",
    """CREATE INDEX IF NOT EXISTS ix_control_item_log_pedido
       ON deposito.control_item_log ("nroPedido", registrado)""",
)
_log_ddl_ok = False


def _asegurar_log() -> None:
    """DDL idempotente una vez por proceso (también está en
    sql/deposito_control_item_log.sql). Sin permiso de DDL sigue: la tabla la
    crea el .sql."""
    global _log_ddl_ok
    if _log_ddl_ok:
        return
    try:
        conn = get_pg_connection()
        try:
            cur = conn.cursor()
            for ddl in _DDL_LOG:
                cur.execute(ddl)
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        pass
    _log_ddl_ok = True


_SQL_RENG_PEDIDO = """
SELECT NroRenglon, RTRIM(CodArticu)
FROM dbo.VenFer_PedidoReng
WHERE NroMovVenta = ? AND NOT (Estado = 4 AND ISNULL(CantidadCumplida, 0) = 0)
ORDER BY NroRenglon
"""
_RENG_CACHE: dict[int, tuple[float, list[tuple[int, str]]]] = {}


def _renglones_pedido(nro_pedido: int) -> list[tuple[int, str]]:
    """[(NroRenglon, CodArticu)] del pedido (seek por NroMovVenta), cache 10 min."""
    ahora = time.time()
    hit = _RENG_CACHE.get(nro_pedido)
    if hit and ahora - hit[0] < 600:
        return hit[1]
    mc = get_connection("EVERWEAR")
    try:
        cur = mc.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(_SQL_RENG_PEDIDO, (nro_pedido,))
        filas = [(int(r), (c or "").strip()) for r, c in cur.fetchall()]
    finally:
        mc.close()
    if len(_RENG_CACHE) > 500:
        _RENG_CACHE.clear()
    _RENG_CACHE[nro_pedido] = (ahora, filas)
    return filas


def registrar_control_items(nro_pedido: int, nro_operario: int | None, eventos: list[dict]) -> dict:
    """Guarda en deposito.control_item_log cada código reconocido por el widget.
    eventos: [{codigo, haceMs, origen('escaneo'|'manual'), eid}]. La hora se
    calcula acá (ahora − haceMs) para no depender del reloj de la PC; `eid`
    hace idempotente el reintento del widget. Si el artículo tiene más de un
    renglón en el pedido, reparte por turno."""
    eventos = [e for e in (eventos or [])[:200] if (e.get("codigo") or "").strip()]
    if not eventos:
        return {"guardados": 0}
    _asegurar_log()
    por_cod: dict[str, list[int]] = {}
    try:
        for reng, cod in _renglones_pedido(nro_pedido):
            por_cod.setdefault(cod.upper(), []).append(reng)
    except Exception:  # noqa: BLE001 — Magnus caído: se guarda igual con renglón 0
        por_cod = {}
    conn = get_pg_connection()
    guardados = 0
    try:
        cur = conn.cursor()
        for e in eventos:
            cod = e["codigo"].strip()[:30]
            lista = por_cod.get(cod.upper(), [])
            reng = 0
            if lista:
                reng = lista[0]
                if len(lista) > 1:
                    cur.execute(
                        'SELECT count(*) FROM deposito.control_item_log WHERE "nroPedido" = %s AND codigo = %s',
                        (nro_pedido, cod),
                    )
                    reng = lista[int(cur.fetchone()[0]) % len(lista)]
            origen = "manual" if e.get("origen") == "manual" else "escaneo"
            hace = max(0.0, min(float(e.get("haceMs") or 0), 6 * 3600 * 1000)) / 1000.0
            cur.execute(
                """
                INSERT INTO deposito.control_item_log
                    ("nroPedido", "nroRenglon", registrado, usuario, codigo, origen, eid)
                VALUES (%s, %s, (now() AT TIME ZONE 'UTC') - make_interval(secs => %s), %s, %s, %s, %s)
                ON CONFLICT ("nroPedido", eid) WHERE eid IS NOT NULL DO NOTHING
                """,
                (nro_pedido, reng, hace, nro_operario, cod, origen, (e.get("eid") or None)),
            )
            guardados += cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return {"guardados": guardados}


def _eventos_por_item(nro_pedido: int) -> tuple[dict[int, dict], dict[str, dict]]:
    """({nroRenglon: ev}, {CODIGO: ev}) desde deposito.control_item_log. ev =
    {hora, cambios, origen} con la ÚLTIMA carga (hora de control final). El
    segundo dict es para eventos sin renglón resuelto (nroRenglon = 0). ({}, {})
    si la tabla no existe o no hay filas del pedido."""
    try:
        conn = get_pg_connection()
    except Exception:
        return {}, {}
    try:
        cur = conn.cursor()
        cur.execute(_SQL_LOG, {"tz": _TZ_LOCAL, "p": nro_pedido})
        filas = cur.fetchall()
    except Exception:
        return {}, {}
    finally:
        conn.close()
    por_reng: dict[int, dict] = {}
    por_cod: dict[str, dict] = {}
    for reng, cod, origen, reg in filas:
        if int(reng) > 0:
            d, k = por_reng, int(reng)
        elif cod:
            d, k = por_cod, cod.strip().upper()
        else:
            continue
        e = d.setdefault(k, {"hora": None, "cambios": 0, "origen": None})
        e["hora"] = reg
        e["origen"] = origen
        e["cambios"] += 1
    return por_reng, por_cod


def fetch_control_pedido(nro_pedido: int) -> dict:
    """Línea de tiempo vertical de un pedido controlado en mesa."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT "nroPedido", "codCliente", cliente, "asignadoA",
                   ("asignadoEn" AT TIME ZONE 'UTC' AT TIME ZONE %(tz)s), "cerradoEn", lineas
            FROM deposito.control_asignacion
            WHERE "nroPedido" = %(p)s AND "asignadoEn" IS NOT NULL
            ORDER BY id DESC LIMIT 1
            """,
            {"tz": _TZ_LOCAL, "p": nro_pedido},
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {"nroPedido": nro_pedido, "encontrado": False}
    _p, cod_cli, cliente, operario, toma, cerrado_pg, _lin = row

    mc = get_connection("EVERWEAR")
    try:
        cur = mc.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(_SQL_RENGLONES, (nro_pedido,))
        renglones = cur.fetchall()
        cur.execute(_SQL_CONTROL, (nro_pedido,))
        ctrl = cur.fetchone()
    finally:
        mc.close()
    eventos, eventos_cod = _eventos_por_item(nro_pedido)

    cierre = _magnus_dt(ctrl[2], ctrl[3]) if ctrl else None
    cierre = cierre or cerrado_pg

    items = []
    for reng, cod, c_ped, c_cum, estado, patron, medida in renglones:
        if estado == 4 and not c_cum:
            continue          # renglón cancelado, no se controla
        ev = eventos.get(int(reng)) or eventos_cod.get((cod or "").strip().upper())
        items.append({
            "nroRenglon": int(reng), "codArticulo": cod,
            "descripcion": " ".join(x for x in ((patron or "").strip(), (medida or "").strip()) if x) or None,
            "cantPedida": float(c_ped or 0), "cantControlada": float(c_cum or 0),
            "hora": ev["hora"] if ev else None, "cambios": ev["cambios"] if ev else 0,
            "origen": ev["origen"] if ev else None,
        })
    con_hora = any(i["hora"] for i in items)
    resumen = {
        "escaneados": sum(1 for i in items if i["hora"] and i["origen"] == "escaneo"),
        "manuales": sum(1 for i in items if i["hora"] and i["origen"] == "manual"),
        "sinCaptura": sum(1 for i in items if not i["hora"]),
    }
    if con_hora:
        items.sort(key=lambda i: (i["hora"] is None, i["hora"] or datetime.max, i["nroRenglon"]))

    # Duración de cada ítem: desde el nodo anterior (el primero, desde la toma).
    previo = toma
    for i in items:
        if i["hora"] and previo:
            seg = (i["hora"] - previo).total_seconds()
            i["segundos"] = int(seg) if seg >= 0 else None
            previo = i["hora"]
        else:
            i["segundos"] = None
        i["hora"] = _iso(i["hora"])

    total = int((cierre - toma).total_seconds()) if cierre and toma and cierre >= toma else None
    return {
        "encontrado": True,
        "nroPedido": nro_pedido,
        "codCliente": int(cod_cli) if cod_cli is not None else None,
        "cliente": (cliente or "").strip(),
        "operario": (operario or "").strip() or None,
        "toma": _iso(toma), "cierre": _iso(cierre), "segundosTotal": total,
        "items": items,
        "horaPorItem": con_hora,
        "resumen": resumen,
        "aviso": ("Sin hora por ítem: Magnus no la guarda; la captura la hace el widget de Mesa de Control "
                  "(deposito.control_item_log) y este pedido no tiene eventos." if not con_hora else
                  (f"{resumen['sinCaptura']} ítem(s) sin captura (buscados por descripción o no reconocidos)."
                   if resumen["sinCaptura"] else None)),
    }
