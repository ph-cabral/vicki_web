"""
Módulo CALIDAD — controles de mesa en línea de tiempo vertical.

Por pedido: nodo "Toma" (el controlador toma el pedido = `asignadoEn` de
deposito.control_asignacion, UTC → local), un nodo por ítem y nodo "Cierre"
(Ven_PedImpresoCP.FechaControl/HoraControl). Duración de cada ítem = su hora −
hora del nodo anterior (el primero cuenta desde la toma).

Hora por ítem: Magnus NO la guarda. La fuente es dbo.VICKI_ControlItemLog (una
fila por cada cambio de cantidad de control, cargada por un trigger — ver
sql/magnus_control_item_log.sql). Mientras esa tabla no exista o no tenga filas
del pedido, los ítems salen en el orden del renglón, sin hora ni duración, y el
resto de la línea de tiempo (toma → cierre, tiempo total) sigue funcionando.

Búsqueda por cliente: sobre deposito.control_asignacion (Postgres, ~cientos de
filas) → sin tocar Magnus; Magnus sólo se consulta por PK del pedido elegido.
"""
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
SELECT NroRenglon, Registrado, Cantidad
FROM dbo.VICKI_ControlItemLog
WHERE NroMovVenta = ?
ORDER BY Registrado
"""


def _eventos_por_item(cur, nro_pedido: int) -> dict[int, dict]:
    """{nroRenglon: {hora, cambios}} desde dbo.VICKI_ControlItemLog. {} si la
    tabla todavía no existe (trigger sin instalar)."""
    try:
        cur.execute(_SQL_LOG, (nro_pedido,))
        filas = cur.fetchall()
    except Exception:
        return {}
    out: dict[int, dict] = {}
    for reng, reg, _cant in filas:
        e = out.setdefault(int(reng), {"hora": None, "cambios": 0})
        e["hora"] = reg          # última carga del renglón = hora de control final
        e["cambios"] += 1
    return out


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
        eventos = _eventos_por_item(cur, nro_pedido)
    finally:
        mc.close()

    cierre = _magnus_dt(ctrl[2], ctrl[3]) if ctrl else None
    cierre = cierre or cerrado_pg

    items = []
    for reng, cod, c_ped, c_cum, estado, patron, medida in renglones:
        if estado == 4 and not c_cum:
            continue          # renglón cancelado, no se controla
        ev = eventos.get(int(reng))
        items.append({
            "nroRenglon": int(reng), "codArticulo": cod,
            "descripcion": " ".join(x for x in ((patron or "").strip(), (medida or "").strip()) if x) or None,
            "cantPedida": float(c_ped or 0), "cantControlada": float(c_cum or 0),
            "hora": ev["hora"] if ev else None, "cambios": ev["cambios"] if ev else 0,
        })
    con_hora = any(i["hora"] for i in items)
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
        "aviso": None if con_hora else
                 "Sin hora por ítem: Magnus no la guarda; se completa al instalar la captura (sql/magnus_control_item_log.sql).",
    }
