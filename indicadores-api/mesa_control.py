"""
Mesa de Control — renglones (items) controlados por Controlador (EVERWEAR,
SOLO LECTURA), para la pestaña "Mesas de Control" de /deposito.

Origen: contaduría pidió reproducir el reporte "CONTROL DE PRODUCTIVIDAD POR
CONTROLADOR" (ver control_extraccion.py, script que corría a mano en
pc-0067) llamando al SP EVERWEAR.dbo.RPT_V325_ProductividadPorControlador.
CONFIRMADO (26-jun/2026, ver fetch_mesa_control_sp_definicion +
fetch_mesa_control_tablas_diag) que ese SP duplica: hace JOIN de
Ven_PedImpresoCP (1 fila/pedido) contra venfer_pedidoReng (1 fila/renglón)
SIN deduplicar, y además UNION ALL de CodControlador1 + CodControlador2 —
si un pedido tiene doble control, el total se cuenta 2 veces y NO reconcilia
contra lo facturado/preparado.

`fetch_mesa_control()` (la función que usa la API) YA NO llama al SP: hace
una consulta directa a Ven_PedImpresoCP + venfer_pedidoReng contando cada
renglón (NroMovVenta+NroRenglon) UNA sola vez para el total, y por separado
el desglose por controlador (que sí puede sumar más que el total si hubo
doble control — es crédito de productividad, no el total real).

Además del total por mes, `fetch_mesa_control()` desglosa el mismo total
"exacto" (renglones únicos) por hora del día, por día calendario y por
semana (lunes a lunes) — confirmado por muestra real de datos (magnus__query,
2026-09-12) que Ven_PedImpresoCP.FechaControl es un entero Clarion (días
desde 1800-12-28, igual convención que el resto de Magnus — ver _BASE_PEDIDO
en deposito.py) y HoraControl es un entero Clarion de centésimas de segundo
desde medianoche (valor/100 = segundos; rango 0..8639999). Ver
`_fecha_desde_dias` / `_hora_desde_centesimas`.

Las funciones basadas en el SP (`_exec_sp`, `_detectar_columnas`,
`fetch_mesa_control_diag`) se dejan sólo como referencia/diagnóstico.
────────────────────────────────────────────────────────────────────────────
"""
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal

from db import get_connection

_BASE_CLARION = date(1800, 12, 28)  # misma época que _BASE_PEDIDO en deposito.py


def _fecha_desde_dias(dias) -> date | None:
    """FechaControl (int Clarion, días desde 1800-12-28) -> date."""
    try:
        d = int(dias)
    except (TypeError, ValueError):
        return None
    if d <= 0:
        return None
    try:
        return _BASE_CLARION + timedelta(days=d)
    except (OverflowError, ValueError):
        return None


