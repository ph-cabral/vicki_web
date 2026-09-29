"""
Órdenes de compra agregadas POR ÁREA y ESTADO — para la pestaña
"Presupuestos" de /finanza (2026-09-01).

Qué es el "área"
----------------
Los "presupuestos de cada área" de compras SON órdenes de compra. El área es
el TIPO DE COMPROBANTE con el que se cargó la OC
(`Com_OrdCompCabecera.CompCodigo` → `Com_CodCompCpra.DetalleComp`):

    70 ORDEN DE COMPRA (nacionales) · 75 ORDEN DE COMPRA IMPO ·
    76 ORDEN COMPRA INDUSTRIA · 77 ORDEN DE COMPRA MARKETING ·
    74 ORDEN COMPRA RRHH · 78 ORDEN DE COMPRA SISTEMAS IT ·
    80 INGRESO INDUSTRIA A COMERCIAL

NO es el comprador (`CodComprador` → `Com_Compradores`): ése es la PERSONA que
firma, y varias personas cargan el mismo tipo de comprobante (Ana Laura y
GERMAN (IMPO) firman las dos OC 70). El comprador viene igual en la respuesta
como desglose secundario, pero el corte principal de la vista es el
comprobante. Ojo: `Com_TipoComprobante` sólo tiene {0: NINGUNO} — el maestro
bueno es `Com_CodCompCpra` (ver la memoria `oc_extraccion_completa`).

Estados de la OC (cabecera, `Gen_Estados` está VACÍA — inferidos y verificados
contra el reporte de Magnus): 1 pendiente de recibir · 2 cumplida ·
3 cumplida parcialmente · 4 cancelada · 5 eliminada (cabecera sin ningún
renglón vivo, no aporta filas) · 0 sin confirmar.
Las CANCELADAS quedan FUERA de todos los totales (mismo criterio que
compras.py) y se informan aparte en `canceladas`.

Plata
-----
  · `Precio` del renglón = `PrecioConvenido` NETO de las bonificaciones del
    renglón (`PorcBonif1..5` en cascada, a 4 decimales). `PrecioConvenido`
    solo es BRUTO.
  · Importe del renglón = Unidades × precio neto.
  · Moneda: las OC de impo van en U$S. Todo se PESIFICA con la
    `Cotizacion` de la cabecera (la del día de la OC), porque si no un total
    que mezcla $ y U$S no significa nada. Se devuelve también el importe en
    moneda original (`importeMonOrig`) y cuánto de eso era USD.
  · El cálculo del precio neto va en float y se redondea a 4 decimales: da
    diferencias de fracciones de centavo contra `oc_extraccion.py` (que usa
    Decimal/HALF_UP para reproducir el reporte al peso). Para un tablero de
    agregados en millones es irrelevante, y evita que la escala decimal del
    producto de 5 factores desborde en SQL Server.

Rendimiento
-----------
Como el `GROUP BY` ya abre por MES, cada área devuelve además `serieMes`: un
casillero por mes del rango (incluso los meses sin OC) con lo gastado en ese
mes. Sale gratis — es otra pasada sobre las mismas filas en Python, no una
segunda consulta — y es lo que dibuja la tira de meses debajo de la barra de
presupuesto.

Una sola consulta AGREGADA en SQL: `GROUP BY` mes × comprobante × estado. No
se traen renglones a Python (el rango 2026-01..08 son 9.572 renglones y
devolvería ~100 filas). El único filtro sobre la tabla grande es
`cab.FecMovim BETWEEN ? AND ?`, con la columna CRUDA comparada contra enteros
Magnus (gotcha del driver viejo: nunca `dbo.fecha_cla2sql(...)` ni `DATEADD`
en el WHERE, no filtra bien y se pierden filas sin tirar error). El mes se
resuelve con un CASE de rangos armado en Python — va en el SELECT, no en el
WHERE, así que no rompe el índice.
"""
import calendar
import time
from datetime import date, timedelta

from db import get_connection
from ventas import BASE_DATE, _parse_ym

ESTADO_OC = {
    0: "SIN CONFIRMAR",
    1: "PENDIENTE DE RECIBIR",
    2: "CUMPLIDA",
    3: "CUMPLIDA PARCIALMENTE",
    4: "CANCELADA",
    5: "ELIMINADA",
}
ESTADO_CANCELADA = 4
# Los tres que dibuja la vista (donut + columnas de la tabla). El resto entra
# en los totales pero no tiene columna propia.
ESTADOS_VISTA = (2, 1, 3)

