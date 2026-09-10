"""
Premios de depósito — productividad y errores por persona, para la vista
/rrhh/premios. Un solo endpoint (GET /rrhh/premios?mes=YYYY-MM) que devuelve
las dos tablas ya agregadas:

  · preparadores → ítems recolectados (WMS) + errores que se le imputan.
    Cantidad: OT de Picking (Codot.CodotProcesoNegocio = 4, OTEstado 2/3/4)
    del mes por OTFechaHoraEjecucion, contando los renglones recolectados
    (OTItemTipo = 1 y OTItemCantCumplida > 0) — mismo criterio que
    "CANT. ITEM RECOLECTADOS" de SQL_WMS_TODOS en deposito.py, así el número
    cierra con el tab Picking de /deposito.
    Errores: TODAS las filas de deposito.errores_mesa del mes cuyo Operario
    (`nombreArmador`, resuelto contra WMS al cargar el error) sea esa persona,
    sin importar el origen del widget (mesa o calidad): es el error que
    cometió, lo haya detectado la mesa o Calidad.

  · mesa → renglones controlados (EVERWEAR) + errores que se le escaparon.
    Cantidad: mismo criterio de crédito que fetch_mesa_control en
    mesa_control.py (Ven_PedImpresoCP × venfer_pedidoReng por FechaControl,
    1 crédito por código DISTINTO de CodControlador1/2 en la fila, para no
    duplicar el caso normal cod1 == cod2), pero agregado EN LA BASE: acá sólo
    hacen falta los totales por controlador, no las filas.
    Errores: filas origen='calidad' imputadas al Controlador real del pedido
    (`nombreControladorReal`, Magnus Ven_PedImpresoCP.CodControlador1/2) — el
    error que la mesa dejó pasar y detectó Calidad después.

Los dos nombres salen de fuentes distintas (WMS.Personal para el preparador,
Magnus Gen_Usuarios para el controlador) pero cada tabla se cruza contra su
propia fuente, así que el join es directo; igual se normaliza (mayúsculas y
espacios colapsados) antes de cruzar, por las diferencias de tipeo.

Filas sin actividad pero con errores en el mes entran igual (cantidad 0): el
error tiene que verse. El recorte de gerentes/no-operativos NO se hace acá:
lo aplica el front con esFilaProductiva() de lib/deposito/parseDeposito.ts,
que es la única fuente de verdad de esa regla.
"""
from calendar import monthrange
from datetime import datetime

from db import get_connection
from db_pg import get_pg_connection

# ── WMS: ítems recolectados por preparador ────────────────────────────────────
# El conteo de renglones va por CROSS APPLY correlacionado (seek por OTId, una
# vez por OT del mes) y NO por un GROUP BY de toda OTItem, que obligaría a
# recorrer la tabla entera — mismo criterio que SQL_PICK_OTS en deposito.py.
SQL_PREPARADORES = """
SELECT
    P.PersonalNombre           AS operario,
    SUM(x.recolectados)        AS items
FROM OT
INNER JOIN Codot
        ON Codot.CodotCodigo = OT.CodotCodigo
       AND Codot.CodotProcesoNegocio = 4
LEFT JOIN Personal P ON P.PersonalId = OT.OTUsuarioGUID_Repositor
CROSS APPLY (
    SELECT COUNT(*) AS recolectados
    FROM OTItem it
    WHERE it.OTId = OT.OTId
      AND it.OTItemTipo = 1
      AND it.OTItemCantCumplida > 0
) x
WHERE OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <  ?
GROUP BY P.PersonalNombre
"""

# ── EVERWEAR: renglones controlados por controlador ───────────────────────────
# El VALUES + DISTINCT reproduce el dedupe de fetch_mesa_control (cod1 == cod2
# es el caso normal → 1 solo crédito; 2 códigos distintos → 1 a cada uno) sin
# traerse una fila por renglón a Python.
SQL_MESA = """
SELECT c.cod AS codigo, COUNT(*) AS renglones
FROM dbo.Ven_PedImpresoCP ped
JOIN dbo.venfer_pedidoReng reng
  ON reng.NroMovVenta   = ped.NroMovVenta
 AND reng.CodCentroPrep = ped.CodCentroPrep
CROSS APPLY (
    SELECT DISTINCT v.cod
    FROM (VALUES (ped.CodControlador1), (ped.CodControlador2)) v(cod)
    WHERE v.cod > 0
) c
WHERE ped.FechaControl BETWEEN dbo.FECHA_SQL2Cla(?) AND dbo.FECHA_SQL2Cla(?)
GROUP BY c.cod
"""

SQL_USUARIOS = "SELECT Numero, Nombre FROM dbo.Gen_Usuarios"

