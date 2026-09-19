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


def _dia_magnus(valor) -> int:
    """date | datetime -> entero de días de Magnus (inverso de
    _fecha_desde_dias, y mismo valor que devuelve dbo.FECHA_SQL2Cla —
    verificado contra la base).

    Se calcula acá y no con dbo.FECHA_SQL2Cla(?) dentro del WHERE: una función
    escalar del lado del parámetro deja al optimizador sin saber qué rango se
    va a filtrar, así que estima mal la cantidad de filas y elige el peor plan.
    """
    d = valor.date() if isinstance(valor, datetime) else valor
    return (d - _BASE_CLARION).days


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


def _slot30_desde_centesimas(valor) -> int | None:
    """HoraControl (centésimas de segundo desde medianoche) -> franja de 30
    minutos del día, 0..47 (0 = '00:00', 1 = '00:30', ..., 47 = '23:30').
    Mismo dato que _hora_desde_centesimas, al doble de resolución — usado
    sólo en el desglose "Por controlador > Día" (2026-09-14)."""
    try:
        v = int(valor)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    minutos_del_dia = (v // 100 // 60) % 1440
    return minutos_del_dia // 30


SP_NOMBRE = "dbo.RPT_V325_ProductividadPorControlador"
CANTIDAD_COL = "CANTIDAD ITEMS CONTROLADOS"  # confirmada (control_extraccion.py)

# Nombre a mostrar cuando el artículo del renglón no tiene línea cargada o su
# código no matchea el catálogo (LEFT JOIN da NULL) — mismo texto/criterio
# que SIN_LINEA en ventas.py, pero declarado acá aparte para no acoplar los
# dos módulos por un import.
LINEA_SIN = "(Sin línea)"


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
# Línea de catálogo del artículo de cada renglón (para "Por controlador >
# 5 líneas más controladas", 2026-09-14): mismo join ya usado en ventas.py /
# bulones.py — venfer_pedidoReng.CodArticu -> StkFer_Articulos.CodArticulo
# (ojo, nombres distintos) -> StkFer_ArtParamet.ArticuloPatron -> Nivel1 (int,
# código de línea) -> Stk_Nivel1.Detalle (char(30), nombre a mostrar). LEFT
# JOIN a propósito: un artículo sin línea cargada o con código que no está en
# Stk_Nivel1 no debe perder el renglón, cae en LINEA_SIN (ver _nombre_linea
# más abajo). Son todos joins 1:1 sobre columnas tipo PK — no hay fan-out.
SQL_RENGLONES_CONTROLADOS = """
SELECT
    reng.NroMovVenta, reng.NroRenglon,
    ped.CodControlador1, ped.CodControlador2,
    ped.FechaControl, ped.HoraControl,
    LTRIM(RTRIM(n1.Detalle)) AS Linea
FROM dbo.Ven_PedImpresoCP ped
JOIN dbo.venfer_pedidoReng reng
  ON ped.NroMovVenta   = reng.NroMovVenta
 AND ped.CodCentroPrep = reng.CodCentroPrep
LEFT JOIN dbo.StkFer_Articulos  s  ON s.CodArticulo     = reng.CodArticu
LEFT JOIN dbo.StkFer_ArtParamet ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN dbo.Stk_Nivel1        n1 ON n1.Nivel1         = ap.Nivel1
WHERE (ped.CodControlador1 > 0 OR ped.CodControlador2 > 0)
  AND ped.FechaControl BETWEEN ? AND ?
"""


def _nombre_linea(raw: str | None) -> str:
    """Linea ya trimeada por el SQL -> nombre a mostrar, o LINEA_SIN si vino
    NULL/vacía (artículo sin línea cargada o código fuera de Stk_Nivel1)."""
    raw_norm = (raw or "").strip()
    return raw_norm or LINEA_SIN


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

    Desglose por controlador (2026-09-14, para el toggle "Por controlador" del
    front — 1 gráfico de barras por controlador + torta de líneas debajo):
    cada `por_controlador[i]` agrega ADEMÁS:
      · por_dia    = [{fecha: 'YYYY-MM-DD', total, ot}]   — vista "Mes": 1
        columna por día calendario, sólo días con controles de ESE
        controlador.
      · por_dow    = [{dow: 0..6, total, ot}]  (0=lunes..6=domingo, ISO) —
        vista "Semana": 1 columna por día de la semana, sumado sobre todos
        los meses elegidos (no una semana calendario puntual).
      · por_slot30 = [{slot: 0..47, hora: 'HH:MM', total, ot}]  — vista
        "Día": 1 columna cada 30 min (slot = hora*2 + 0/1), sumado sobre
        todos los meses elegidos — mismo criterio de agregación que
        `por_hora` pero al doble de resolución y acotado a ese controlador.
      En los 3, `total` = renglones/items (créditos, cuenta recontroles) y
      `ot` = NroMovVenta (pedidos) DISTINTOS detrás de esos créditos — un
      pedido con varios renglones controlados en la misma franja suma 1 solo
      OT pero N items.
      · por_linea  = [{linea, total}]  ordenado desc — línea de catálogo
        (Stk_Nivel1.Detalle) del artículo de cada renglón que controló; el
        front arma el top 5 + "Otros" para la torta.
    OJO — criterio distinto al de por_dia/por_semana/por_hora de arriba: estos
    4 campos ubican CADA CRÉDITO (cod1/cod2, incluye recontroles) en la fecha/
    hora de ESE control puntual, no en la del evento más reciente del renglón
    — es la extensión natural de por_controlador.total (que ya cuenta créditos,
    no renglones únicos), para que sumen entre sí sin sorpresas.
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
            cur.execute(SQL_RENGLONES_CONTROLADOS, (_dia_magnus(d), _dia_magnus(h)))
            filas = cur.fetchall()

            renglones_unicos: set[tuple] = set()
            evento_por_renglon: dict[tuple, tuple[str, int]] = {}
            for nro, nro_reng, cod1, cod2, fecha_ctrl, hora_ctrl, linea_raw in filas:
                clave = (nro, nro_reng)
                renglones_unicos.add(clave)

                fecha_evt = _fecha_desde_dias(fecha_ctrl)
                if fecha_evt is not None:
                    hora_evt = _hora_desde_centesimas(hora_ctrl)
                    candidato = (fecha_evt.isoformat(), hora_evt if hora_evt is not None else -1)
                    previo = evento_por_renglon.get(clave)
                    if previo is None or candidato > previo:
                        evento_por_renglon[clave] = candidato

                # Fecha/hora/línea DE ESTE control puntual (no el "evento más
                # reciente del renglón" de arriba) — es lo que alimenta los
                # desgloses por_dia/por_dow/por_slot30/por_linea de CADA
                # controlador, que siguen el mismo criterio "cada crédito
                # cuenta" que entry["total"] más abajo (ver docstring).
                slot30 = _slot30_desde_centesimas(hora_ctrl)
                dow = fecha_evt.weekday() if fecha_evt is not None else None  # 0=lunes
                linea_nombre = _nombre_linea(linea_raw)

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
                            # cada valor: {"items": int, "ots": set()} — "ots"
                            # junta NroMovVenta distintos para poder mostrar,
                            # además de items (renglones), la cantidad de
                            # pedidos/OT distintos detrás de esa barra.
                            "_por_dia": {},
                            "_por_dow": {i: {"items": 0, "ots": set()} for i in range(7)},
                            "_por_slot30": {i: {"items": 0, "ots": set()} for i in range(48)},
                            "_por_linea": {},
                        },
                    )
                    entry["por_mes"][mes] = entry["por_mes"].get(mes, 0) + 1
                    entry["total"] += 1
                    if fecha_evt is not None:
                        fs = fecha_evt.isoformat()
                        dia_entry = entry["_por_dia"].setdefault(
                            fs, {"items": 0, "ots": set()}
                        )
                        dia_entry["items"] += 1
                        dia_entry["ots"].add(nro)
                        entry["_por_dow"][dow]["items"] += 1
                        entry["_por_dow"][dow]["ots"].add(nro)
                    if slot30 is not None:
                        entry["_por_slot30"][slot30]["items"] += 1
                        entry["_por_slot30"][slot30]["ots"].add(nro)
                    entry["_por_linea"][linea_nombre] = (
                        entry["_por_linea"].get(linea_nombre, 0) + 1
                    )
            por_mes[mes] = len(renglones_unicos)

            for fecha_str, hora_num in evento_por_renglon.values():
                por_dia[fecha_str] = por_dia.get(fecha_str, 0) + 1
                if hora_num >= 0:
                    por_hora[hora_num] = por_hora.get(hora_num, 0) + 1
    finally:
        conn.close()

    # Los dicts internos "_por_*" (acumulados por comodidad durante el fetch)
    # se convierten acá a las listas ordenadas que consume el front, y se
    # descartan las claves privadas.
    for entry in por_ctrl.values():
        _dia = entry.pop("_por_dia")
        _dow = entry.pop("_por_dow")
        _slot30 = entry.pop("_por_slot30")
        _linea = entry.pop("_por_linea")
        entry["por_dia"] = [
            {"fecha": f, "total": _dia[f]["items"], "ot": len(_dia[f]["ots"])}
            for f in sorted(_dia)
        ]
        entry["por_dow"] = [
            {"dow": dw, "total": _dow[dw]["items"], "ot": len(_dow[dw]["ots"])}
            for dw in range(7)
        ]
        entry["por_slot30"] = [
            {
                "slot": s,
                "hora": f"{s // 2:02d}:{'00' if s % 2 == 0 else '30'}",
                "total": _slot30[s]["items"],
                "ot": len(_slot30[s]["ots"]),
            }
            for s in range(48)
        ]
        entry["por_linea"] = sorted(
            ({"linea": l, "total": t} for l, t in _linea.items()),
            key=lambda x: -x["total"],
        )

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
    WHERE FechaControl BETWEEN ? AND ?
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
        cur.execute(SQL_RECONTROLES_DIAG, (_dia_magnus(d), _dia_magnus(h)))
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