# Ventana máxima pedible, en meses. Un rango más largo no es un error de
# performance (la consulta es agregada) pero sí de lectura.
MAX_MESES = 36

_TTL_SEG = 10 * 60
_CACHE: dict[tuple, tuple[float, dict]] = {}


def _meses(d_ym: tuple[int, int], h_ym: tuple[int, int]) -> list[tuple[str, int, int]]:
    """[(YYYY-MM, dia_desde, dia_hasta)] — días Magnus del 1º al último de
    cada mes del rango, ambos inclusive."""
    out = []
    y, m = d_ym
    while (y, m) <= h_ym:
        ini = date(y, m, 1)
        fin = date(y, m, calendar.monthrange(y, m)[1])
        out.append((f"{y:04d}-{m:02d}", (ini - BASE_DATE).days, (fin - BASE_DATE).days))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _rango(desde: str | None, hasta: str | None):
    """Default: MES EN CURSO. Distinto de los rankings de ventas (ventana fija
    de 12 meses cerrados): acá el mes incompleto es justamente el que se mira,
    porque las OC se siguen mientras están vivas."""
    hoy = date.today()
    d_ym = _parse_ym(desde) if desde else (hoy.year, hoy.month)
    h_ym = _parse_ym(hasta) if hasta else d_ym
    if d_ym > h_ym:
        d_ym, h_ym = h_ym, d_ym
    meses = _meses(d_ym, h_ym)
    if len(meses) > MAX_MESES:
        raise ValueError(f"Rango demasiado largo: {len(meses)} meses (máximo {MAX_MESES})")
    return d_ym, h_ym, meses


# Precio neto del renglón: PrecioConvenido con las 5 bonificaciones en
# cascada. Se calcula una sola vez en el CTE y se reusa en los 4 SUM.
_PNET = """ROUND(CAST(r.PrecioConvenido AS float)
             * (1 - ISNULL(r.PorcBonif1, 0) / 100.0)
             * (1 - ISNULL(r.PorcBonif2, 0) / 100.0)
             * (1 - ISNULL(r.PorcBonif3, 0) / 100.0)
             * (1 - ISNULL(r.PorcBonif4, 0) / 100.0)
             * (1 - ISNULL(r.PorcBonif5, 0) / 100.0), 4)"""

SQL = """
WITH reng AS (
    SELECT {case_mes} AS Mes,
           cab.CompCodigo   AS Comp,
           cab.CodComprador AS Comprador,
           cab.Estado       AS Estado,
           cab.NroOrdCompra AS OC,
           cab.Moneda       AS Moneda,
           CASE WHEN ISNULL(cab.Cotizacion, 0) > 0
                THEN CAST(cab.Cotizacion AS float) ELSE 1.0 END AS Cot,
           CAST(ISNULL(r.Unidades, 0) AS float)          AS Pedida,
           CAST(ISNULL(r.UnidadesCumplidas, 0) AS float) AS Cumplida,
           {pnet} AS PNet
    FROM EVERWEAR.dbo.Com_OrdCompRenglones r WITH (NOLOCK)
    INNER JOIN EVERWEAR.dbo.Com_OrdCompCabecera cab WITH (NOLOCK)
            ON cab.NroOrdCompra = r.NroOrdCompra
    WHERE cab.FecMovim BETWEEN ? AND ?
)
SELECT Mes, Comp, Comprador, Estado,
       COUNT(*)                AS Items,
       COUNT(DISTINCT OC)      AS OCs,
       SUM(Pedida)             AS UnidPedidas,
       SUM(Cumplida)           AS UnidCumplidas,
       SUM(Pedida * PNet)                       AS ImporteOrig,
       SUM(Pedida * PNet * Cot)                 AS Importe,
       SUM(Cumplida * PNet * Cot)               AS ImporteCumplido,
       SUM((Pedida - Cumplida) * PNet * Cot)    AS ImportePendiente,
       SUM(CASE WHEN Moneda IN (2, 5, 6, 7, 8, 10)
                THEN Pedida * PNet * Cot ELSE 0 END) AS ImporteUsd
FROM reng
GROUP BY Mes, Comp, Comprador, Estado
"""

# Maestros chicos (48 y 14 filas): se traen enteros de una y se cruzan con
# dicts, en vez de joinear por renglón.
SQL_COMPROBANTES = """
SELECT CompCodigo, DetalleComp FROM EVERWEAR.dbo.Com_CodCompCpra WITH (NOLOCK)
"""
SQL_COMPRADORES = """
SELECT CodComprador, NombreComprador FROM EVERWEAR.dbo.Com_Compradores WITH (NOLOCK)
"""