def _hora_desde_centesimas(valor) -> int | None:
    """HoraControl (int Clarion, centésimas de segundo desde medianoche) ->
    hora 0-23, o None si no hay hora registrada (valor <= 0 — no visto en la
    práctica: 0 filas sin hora en una muestra de 2446 renglones controlados
    recientes, pero se contempla por las dudas)."""
    try:
        v = int(valor)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    return (v // 100 // 3600) % 24


SP_NOMBRE = "dbo.RPT_V325_ProductividadPorControlador"
CANTIDAD_COL = "CANTIDAD ITEMS CONTROLADOS"  # confirmada (control_extraccion.py)


def _safe(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "ignore")
    return value


def _rows(cur) -> tuple[list[str], list[list]]:
    cols = [c[0] for c in cur.description]
    return cols, [[_safe(v) for v in row] for row in cur.fetchall()]


def _rango_mes(mes: str) -> tuple[datetime, datetime]:
    """mes='YYYY-MM' -> (primer día 00:00:00, último día 23:59:59).
    Si el mes es el actual (o futuro), el 'hasta' se recorta a AHORA."""
    anio, mm = (int(x) for x in mes.split("-"))
    d = datetime(anio, mm, 1, 0, 0, 0)
    ultimo_dia = monthrange(anio, mm)[1]
    h = datetime(anio, mm, ultimo_dia, 23, 59, 59)
    ahora = datetime.now()
    if h > ahora:
        h = ahora
    return d, h


def _exec_sp(cur, desde: datetime, hasta: datetime) -> None:
    cur.execute(
        f"EXEC {SP_NOMBRE} "
        "@MOD_DFecha=?, @MOD_HFecha=?, "
        "@MOD_DCentroPreparacion=NULL, @MOD_HCentroPreparacion=NULL, "
        "@MOD_DControlador=NULL, @MOD_HControlador=NULL",
        (desde.strftime("%Y-%m-%d %H:%M:%S"), hasta.strftime("%Y-%m-%d %H:%M:%S")),
    )


def _detectar_columnas(cols: list[str]) -> dict:
    """Ubica por nombre las columnas de cantidad / centro / controlador
    (nombre y código). Sólo CANTIDAD_COL está confirmada; el resto es
    best-effort — confirmar con /deposito/mesa-control/diag."""
    up = {c: c.upper() for c in cols}
    cantidad = next((c for c in cols if up[c] == CANTIDAD_COL.upper()), None) \
        or next((c for c in cols if "CANTIDAD" in up[c]), None)
    centro = next((c for c in cols if "CENTRO" in up[c]), None)
    restantes = [c for c in cols if c not in (cantidad, centro)]
    nombre = next((c for c in restantes if "NOMBRE" in up[c]), None) \
        or next((c for c in restantes if "CONTROLADOR" in up[c]), None) \
        or (restantes[0] if restantes else None)
    codigo = next(
        (c for c in restantes if c != nombre and ("COD" in up[c] or "CONTROLADOR" in up[c])),
        None,
    )
    return {"cantidad": cantidad, "centro": centro, "nombre": nombre, "codigo": codigo}


# ── Conteo (reemplaza al SP) ──────────────────────────────────────────────────
# El SP RPT_V325_ProductividadPorControlador (ver fetch_mesa_control_sp_definicion)
# hace JOIN de Ven_PedImpresoCP (1 fila por pedido) contra venfer_pedidoReng
# (1 fila por renglón/línea) y UNION ALL de CodControlador1 + CodControlador2
# en un solo total ciego — no se puede separar "renglones distintos" de
# "créditos por controlador" a partir de su salida. Acá se reconstruye desde
# las tablas fuente (confirmadas con /deposito/mesa-control/tablas-diag):
#   Ven_PedImpresoCP:   NroMovVenta, CodCentroPrep, CodControlador1/2, FechaControl (int Clarion)
#   venfer_pedidoReng:  NroMovVenta, NroRenglon, CodCentroPrep, CodArticu, ...
#
# OJO: Ven_PedImpresoCP puede tener MÁS DE UNA fila por (NroMovVenta,
# CodCentroPrep) — recontrol/reimpresión del mismo pedido. Un SELECT DISTINCT
# sobre el join colapsaba esos recontroles y daba un total MENOR al que
# contaduría ya venía llevando a mano por controlador (confirmado 2026-07:
# planilla propia vs. esta vista, ~200-300 de diferencia por controlador y
# mes). Por eso acá NO se deduplica al armar las filas: cada fila del join es
# un control real y se acredita al controlador (igual que la planilla de
# contaduría). Sólo se deduplica para `por_mes`/`total_general` (por
# NroMovVenta+NroRenglon), que es el número pensado para reconciliar contra
# lo facturado/preparado.
#
# CONFIRMADO 2026-07-13 (muestra de Ven_PedImpresoCP): un pedido NO
# se controla 2 veces — lo controla y cierra UNA sola persona. CodControlador1
# y CodControlador2 vienen SIEMPRE con el mismo valor (el sistema duplica el
# mismo código en los 2 campos; FechaCierre/HoraCierre = FechaControl/
# HoraControl, mismo momento). Antes se creditaba cod1 Y cod2 por separado,
# lo que DUPLICABA cada control al controlador (por_controlador sumaba ~2x
# total_general). Fix: por fila se arma un set de códigos {cod1, cod2}
# (dedupe) y se acredita 1 vez por código distinto — si algún día aparece un
# caso real de 2 controladores distintos en la misma fila, se sigue
# acreditando a los 2 (no se pierde ese caso), pero el duplicado artificial
# (cod1==cod2, el caso normal) ya no infla el total.
SQL_RENGLONES_CONTROLADOS = """
SELECT
    reng.NroMovVenta, reng.NroRenglon,
    ped.CodControlador1, ped.CodControlador2,
    ped.FechaControl, ped.HoraControl
FROM dbo.Ven_PedImpresoCP ped
JOIN dbo.venfer_pedidoReng reng
  ON ped.NroMovVenta   = reng.NroMovVenta
 AND ped.CodCentroPrep = reng.CodCentroPrep
WHERE (ped.CodControlador1 > 0 OR ped.CodControlador2 > 0)
  AND ped.FechaControl BETWEEN dbo.FECHA_SQL2Cla(?) AND dbo.FECHA_SQL2Cla(?)
"""

SQL_USUARIOS = "SELECT Numero, Nombre FROM dbo.Gen_Usuarios"


def _nombres_usuarios(conn) -> dict[int, str]:
    cur = conn.cursor()
    cur.execute(SQL_USUARIOS)
    return {int(r[0]): str(r[1]).strip() for r in cur.fetchall() if r[0] is not None}


def fetch_mesa_control(meses: list[str]) -> dict:
    """Renglones (items) controlados por mes + por controlador + por hora del
    día / día / semana — consulta directa a las tablas fuente (no al SP).
    `meses` = ['YYYY-MM', ...]. Devuelve:
      · por_mes         = [{mes, total}]  (renglones DISTINTOS del mes, sin
        duplicar por doble controlador ni por recontroles del mismo renglón —
        pensado para reconciliar contra lo facturado/preparado)
      · por_controlador = [{controlador, codigo, por_mes: {mes: cantidad}, total}]
        (créditos de productividad: CADA control cuenta, incluye recontroles
        del mismo renglón — por eso puede sumar más que total_general en ese
        caso puntual; pero YA NO duplica por CodControlador1==CodControlador2,
        que es el caso normal — ver comentario arriba de SQL_RENGLONES_CONTROLADOS)
      · por_dia    = [{fecha: 'YYYY-MM-DD', total}]   (mismo criterio "renglón
        único" que por_mes; la suma da total_general)
      · por_semana = [{semana: 'YYYY-MM-DD' (lunes de esa semana), total}]
        (por_dia agrupado de lunes a domingo)
      · por_hora   = [{hora: 0..23, total}]  (distribución de esos mismos
        renglones únicos según la hora del día en que se controlaron, sumada
        sobre todos los meses elegidos — para ver en qué franja horaria se
        concentra el control)
    Cuando un renglón tiene más de un evento de control en el rango (recontrol/
    reimpresión, ver SQL_RECONTROLES_DIAG), se lo ubica en la fecha/hora del
    evento MÁS RECIENTE (determinístico, no depende del orden de filas del
    driver) — igual criterio en por_dia/por_semana/por_hora.
    Solo lectura sobre EVERWEAR."""
    meses = sorted(set(m.strip() for m in meses if m.strip()))
    if not meses:
        return {
            "meses": [], "por_mes": [], "por_controlador": [],
            "por_dia": [], "por_semana": [], "por_hora": [],
            "total_general": 0,
        }

    por_mes: dict[str, int] = {m: 0 for m in meses}
    por_ctrl: dict[int, dict] = {}
    por_dia: dict[str, int] = {}
    por_hora: dict[int, int] = {h: 0 for h in range(24)}

    conn = get_connection("EVERWEAR")
    try:
        nombres = _nombres_usuarios(conn)
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        for mes in meses:
            d, h = _rango_mes(mes)
            if d > h:
                continue  # mes futuro, sin datos posibles
            cur.execute(SQL_RENGLONES_CONTROLADOS, (d, h))
            filas = cur.fetchall()

            renglones_unicos: set[tuple] = set()
            evento_por_renglon: dict[tuple, tuple[str, int]] = {}
            for nro, nro_reng, cod1, cod2, fecha_ctrl, hora_ctrl in filas:
                clave = (nro, nro_reng)
                renglones_unicos.add(clave)

                fecha_evt = _fecha_desde_dias(fecha_ctrl)
                if fecha_evt is not None:
                    hora_evt = _hora_desde_centesimas(hora_ctrl)
                    candidato = (fecha_evt.isoformat(), hora_evt if hora_evt is not None else -1)
                    previo = evento_por_renglon.get(clave)
                    if previo is None or candidato > previo:
                        evento_por_renglon[clave] = candidato

                # dedupe: cod1==cod2 en el caso normal (1 sola persona
                # controló) -> 1 solo crédito. Si algún día son distintos
                # (control genuino de 2 personas), se acredita a las 2.
                codigos = {int(c) for c in (cod1, cod2) if c and c > 0}
                for codigo in codigos:
                    entry = por_ctrl.setdefault(
                        codigo,
                        {
                            "controlador": nombres.get(codigo, f"Controlador {codigo}"),
                            "codigo": codigo,
                            "por_mes": {},
                            "total": 0,
                        },
                    )
                    entry["por_mes"][mes] = entry["por_mes"].get(mes, 0) + 1
                    entry["total"] += 1
            por_mes[mes] = len(renglones_unicos)

            for fecha_str, hora_num in evento_por_renglon.values():
                por_dia[fecha_str] = por_dia.get(fecha_str, 0) + 1
                if hora_num >= 0:
                    por_hora[hora_num] = por_hora.get(hora_num, 0) + 1
    finally:
        conn.close()

    controladores = sorted(por_ctrl.values(), key=lambda x: -x["total"])

    dias_ordenados = sorted(por_dia.keys())
    por_semana: dict[str, int] = {}
    for fecha_str in dias_ordenados:
        lunes = date.fromisoformat(fecha_str)
        lunes = lunes - timedelta(days=lunes.weekday())
        clave = lunes.isoformat()
        por_semana[clave] = por_semana.get(clave, 0) + por_dia[fecha_str]

    return {
        "meses": meses,
        "por_mes": [{"mes": m, "total": por_mes[m]} for m in meses],
        "por_controlador": controladores,
        "por_dia": [{"fecha": f, "total": por_dia[f]} for f in dias_ordenados],
        "por_semana": [
            {"semana": s, "total": por_semana[s]} for s in sorted(por_semana.keys())
        ],
        "por_hora": [{"hora": hh, "total": por_hora[hh]} for hh in range(24)],
        "total_general": sum(por_mes.values()),
    }


SQL_RECONTROLES_DIAG = """
SELECT COUNT(*) AS pedidos_con_recontrol, SUM(cnt) AS filas_extra
FROM (
    SELECT NroMovVenta, CodCentroPrep, COUNT(*) AS cnt
    FROM dbo.Ven_PedImpresoCP
    WHERE FechaControl BETWEEN dbo.FECHA_SQL2Cla(?) AND dbo.FECHA_SQL2Cla(?)
    GROUP BY NroMovVenta, CodCentroPrep
    HAVING COUNT(*) > 1
) x
"""


def fetch_mesa_control_recontroles_diag(mes: str | None = None) -> dict:
    """Cuántos pedidos tienen MÁS DE UNA fila en Ven_PedImpresoCP para el mismo
    (NroMovVenta, CodCentroPrep) en el mes (recontrol/reimpresión). Confirma
    por qué un SELECT DISTINCT sobre el join undercuenta contra la planilla
    de contaduría (ver comentario en SQL_RENGLONES_CONTROLADOS)."""
    mes = mes or datetime.now().strftime("%Y-%m")
    d, h = _rango_mes(mes)
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_RECONTROLES_DIAG, (d, h))
        row = cur.fetchone()
    finally:
        conn.close()
    return {
        "mes": mes,
        "pedidos_con_recontrol": int(row[0] or 0) if row else 0,
        "filas_extra": int(row[1] or 0) - int(row[0] or 0) if row and row[0] else 0,
    }