# ── Postgres: errores del mes, ya agrupados ───────────────────────────────────
SQL_ERRORES_PREPARADOR = """
SELECT btrim("nombreArmador") AS nombre, COUNT(*) AS errores
FROM deposito.errores_mesa
WHERE fecha >= %s AND fecha < %s
  AND "nombreArmador" IS NOT NULL AND btrim("nombreArmador") <> ''
GROUP BY 1
"""

SQL_ERRORES_MESA = """
SELECT btrim("nombreControladorReal") AS nombre, COUNT(*) AS errores
FROM deposito.errores_mesa
WHERE fecha >= %s AND fecha < %s
  AND origen = 'calidad'
  AND "nombreControladorReal" IS NOT NULL AND btrim("nombreControladorReal") <> ''
GROUP BY 1
"""


def _rango_mes(mes: str) -> tuple[datetime, datetime, datetime]:
    """mes='YYYY-MM' -> (primer día 00:00, último instante del mes, primer día
    del mes siguiente). El corte abierto (`< siguiente`) es el que usan las
    consultas por datetime; el cerrado, la de FechaControl (entero Clarion,
    BETWEEN). Si el mes es el actual, el cierre se recorta a AHORA."""
    anio, mm = (int(x) for x in mes.split("-"))
    desde = datetime(anio, mm, 1)
    siguiente = datetime(anio + 1, 1, 1) if mm == 12 else datetime(anio, mm + 1, 1)
    hasta = datetime(anio, mm, monthrange(anio, mm)[1], 23, 59, 59)
    ahora = datetime.now()
    if hasta > ahora:
        hasta = ahora
        siguiente = min(siguiente, ahora)
    return desde, hasta, siguiente


def _clave(nombre: str) -> str:
    return " ".join(str(nombre or "").upper().split())


def _errores_del_mes(desde: datetime, siguiente: datetime) -> tuple[dict, dict]:
    """Los dos conteos de errores en una sola conexión a Postgres."""
    prep: dict[str, int] = {}
    mesa: dict[str, int] = {}
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        for sql, destino in ((SQL_ERRORES_PREPARADOR, prep), (SQL_ERRORES_MESA, mesa)):
            cur.execute(sql, (desde.date(), siguiente.date()))
            for nombre, errores in cur.fetchall():
                k = _clave(nombre)
                if k:
                    destino[k] = destino.get(k, 0) + int(errores or 0)
    finally:
        conn.close()
    return prep, mesa


def _preparadores(desde: datetime, siguiente: datetime) -> dict[str, dict]:
    filas: dict[str, dict] = {}
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_PREPARADORES, (desde, siguiente))
        for operario, items in cur.fetchall():
            nombre = str(operario or "").strip()
            if not nombre:
                continue
            filas[_clave(nombre)] = {"operario": nombre, "items": int(items or 0), "errores": 0}
    finally:
        conn.close()
    return filas


def _mesa(desde: datetime, hasta: datetime) -> dict[str, dict]:
    filas: dict[str, dict] = {}
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_USUARIOS)
        nombres = {int(r[0]): str(r[1]).strip() for r in cur.fetchall() if r[0] is not None}
        cur.execute(SQL_MESA, (desde, hasta))
        for codigo, renglones in cur.fetchall():
            cod = int(codigo)
            nombre = nombres.get(cod) or f"Controlador {cod}"
            filas[_clave(nombre)] = {
                "controlador": nombre,
                "codigo": cod,
                "renglones": int(renglones or 0),
                "errores": 0,
            }
    finally:
        conn.close()
    return filas


def fetch_premios(mes: str) -> dict:
    """Las dos tablas de /rrhh/premios para un mes 'YYYY-MM'."""
    desde, hasta, siguiente = _rango_mes(mes)
    if desde > hasta:  # mes futuro: no hay nada que consultar
        return {"mes": mes, "preparadores": [], "mesa": []}

    err_prep, err_mesa = _errores_del_mes(desde, siguiente)
    preparadores = _preparadores(desde, siguiente)
    mesa = _mesa(desde, hasta)

    # Los errores mandan: quien tiene errores del mes entra aunque no registre
    # actividad (cantidad 0), así el número nunca queda escondido.
    for clave, errores in err_prep.items():
        fila = preparadores.get(clave)
        if fila is None:
            preparadores[clave] = {"operario": clave.title(), "items": 0, "errores": errores}
        else:
            fila["errores"] = errores
    for clave, errores in err_mesa.items():
        fila = mesa.get(clave)
        if fila is None:
            mesa[clave] = {"controlador": clave.title(), "codigo": None, "renglones": 0, "errores": errores}
        else:
            fila["errores"] = errores

    return {
        "mes": mes,
        "preparadores": sorted(preparadores.values(), key=lambda x: -x["items"]),
        "mesa": sorted(mesa.values(), key=lambda x: -x["renglones"]),
    }