def _case_mes(meses) -> str:
    ramas = " ".join(
        f"WHEN cab.FecMovim BETWEEN {d1} AND {d2} THEN '{ym}'" for ym, d1, d2 in meses
    )
    return f"CASE {ramas} ELSE '?' END"


def _txt(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _r2(v) -> float:
    return round(float(v or 0), 2)


def _acum() -> dict:
    return {
        "items": 0, "ocs": 0,
        "unidadesPedidas": 0.0, "unidadesCumplidas": 0.0,
        "importe": 0.0, "importeCumplido": 0.0, "importePendiente": 0.0,
        "importeMonOrig": 0.0, "importeUsd": 0.0,
    }


def _sumar(acc: dict, f: dict) -> None:
    acc["items"] += f["items"]
    acc["ocs"] += f["ocs"]
    acc["unidadesPedidas"] += f["unidadesPedidas"]
    acc["unidadesCumplidas"] += f["unidadesCumplidas"]
    acc["importe"] += f["importe"]
    acc["importeCumplido"] += f["importeCumplido"]
    acc["importePendiente"] += f["importePendiente"]
    acc["importeMonOrig"] += f["importeMonOrig"]
    acc["importeUsd"] += f["importeUsd"]


def _redondear(d: dict) -> dict:
    for k, v in d.items():
        if isinstance(v, float):
            d[k] = round(v, 2)
    return d


def fetch_oc_por_area(desde: str | None = None,
                      hasta: str | None = None,
                      forzar: bool = False) -> dict:
    """OC del rango agregadas por área (tipo de comprobante) y estado.

    `ocs` es COUNT(DISTINCT NroOrdCompra) dentro de cada grupo: una OC de un
    mes tiene un solo comprobante, un solo comprador y un solo estado, así que
    los conteos por área/mes/estado son exactos. El total general se suma de
    esos grupos — como una OC no puede estar en dos grupos a la vez, tampoco
    hay doble conteo ahí.
    """
    d_ym, h_ym, meses = _rango(desde, hasta)
    key = ("oc_area", d_ym, h_ym)
    if not forzar:
        hit = _CACHE.get(key)
        if hit is not None and (time.monotonic() - hit[0]) < _TTL_SEG:
            return hit[1]

    d1, d2 = meses[0][1], meses[-1][2]
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL.format(case_mes=_case_mes(meses), pnet=_PNET), (d1, d2))
        filas = [
            {
                "mes": _txt(f[0]) or "?",
                "comp": int(f[1] or 0),
                "comprador": int(f[2] or 0),
                "estado": int(f[3] or 0),
                "items": int(f[4] or 0),
                "ocs": int(f[5] or 0),
                "unidadesPedidas": float(f[6] or 0),
                "unidadesCumplidas": float(f[7] or 0),
                "importeMonOrig": float(f[8] or 0),
                "importe": float(f[9] or 0),
                "importeCumplido": float(f[10] or 0),
                "importePendiente": float(f[11] or 0),
                "importeUsd": float(f[12] or 0),
            }
            for f in cur.fetchall()
        ]
        cur.execute(SQL_COMPROBANTES)
        comprobantes = {int(k or 0): _txt(v) for k, v in cur.fetchall()}
        cur.execute(SQL_COMPRADORES)
        compradores = {int(k or 0): _txt(v) for k, v in cur.fetchall()}
    finally:
        conn.close()

    canceladas = _acum()
    total = _acum()
    areas: dict[int, dict] = {}
    por_comprador: dict[int, dict] = {}
    serie: dict[str, dict] = {ym: _acum() for ym, _, _ in meses}

    for f in filas:
        if f["estado"] == ESTADO_CANCELADA:
            _sumar(canceladas, f)
            continue
        _sumar(total, f)

        a = areas.get(f["comp"])
        if a is None:
            nombre = comprobantes.get(f["comp"]) or f"COMPROBANTE {f['comp']}"
            a = areas[f["comp"]] = {
                "codigo": f["comp"], "area": nombre, "estados": {},
                # Un casillero por mes del rango, SIEMPRE los mismos y en
                # orden: la vista dibuja la tira de meses debajo de la barra
                # de presupuesto y necesita el mes vacío también (un mes sin
                # OC es información, no una fila que falta).
                "serieMes": {ym: _acum() for ym, _, _ in meses},
                **_acum(),
            }
        _sumar(a, f)
        sm = a["serieMes"].get(f["mes"])
        if sm is not None:
            _sumar(sm, f)
        e = a["estados"].get(f["estado"])
        if e is None:
            e = a["estados"][f["estado"]] = {
                "estado": f["estado"],
                "nombre": ESTADO_OC.get(f["estado"], f"ESTADO {f['estado']}"),
                **_acum(),
            }
        _sumar(e, f)

        c = por_comprador.get(f["comprador"])
        if c is None:
            c = por_comprador[f["comprador"]] = {
                "codigo": f["comprador"],
                "comprador": compradores.get(f["comprador"]) or f"COMPRADOR {f['comprador']}",
                **_acum(),
            }
        _sumar(c, f)

        m = serie.get(f["mes"])
        if m is not None:
            _sumar(m, f)

    # Totales por estado (para el donut): mismos números que la tabla, sumados
    # por columna en vez de por fila.
    por_estado: dict[int, dict] = {}
    for a in areas.values():
        for cod, e in a["estados"].items():
            acc = por_estado.get(cod)
            if acc is None:
                acc = por_estado[cod] = {
                    "estado": cod, "nombre": e["nombre"], **_acum(),
                }
            _sumar(acc, e)

    resp = {
        "desde": f"{d_ym[0]:04d}-{d_ym[1]:02d}",
        "hasta": f"{h_ym[0]:04d}-{h_ym[1]:02d}",
        "resumen": _redondear(total),
        "canceladas": _redondear(canceladas),
        "estadosVista": list(ESTADOS_VISTA),
        "porEstado": sorted(
            (_redondear(e) for e in por_estado.values()),
            key=lambda x: -x["importe"],
        ),
        "areas": sorted(
            (
                _redondear({
                    **a,
                    "estados": sorted(
                        (_redondear(e) for e in a["estados"].values()),
                        key=lambda x: x["estado"],
                    ),
                    "serieMes": [
                        _redondear({"mes": ym, **a["serieMes"][ym]})
                        for ym, _, _ in meses
                    ],
                })
                for a in areas.values()
            ),
            key=lambda x: -x["importe"],
        ),
        "compradores": sorted(
            (_redondear(c) for c in por_comprador.values()),
            key=lambda x: -x["importe"],
        ),
        "meses": [
            _redondear({"mes": ym, **serie[ym]}) for ym, _, _ in meses
        ],
    }
    _CACHE[key] = (time.monotonic(), resp)
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# DETALLE de las OC de UN área (2026-09-02)
#
# Alimenta el modal que se abre al hacer click en una fila de "Ejecución del
# presupuesto" en /finanza → Presupuestos. Una fila POR OC (cabecera), no por
# renglón: número de movimiento (CompCentro-CompNumero), fecha, importe
# pesificado y la observación de la cabecera. Los renglones sólo se agregan
# para calcular el importe, no se devuelven.
#
# Mismo recorte que el agregado de arriba (así los totales cierran con la
# barra): `cab.FecMovim` CRUDO contra enteros Magnus en el WHERE, canceladas
# afuera, importes pesificados a la cotización de cada OC. El área
# (`CompCodigo`) también va en el WHERE — es lo que hace que esta consulta sea
# chica: un mes de un área son decenas de OC, no las ~1.500 del mes entero.
# ─────────────────────────────────────────────────────────────────────────────