# ── Diagnóstico: texto real del SP (para ubicar la tabla fuente y poder ──────
#    contar CADA ítem controlado UNA sola vez, filtrando por Nro. de Factura/
#    pedido interno, en vez de sumar por CodControlador1+CodControlador2).
def fetch_mesa_control_sp_definicion() -> dict:
    """Devuelve el texto T-SQL del SP (sys.sql_modules; si viene vacío, intenta
    sp_helptext). Con esto se identifica la tabla real de control (columnas de
    factura/pedido/renglón) para poder armar la consulta de conteo EXACTO
    (sin duplicar por doble controlador). No modifica nada, sólo lee metadata."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        texto = None
        try:
            cur.execute(
                "SELECT OBJECT_DEFINITION(OBJECT_ID(?))", (SP_NOMBRE,)
            )
            row = cur.fetchone()
            texto = row[0] if row else None
        except Exception:
            texto = None
        if not texto:
            try:
                cur.execute(f"EXEC sp_helptext '{SP_NOMBRE}'")
                texto = "".join(r[0] for r in cur.fetchall() if r[0])
            except Exception as ex:
                return {"sp": SP_NOMBRE, "definicion": None, "error": str(ex)}
        return {"sp": SP_NOMBRE, "definicion": texto}
    finally:
        conn.close()


SQL_COLS_TABLA = """
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
"""


def fetch_mesa_control_tablas_diag() -> dict:
    """Columnas reales de Ven_PedImpresoCP y venfer_pedidoReng (las 2 tablas
    fuente del SP, según fetch_mesa_control_sp_definicion()). Sirve para
    ubicar la columna de renglón/línea en venfer_pedidoReng y así poder
    contar cada ítem controlado UNA sola vez (sin el fan-out del JOIN ni el
    UNION ALL por CodControlador1/CodControlador2 que hace el SP original)."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_COLS_TABLA, ("Ven_PedImpresoCP",))
        ped_cols = [{"col": r[0], "tipo": r[1]} for r in cur.fetchall()]
        cur.execute(SQL_COLS_TABLA, ("venfer_pedidoReng",))
        reng_cols = [{"col": r[0], "tipo": r[1]} for r in cur.fetchall()]
        return {
            "Ven_PedImpresoCP_columnas": ped_cols,
            "venfer_pedidoReng_columnas": reng_cols,
        }
    finally:
        conn.close()


def fetch_mesa_control_diag(mes: str | None = None) -> dict:
    """Corre el SP para UN mes (default: mes actual) y devuelve las columnas
    crudas + hasta 15 filas de muestra, para confirmar `_detectar_columnas()`."""
    mes = mes or datetime.now().strftime("%Y-%m")
    d, h = _rango_mes(mes)
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd;")
        _exec_sp(cur, d, h)
        cols, filas = _rows(cur)
    finally:
        conn.close()
    return {
        "mes": mes,
        "desde": d.isoformat(),
        "hasta": h.isoformat(),
        "columnas": cols,
        "columnas_detectadas": _detectar_columnas(cols),
        "filas_totales": len(filas),
        "muestra": [dict(zip(cols, f)) for f in filas[:15]],
    }
# (fin mesa_control.py)