# Techo de filas: un área con muchos meses abiertos no puede tirarle 10.000 OC
# al navegador. Se avisa con `truncado` en la respuesta.
MAX_OC_DETALLE = 3000

SQL_DETALLE = """
WITH reng AS (
    SELECT cab.NroOrdCompra AS OC,
           {case_mes}       AS Mes,
           cab.CompCentro   AS Centro,
           cab.CompNumero   AS Numero,
           cab.FecMovim     AS Fecha,
           cab.Estado       AS Estado,
           cab.CodProveed   AS Prov,
           cab.CodComprador AS Comprador,
           cab.Moneda       AS Moneda,
           CASE WHEN ISNULL(cab.Cotizacion, 0) > 0
                THEN CAST(cab.Cotizacion AS float) ELSE 1.0 END AS Cot,
           CAST(ISNULL(r.Unidades, 0) AS float)          AS Pedida,
           CAST(ISNULL(r.UnidadesCumplidas, 0) AS float) AS Cumplida,
           {pnet} AS PNet
    FROM EVERWEAR.dbo.Com_OrdCompRenglones r WITH (NOLOCK)
    INNER JOIN EVERWEAR.dbo.Com_OrdCompCabecera cab WITH (NOLOCK)
            ON cab.NroOrdCompra = r.NroOrdCompra
    WHERE cab.FecMovim BETWEEN ? AND ?
      AND cab.CompCodigo = ?
      AND cab.Estado <> {cancelada}
)
SELECT TOP {tope}
       OC, Mes, Centro, Numero, Fecha, Estado, Prov, Comprador, Moneda,
       MAX(Cot)                                 AS Cot,
       COUNT(*)                                 AS Items,
       SUM(Pedida)                              AS UnidPedidas,
       SUM(Cumplida)                            AS UnidCumplidas,
       SUM(Pedida * PNet)                       AS ImporteOrig,
       SUM(Pedida * PNet * Cot)                 AS Importe,
       SUM(Cumplida * PNet * Cot)               AS ImporteCumplido,
       SUM((Pedida - Cumplida) * PNet * Cot)    AS ImportePendiente
FROM reng
GROUP BY OC, Mes, Centro, Numero, Fecha, Estado, Prov, Comprador, Moneda
ORDER BY Fecha DESC, Numero DESC
"""

# La observación es char(255) y no conviene arrastrarla por el GROUP BY (se
# compara y ordena 255 caracteres por renglón): se trae aparte, sólo para las
# OC que quedaron, en una consulta por clave primaria.
SQL_OBS = """
SELECT NroOrdCompra, Observaciones, NroPedidoProveedor
FROM EVERWEAR.dbo.Com_OrdCompCabecera WITH (NOLOCK)
WHERE NroOrdCompra IN ({ids})
"""

# "Detalle Complementario" de cada renglón de la OC (el texto libre que se
# carga en Magnus con el botón del renglón). Vive en Com_DetalleComplement,
# Clase 20 = OC (21/22 son otros movimientos de compras), NroMovCompra =
# NroOrdCompra. El clustered es (Clase, NroMovCompra, NroRenglon): con Clase
# fija + IN de OC es un seek puro, sólo para las OC que quedaron en el modal.
SQL_DETALLE_COMPL = """
SELECT NroMovCompra, NroRenglon, RTRIM(DetalleComplem)
FROM EVERWEAR.dbo.Com_DetalleComplement WITH (NOLOCK)
WHERE Clase = 20
  AND NroMovCompra IN ({ids})
ORDER BY NroMovCompra, NroRenglon
"""

SQL_PROVEEDORES = """
SELECT CodProveed, RazonSocial, NombreComercial
FROM EVERWEAR.dbo.Com_Proveedores WITH (NOLOCK)
WHERE CodProveed IN ({ids})
"""

# Tope de la cláusula IN: si hubiera más OC/proveedores que esto se parte en
# tandas (SQL Server tolera muchos más, pero el parser se pone lento).
_LOTE = 900


def _lotes(seq, n=_LOTE):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _fecha_iso(dias) -> str | None:
    """Entero Magnus (días desde 1800-12-28) → 'YYYY-MM-DD'."""
    if dias is None:
        return None
    try:
        return (BASE_DATE + timedelta(days=int(dias))).isoformat()
    except (ValueError, OverflowError):
        return None


def fetch_oc_detalle_area(codigo: int,
                          desde: str | None = None,
                          hasta: str | None = None,
                          forzar: bool = False) -> dict:
    """OC (una por cabecera) de un área en el rango de meses, agrupadas por mes.

    Devuelve `{"meses": [{mes, ocs, importe, ordenes: [...]}, ...]}` ya ordenado
    de mes más nuevo a más viejo y, dentro de cada mes, de OC más nueva a más
    vieja: el modal dibuja acordeones por mes y no tiene que reordenar nada.
    """
    codigo = int(codigo)
    d_ym, h_ym, meses = _rango(desde, hasta)
    key = ("oc_detalle", codigo, d_ym, h_ym)
    if not forzar:
        hit = _CACHE.get(key)
        if hit is not None and (time.monotonic() - hit[0]) < _TTL_SEG:
            return hit[1]

    d1, d2 = meses[0][1], meses[-1][2]
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(
            SQL_DETALLE.format(
                case_mes=_case_mes(meses), pnet=_PNET,
                cancelada=ESTADO_CANCELADA, tope=MAX_OC_DETALLE + 1,
            ),
            (d1, d2, codigo),
        )
        filas = [
            {
                "oc": int(f[0] or 0),
                "mes": _txt(f[1]) or "?",
                "numero": f"{int(f[2] or 0):04d}-{int(f[3] or 0):08d}",
                "fecha": _fecha_iso(f[4]),
                "estado": int(f[5] or 0),
                "estadoNombre": ESTADO_OC.get(int(f[5] or 0), f"ESTADO {int(f[5] or 0)}"),
                "codProveedor": int(f[6] or 0),
                "codComprador": int(f[7] or 0),
                "moneda": int(f[8] or 0),
                "cotizacion": _r2(f[9]),
                "items": int(f[10] or 0),
                "unidadesPedidas": _r2(f[11]),
                "unidadesCumplidas": _r2(f[12]),
                "importeMonOrig": _r2(f[13]),
                "importe": _r2(f[14]),
                "importeCumplido": _r2(f[15]),
                "importePendiente": _r2(f[16]),
            }
            for f in cur.fetchall()
        ]
        truncado = len(filas) > MAX_OC_DETALLE
        if truncado:
            filas = filas[:MAX_OC_DETALLE]

        obs: dict[int, tuple[str | None, str | None]] = {}
        det: dict[int, list[str]] = {}
        provs: dict[int, str | None] = {}
        compradores: dict[int, str | None] = {}
        if filas:
            for lote in _lotes({f["oc"] for f in filas}):
                cur.execute(SQL_OBS.format(ids=",".join(str(i) for i in lote)))
                for nro, o, ped in cur.fetchall():
                    obs[int(nro or 0)] = (_txt(o), _txt(ped))
                cur.execute(SQL_DETALLE_COMPL.format(ids=",".join(str(i) for i in lote)))
                for nro, _reng, txt in cur.fetchall():
                    t = " ".join((_txt(txt) or "").split())
                    if t:
                        det.setdefault(int(nro or 0), []).append(t)
            codigos_prov = {f["codProveedor"] for f in filas if f["codProveedor"]}
            for lote in _lotes(codigos_prov):
                cur.execute(SQL_PROVEEDORES.format(ids=",".join(str(i) for i in lote)))
                for cod, razon, comercial in cur.fetchall():
                    provs[int(cod or 0)] = _txt(razon) or _txt(comercial)
            cur.execute(SQL_COMPRADORES)
            compradores = {int(k or 0): _txt(v) for k, v in cur.fetchall()}
    finally:
        conn.close()

    por_mes: dict[str, dict] = {
        ym: {"mes": ym, "ocs": 0, "items": 0, "importe": 0.0,
             "importeCumplido": 0.0, "importePendiente": 0.0, "ordenes": []}
        for ym, _, _ in meses
    }
    total = {"ocs": 0, "items": 0, "importe": 0.0,
             "importeCumplido": 0.0, "importePendiente": 0.0}
    for f in filas:
        o, ped = obs.get(f["oc"], (None, None))
        f["observacion"] = o
        f["pedidoProveedor"] = ped
        # Detalle complementario de los renglones, en orden, sin repetidos.
        f["detalle"] = " · ".join(dict.fromkeys(det.get(f["oc"], []))) or None
        f["proveedor"] = provs.get(f["codProveedor"]) or (
            f"PROVEEDOR {f['codProveedor']}" if f["codProveedor"] else None
        )
        f["comprador"] = compradores.get(f["codComprador"])
        m = por_mes.get(f["mes"])
        if m is None:
            continue
        m["ordenes"].append(f)
        m["ocs"] += 1
        m["items"] += f["items"]
        m["importe"] += f["importe"]
        m["importeCumplido"] += f["importeCumplido"]
        m["importePendiente"] += f["importePendiente"]
        total["ocs"] += 1
        total["items"] += f["items"]
        total["importe"] += f["importe"]
        total["importeCumplido"] += f["importeCumplido"]
        total["importePendiente"] += f["importePendiente"]

    resp = {
        "codigo": codigo,
        "desde": f"{d_ym[0]:04d}-{d_ym[1]:02d}",
        "hasta": f"{h_ym[0]:04d}-{h_ym[1]:02d}",
        "truncado": truncado,
        "maximo": MAX_OC_DETALLE,
        "resumen": _redondear(total),
        # Meses de más nuevo a más viejo: el acordeón se abre por el último.
        # Los meses sin OC igual van (un mes sin compras es información).
        "meses": [
            _redondear(por_mes[ym]) for ym, _, _ in reversed(meses)
        ],
    }
    _CACHE[key] = (time.monotonic(), resp)
    return resp
