"""
Órdenes de Compra pendientes de recibir (Magnus, SOLO LECTURA).

Para /compras/faltantes: cuánto de cada artículo "va a llegar".
Eso es lo pendiente de recibir de las OC = Cantidad - CantidadCumplida.
Al leerlo en vivo, cuando entra la mercadería Magnus sube CantidadCumplida y el
pendiente baja solo; no hace falta escribir nada (a Magnus nunca se le escribe).

Tablas (EVERWEAR, confirmadas por descubrimiento):
  · Com_OrdCompCabecera  → NroOrdCompra, CompCentro, CodProveed, Estado, FecMovim
  · Com_OrdCompRenglones → NroOrdCompra, NroRenglon, CodArticulo, Cantidad,
                            CantidadCumplida, FecEntregaPactada
  · Com_Proveedores      → CodProveed, RazonSocial   (nombre del proveedor)

El CodArticulo del renglón es el mismo que usa /deposito/faltantes (p.CodArticu),
por eso cruzan por artículo.

NOTA (afinar si hace falta): se considera "por llegar" todo renglón con
Cantidad - CantidadCumplida > 0. No se filtra por Estado. Si aparecieran OC
ANULADAS con saldo pendiente, sumar su Estado a ESTADOS_CAB_EXCLUIR (abajo).
"""
from collections import OrderedDict
from datetime import datetime, date, timedelta
from decimal import Decimal
from threading import Lock
from time import monotonic
from db import get_connection
# Criterio de "pedido válido" (Cerrado/Facturado, blacklist de CompCodigo) —
# el MISMO que usa /ventas/pedidos-mes, para que "vendido" signifique lo mismo
# en toda la app (ver ventas.py, confirmado 2026-07-10).
from ventas import COMP_CODIGOS_EXCLUIDOS, _es_valido

BASE_DATE = date(1800, 12, 28)  # Magnus guarda fechas como días desde esta base

# ── Clasificación de la OC (2026-08-28) ──────────────────────────────────────
# Códigos de Com_OrdCompCabecera.Estado, verificados contra el reporte Magnus
# de OC del mes: 1 pendiente de recibir · 2 cumplida · 3 cumplida parcialmente
# · 4 cancelada.
ESTADO_OC = {1: "PENDIENTE DE RECIBIR", 2: "CUMPLIDA",
             3: "CUMPLIDA PARCIALMENTE", 4: "CANCELADA"}
ESTADO_CANCELADA = 4

# Estados de CABECERA a excluir SIEMPRE: una OC cancelada no cubre faltantes ni
# cuenta como comprada en ningún reporte.
ESTADOS_CAB_EXCLUIR: tuple[int, ...] = (ESTADO_CANCELADA,)

_EXCL = (
    f"AND cab.Estado NOT IN ({','.join(str(e) for e in ESTADOS_CAB_EXCLUIR)})"
    if ESTADOS_CAB_EXCLUIR else ""
)

# ── Tipo de comprobante de la OC (2026-09-08) ────────────────────────────────
# Com_OrdCompCabecera.CompCodigo → Com_CodCompCpra.DetalleComp. Es el "área" de
# la tab Presupuestos de /finanza (ver oc_areas.py), NO el comprador:
#   70 ORDEN DE COMPRA · 74 OC RRHH · 75 OC IMPO · 76 OC INDUSTRIA ·
#   77 OC MARKETING · 78 OC SISTEMAS IT · 80 INGRESO INDUSTRIA A COMERCIAL
#
# Compra REAL de mercadería para reventa = 70 (nacional) + 75 (importación).
# El resto son presupuestos por área (gasto de RRHH / marketing / sistemas /
# industria) o, en el caso del 80, el pase interno de industria a comercial:
# ninguno cubre un faltante de venta ni es "lo comprado del mes".
#
# Antes NO se filtraba y se colaban en el funnel de /compras. Agosto 2026, ya
# recortado por tipo de artículo: 70 → 739 items · 2.128.782 u. | 77 → 1 item |
# 78 → 1 item | 80 → 24 items · 1.065 u. En el faltante Nacional del mes eso
# eran 1 item / $13.265 de más; en el total, 3 items / $588.380.
COMP_CODIGOS_OC_COMPRA: tuple[int, ...] = (70, 75)

_COMP = (
    f"AND cab.CompCodigo IN ({','.join(str(c) for c in COMP_CODIGOS_OC_COMPRA)})"
    if COMP_CODIGOS_OC_COMPRA else ""
)

# Origen del artículo: StkFer_Articulos.NacionalImportado → Stk_TiposArticulos.
# Descripcion ∈ {Nacional, Importado, Fabril, Generico, Original}.
#   · Generico  = presupuestos de servicio (P.INDUSTRIA, P.MKT) — NUNCA son
#                 compra de mercadería, se excluyen en todas las vistas.
#   · Fabril    = producción interna (PRODUCCION HIDRAULICA / FUNDICION) — solo
#                 se incluye cuando el consumidor lo pide (vistas de fábrica).
#   · Original  = proveedor externo real, cuenta como nacional.
# El join va por CodArticulo char = char (sin LTRIM/RTRIM) para que use índice:
# SQL Server ignora los espacios finales al comparar.
_JOIN_TIPO = """
LEFT JOIN EVERWEAR.dbo.StkFer_Articulos   a_t ON a_t.CodArticulo = r.CodArticulo
LEFT JOIN EVERWEAR.dbo.Stk_TiposArticulos t_t ON t_t.CodigoTipo  = a_t.NacionalImportado
"""


def _cond_tipo(incluir_fabril: bool = False) -> str:
    """Filtro de origen para el WHERE. Sin tipo cargado ⇒ se trata como Nacional
    (no se pierde la fila, que era el bug de poner t.Descripcion = 'Nacional')."""
    excluidos = ["'Generico'"] if incluir_fabril else ["'Generico'", "'Fabril'"]
    return f"AND ISNULL(t_t.Descripcion, 'Nacional') NOT IN ({', '.join(excluidos)})"


def _dias(fecha: date) -> int:
    """date → int días Magnus (base 1800-12-28), para filtrar por FecMovim en el
    propio SQL. Es un literal constante, así que filtra bien y usa índice — a
    diferencia de comparar una fecha calculada contra un parámetro `?`."""
    return (fecha - BASE_DATE).days


# Renglones de OC con saldo pendiente de recibir (Cantidad - CantidadCumplida).
# `{_fecha}` lo completa fetch_ordenes_pendientes con el corte por FecMovim.
SQL_OC_PENDIENTES = """
SELECT
    cab.CompCentro                       AS CompCentro,
    cab.CompNumero                       AS CompNumero,
    cab.NroOrdCompra                     AS NroOC,
    cab.FecMovim                         AS FecMovim,
    cab.Estado                           AS Estado,
    ISNULL(cab.NroImportacion, 0)        AS NroImportacion,
    LTRIM(RTRIM(r.CodArticulo))          AS CodArticu,
    r.Cantidad                           AS CantPedida,
    ISNULL(r.CantidadCumplida, 0)        AS CantRecibida,
    r.FecEntregaPactada                  AS FechaEntrega,
    pr.RazonSocial                       AS Proveedor,
    ISNULL(t_t.Descripcion, 'Nacional')  AS TipoArticulo
FROM EVERWEAR.dbo.Com_OrdCompRenglones r
INNER JOIN EVERWEAR.dbo.Com_OrdCompCabecera cab ON cab.NroOrdCompra = r.NroOrdCompra
LEFT  JOIN EVERWEAR.dbo.Com_Proveedores    pr  ON pr.CodProveed   = cab.CodProveed
{_join_tipo}
WHERE ISNULL(r.Cantidad, 0) - ISNULL(r.CantidadCumplida, 0) > 0
  {_excl}
  {_tipo}
  {_fecha}
"""

# Fecha de corte por defecto: solo se cruzan las OC hechas (FecMovim) desde acá.
# Antes de esto Magnus tiene OC viejas con saldo pendiente que NO deben cubrir
# faltantes actuales. Se puede pisar con ?desde=YYYY-MM-DD.
OC_DESDE_DEFAULT = "2026-06-26"


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


def _fecha_entrega(v):
    """ISO yyyy-mm-dd o None. FecEntregaPactada = int (días Magnus).
    0 / sentinela ⇒ None (renglón sin fecha de entrega pactada)."""
    if v is None:
        return None
    if isinstance(v, (date, datetime)):
        return v.date().isoformat() if v.year >= 1901 else None
    try:
        dias = int(v)
    except (TypeError, ValueError):
        return None
    if dias <= 0:
        return None
    return (BASE_DATE + timedelta(days=dias)).isoformat()


def _to_date(v):
    """FecMovim → date. Magnus puede guardarlo como int (días desde BASE_DATE) o
    como date/datetime. Devuelve None si no se puede interpretar."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date() if v.year >= 1901 else None
    if isinstance(v, date):
        return v if v.year >= 1901 else None
    try:
        dias = int(v)
    except (TypeError, ValueError):
        return None
    if dias <= 0:
        return None
    return BASE_DATE + timedelta(days=dias)


def _nro_oc(centro, numero):
    """Formatea como en Magnus: '0001-00014700'.

    OJO: el número que Magnus imprime y que sale en sus reportes es
    CompCentro-CompNumero, NO NroOrdCompra (ese es el id interno con el que
    joinean los renglones). Para la misma OC: NroOrdCompra 14582 =
    comprobante 0001-00014700 (verificado 2026-08-28)."""
    try:
        c = int(centro) if centro is not None else 0
    except (TypeError, ValueError):
        c = 0
    try:
        n = int(numero) if numero is not None else 0
    except (TypeError, ValueError):
        n = 0
    return f"{c:04d}-{n:08d}"


def fetch_ordenes_pendientes(desde=None, incluir_fabril: bool = False):
    """Agrega por artículo lo pendiente de recibir de las OC.

    desde = 'YYYY-MM-DD' (o None → OC_DESDE_DEFAULT): solo se toman las OC cuyo
    FecMovim (fecha en que se hizo la orden) sea >= a esa fecha. Así las OC viejas
    con saldo pendiente no cubren faltantes actuales. El corte va EN EL SQL
    (literal int días-Magnus), no en Python: con volumen alto traer toda la OC
    histórica para descartarla después era lo más caro de esta consulta.

    incluir_fabril=True: suma también la producción interna (vistas de fábrica).
    Los presupuestos genéricos nunca entran.

    Cada fila trae, además del pool agregado (FechaEntrega/FechaOC/PorLlegar
    de TODAS las OC pendientes juntas, como siempre), un array "Lotes": una
    entrada por OC puntual (NroOC), con su propia FechaOC/FechaEntrega/
    Pendiente/Importacion. 2026-09-16: antes de esto, un artículo con 2+ OC
    pendientes con fechas MUY distintas (ej. una vieja, ya vencida, que
    quedó con saldo suelto, y otra nueva hecha después de un faltante nuevo)
    mostraba la fecha más vieja de las dos como "arribo" del faltante nuevo
    — vencida y sin relación real con ese faltante. Los consumidores
    (app/api/ventas/faltantes, app/api/compras/faltantes-consumo) usan
    "Lotes" para elegir, por cada faltante puntual, solo la OC hecha DESPUÉS
    de que ese faltante apareció."""
    corte = None
    desde = desde or OC_DESDE_DEFAULT
    if desde:
        try:
            corte = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
        except ValueError:
            corte = None

    sql = SQL_OC_PENDIENTES.format(
        _join_tipo=_JOIN_TIPO,
        _excl=_EXCL,
        _tipo=_cond_tipo(incluir_fabril),
        _fecha=f"AND cab.FecMovim >= {_dias(corte)}" if corte else "",
    )

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(sql)
        cols = [c[0] for c in cur.description]

        agg: dict[str, dict] = {}
        lotes: dict[tuple[str, str], dict] = {}  # (cod, nro OC) -> lote agregado
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            cod = (str(d.get("CodArticu") or "")).strip()
            if not cod:
                continue
            # fecha de la orden (FecMovim) — se expone como FechaOC (más
            # temprana) para que los consumidores puedan armar un arribo
            # estimado (FechaOC + N días) cuando no hay FecEntregaPactada.
            fmov = _to_date(d.get("FecMovim"))
            pend = float(_safe(d.get("CantPedida")) or 0) - float(_safe(d.get("CantRecibida")) or 0)
            if pend <= 0:
                continue
            fecha = _fecha_entrega(d.get("FechaEntrega"))
            fmov_iso = fmov.isoformat() if fmov else None
            nro = _nro_oc(d.get("CompCentro"), d.get("CompNumero"))
            prov = (str(d.get("Proveedor") or "")).strip() or None
            tipo = (str(d.get("TipoArticulo") or "")).strip() or None
            # Importación: dato REAL de la cabecera (NroImportacion != 0). Antes
            # se infería de "renglón sin fecha de entrega", que marcaba como
            # importado cualquier renglón nacional al que no le cargaron fecha.
            try:
                es_impo = int(_safe(d.get("NroImportacion")) or 0) != 0
            except (TypeError, ValueError):
                es_impo = False

            a = agg.get(cod)
            if not a:
                a = {
                    "CodArticulo": cod,
                    "PorLlegar": 0.0,
                    "Proveedor": prov,
                    "FechaEntrega": fecha,    # se queda con la más temprana
                    "FechaOC": fmov_iso,      # fecha de la OC (FecMovim) más temprana
                    "Importacion": False,
                    "TipoArticulo": tipo,
                    "NroOCs": [],
                    "Lotes": [],
                }
                agg[cod] = a
            a["PorLlegar"] += pend
            if prov and not a["Proveedor"]:
                a["Proveedor"] = prov
            if tipo and not a["TipoArticulo"]:
                a["TipoArticulo"] = tipo
            if es_impo:
                a["Importacion"] = True
            if fecha is not None and (a["FechaEntrega"] is None or fecha < a["FechaEntrega"]):
                a["FechaEntrega"] = fecha
            if fmov_iso and (a["FechaOC"] is None or fmov_iso < a["FechaOC"]):
                a["FechaOC"] = fmov_iso
            if nro and nro not in a["NroOCs"]:
                a["NroOCs"].append(nro)

            # Lote = esta OC puntual dentro del artículo (a diferencia de los
            # campos de arriba, que agregan TODAS las OC pendientes juntas en
            # un solo pool). Una OC puede tener varios renglones del mismo
            # artículo (poco común) — se suman como Pendiente y se queda con
            # la FechaEntrega más temprana entre ellos, igual criterio que el
            # pool general pero acotado a esta OC.
            lk = (cod, nro or f"__sin_nro_{cod}_{fmov_iso}")
            lote = lotes.get(lk)
            if not lote:
                lote = {
                    "NroOC": nro or None,
                    "FechaOC": fmov_iso,
                    "FechaEntrega": fecha,
                    "Pendiente": 0.0,
                    "Importacion": es_impo,
                    "TipoArticulo": tipo,
                    "Proveedor": prov,
                }
                lotes[lk] = lote
            lote["Pendiente"] += pend
            if fecha is not None and (lote["FechaEntrega"] is None or fecha < lote["FechaEntrega"]):
                lote["FechaEntrega"] = fecha
            if es_impo:
                lote["Importacion"] = True

        for (cod, _nro), lote in lotes.items():
            lote["Pendiente"] = round(lote["Pendiente"], 2)
            agg[cod]["Lotes"].append(lote)

        rows = sorted(agg.values(), key=lambda x: -x["PorLlegar"])
        for r in rows:
            r["PorLlegar"] = round(r["PorLlegar"], 2)
            r["Lotes"].sort(key=lambda l: l["FechaOC"] or "")
        return {
            "total": len(rows),
            "rows": rows,
            "desde": corte.isoformat() if corte else None,
        }
    finally:
        conn.close()


# Renglones de OC HECHAS en un rango (por FecMovim de la cabecera), sin importar
# si ya se recibieron. `{_fecha}` = corte por rango, siempre presente.
SQL_OC_RANGO = """
SELECT
    cab.FecMovim                         AS FecMovim,
    LTRIM(RTRIM(r.CodArticulo))          AS CodArticu,
    r.Cantidad                           AS Cantidad
FROM EVERWEAR.dbo.Com_OrdCompRenglones r
INNER JOIN EVERWEAR.dbo.Com_OrdCompCabecera cab ON cab.NroOrdCompra = r.NroOrdCompra
{_join_tipo}
WHERE cab.FecMovim BETWEEN {_d1} AND {_d2}
  {_excl}
  {_comp}
  {_tipo}
"""


def fetch_ordenes_articulos_rango(desde: str, hasta: str, incluir_fabril: bool = False):
    """Artículos con al menos un renglón de Orden de Compra HECHA en el rango
    [desde, hasta] (por FecMovim de la cabecera) — a diferencia de
    fetch_ordenes_pendientes, ACÁ NO importa si ya se recibió o sigue
    pendiente: solo interesa si la OC se generó ese período.

    Para /compras/metricas (funnel mensual: de los artículos faltantes del
    mes, cuántos tuvieron una OC ese mismo mes). Devuelve los CodArticulo
    distintos Y las unidades pedidas por artículo ("unidades"): el funnel
    ahora muestra items + unidades en cada columna. La cantidad ya venía en
    SQL_OC_RANGO, así que sumarla no agrega ninguna consulta.

    El rango se filtra EN EL SQL (literales int días-Magnus): antes se traía
    toda la OC histórica y se descartaba en Python."""
    d1 = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
    d2 = datetime.strptime(str(hasta)[:10], "%Y-%m-%d").date()

    sql = SQL_OC_RANGO.format(
        _join_tipo=_JOIN_TIPO, _excl=_EXCL, _comp=_COMP,
        _tipo=_cond_tipo(incluir_fabril),
        _d1=_dias(d1), _d2=_dias(d2),
    )

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(sql)
        cols = [c[0] for c in cur.description]

        unidades: dict[str, float] = {}
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            cod = (str(d.get("CodArticu") or "")).strip()
            if not cod:
                continue
            unidades[cod] = unidades.get(cod, 0.0) + float(_safe(d.get("Cantidad")) or 0)

        return {
            "total": len(unidades),
            "articulos": sorted(unidades.keys()),
            "unidades": {c: round(v, 2) for c, v in unidades.items()},
            "totalUnidades": round(sum(unidades.values()), 2),
            "desde": d1.isoformat(),
            "hasta": d2.isoformat(),
        }
    finally:
        conn.close()


# ── Detalle de OC del mes por artículo (export a Excel de /compras) ──────────
# Mismo recorte que SQL_OC_RANGO (FecMovim de la cabecera, sin canceladas, sin
# Genérico/Fabril) pero agrega lo que el funnel no necesita y el Excel sí:
# NÚMERO de OC (CompCentro-CompNumero, como lo imprime Magnus), proveedor,
# descripción del artículo y fecha. Va en un SQL aparte a propósito: SQL_OC_RANGO
# lo usan 2 endpoints "calientes" (/compras/ordenes-mes y /compras/compras-
# valorizado) y no tienen por qué pagar 2 joins más en cada llamada.
SQL_OC_RANGO_DETALLE = """
SELECT
    cab.FecMovim                         AS FecMovim,
    cab.CompCentro                       AS CompCentro,
    cab.CompNumero                       AS CompNumero,
    LTRIM(RTRIM(r.CodArticulo))          AS CodArticu,
    r.Cantidad                           AS Cantidad,
    pr.RazonSocial                       AS Proveedor,
    ap_t.Detalle                         AS Detalle,
    a_t.DetalleMedida                    AS DetalleMedida,
    a_t.UnidadMedida                     AS UnidadMedida
FROM EVERWEAR.dbo.Com_OrdCompRenglones r
INNER JOIN EVERWEAR.dbo.Com_OrdCompCabecera cab ON cab.NroOrdCompra = r.NroOrdCompra
LEFT  JOIN EVERWEAR.dbo.Com_Proveedores     pr  ON pr.CodProveed    = cab.CodProveed
{_join_tipo}
LEFT  JOIN EVERWEAR.dbo.StkFer_ArtParamet   ap_t ON ap_t.ArticuloPatron = a_t.ArticuloPatron
WHERE cab.FecMovim BETWEEN {_d1} AND {_d2}
  {_excl}
  {_comp}
  {_tipo}
"""


def _nro_comp(centro, numero) -> str:
    """CompCentro + CompNumero → '0001-00014700' (formato impreso de Magnus,
    mismo que ingresos.py usa para el número de remito)."""
    try:
        c = int(centro) if centro is not None else 0
    except (TypeError, ValueError):
        c = 0
    try:
        n = int(numero) if numero is not None else 0
    except (TypeError, ValueError):
        n = 0
    return f"{c:04d}-{n:08d}"


def fetch_ordenes_detalle_rango(desde: str, hasta: str, incluir_fabril: bool = False):
    """Igual recorte que fetch_ordenes_articulos_rango, pero agregado por
    artículo CON los números de OC, proveedor, descripción y fecha de la última
    OC. Para el export a Excel de /compras (una fila por artículo).

    Devuelve {"rows": [...]}: CodArticulo, Nombre, Proveedor, CantidadOC,
    NroOCs (lista de '0001-00014700'), FechaUltimaOC."""
    d1 = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
    d2 = datetime.strptime(str(hasta)[:10], "%Y-%m-%d").date()

    sql = SQL_OC_RANGO_DETALLE.format(
        _join_tipo=_JOIN_TIPO, _excl=_EXCL, _comp=_COMP,
        _tipo=_cond_tipo(incluir_fabril),
        _d1=_dias(d1), _d2=_dias(d2),
    )

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(sql)
        cols = [c[0] for c in cur.description]

        agg: dict[str, dict] = {}
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            cod = (str(d.get("CodArticu") or "")).strip()
            if not cod:
                continue
            nro = _nro_comp(d.get("CompCentro"), d.get("CompNumero"))
            fecha = _fecha_entrega(d.get("FecMovim"))
            prov = (str(d.get("Proveedor") or "")).strip() or None
            nombre = " ".join(
                " ".join(
                    (str(d.get(c) or "")).strip()
                    for c in ("Detalle", "DetalleMedida", "UnidadMedida")
                ).split()
            ) or None

            a = agg.get(cod)
            if not a:
                a = {
                    "CodArticulo": cod,
                    "Nombre": nombre,
                    "Proveedor": prov,
                    "CantidadOC": 0.0,
                    "NroOCs": [],
                    "FechaUltimaOC": fecha,
                }
                agg[cod] = a
            a["CantidadOC"] += float(_safe(d.get("Cantidad")) or 0)
            if prov and not a["Proveedor"]:
                a["Proveedor"] = prov
            if nombre and not a["Nombre"]:
                a["Nombre"] = nombre
            if fecha and (not a["FechaUltimaOC"] or fecha > a["FechaUltimaOC"]):
                a["FechaUltimaOC"] = fecha
            if nro and nro not in a["NroOCs"]:
                a["NroOCs"].append(nro)

        rows = sorted(agg.values(), key=lambda x: x["CodArticulo"])
        for r in rows:
            r["CantidadOC"] = round(r["CantidadOC"], 2)
            r["NroOCs"].sort()
        return {
            "total": len(rows),
            "rows": rows,
            "desde": d1.isoformat(),
            "hasta": d2.isoformat(),
        }
    finally:
        conn.close()


def fetch_compras_valorizado(desde: str, hasta: str, incluir_fabril: bool = False):
    """Unidades y $ de las Órdenes de Compra HECHAS en [desde, hasta] (por
    FecMovim de la cabecera) — mismo criterio que fetch_ordenes_articulos_rango
    (no importa si el renglón ya se recibió o sigue pendiente), pero acá SÍ se
    suman cantidades y se valoriza en $.

    El $ NO sale de la OC: Com_OrdCompRenglones no expone acá un costo de
    compra confiable, y aunque lo tuviera, el criterio definido es valorizar a
    precio de VENTA. Se usa el mismo criterio "no hay tabla de lista de precios
    en el proyecto" que ya usa deposito.py (fetch_faltantes_ot,
    /deposito/faltantes): el ÚLTIMO PrecioVenta visto para ese CodArticulo en
    CUALQUIER pedido de Ven_PedRenPendientes. Aproximado a propósito: puede no
    reflejar el precio vigente si cambió después del último pedido con ese
    artículo; los artículos sin ningún PrecioVenta encontrado quedan
    valorizados en 0 y se cuentan en 'articulosSinPrecio'.

    Para el selector de rango libre de /compras, independiente del mes del
    funnel de /compras/metricas.

    El rango se filtra EN EL SQL (literales int días-Magnus)."""
    d1 = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
    d2 = datetime.strptime(str(hasta)[:10], "%Y-%m-%d").date()

    sql = SQL_OC_RANGO.format(
        _join_tipo=_JOIN_TIPO, _excl=_EXCL, _comp=_COMP,
        _tipo=_cond_tipo(incluir_fabril),
        _d1=_dias(d1), _d2=_dias(d2),
    )

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(sql)
        cols = [c[0] for c in cur.description]

        unidades: dict[str, float] = {}
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            cod = (str(d.get("CodArticu") or "")).strip()
            if not cod:
                continue
            cant = float(_safe(d.get("Cantidad")) or 0)
            unidades[cod] = unidades.get(cod, 0.0) + cant

        # Precio de venta por artículo: último PrecioVenta visto en cualquier
        # pedido (Ven_PedRenPendientes), mismo patrón que deposito.py.
        precios: dict[str, float] = {}
        codigos = sorted(unidades.keys())
        if codigos:
            ph = ",".join("?" for _ in codigos)
            sql_precios = f"""
                SELECT CodArticu, PrecioVenta
                FROM (
                    SELECT LTRIM(RTRIM(CodArticu)) AS CodArticu, PrecioVenta,
                           ROW_NUMBER() OVER (
                               PARTITION BY LTRIM(RTRIM(CodArticu))
                               ORDER BY FecRegistracion DESC
                           ) AS rn
                    FROM EVERWEAR.dbo.[Ven_PedRenPendientes]
                    WHERE LTRIM(RTRIM(CodArticu)) IN ({ph})
                ) t
                WHERE rn = 1
            """
            cur.execute(sql_precios, codigos)
            for cod, precio in cur.fetchall():
                precios[(str(cod or "")).strip()] = float(_safe(precio) or 0)

        rows = []
        total_unidades = 0.0
        total_importe = 0.0
        sin_precio = 0
        for cod, cant in unidades.items():
            precio = precios.get(cod)
            if precio is None:
                sin_precio += 1
                precio = 0.0
            importe = round(cant * precio, 2)
            total_unidades += cant
            total_importe += importe
            rows.append({
                "CodArticulo": cod,
                "Cantidad": round(cant, 2),
                "PrecioVenta": precio,
                "Importe": importe,
            })
        rows.sort(key=lambda r: -r["Importe"])

        return {
            "desde": d1.isoformat(),
            "hasta": d2.isoformat(),
            "itemsDistintos": len(unidades),
            "unidadesCompradas": round(total_unidades, 2),
            "montoVenta": round(total_importe, 2),
            "articulosSinPrecio": sin_precio,
            "rows": rows,
        }
    finally:
        conn.close()



# ── Consumo mensual de UN artículo + stock por depósito (/compras/consumo) ────
# Vista pedida 2026-08-11: cod. artículo + rango de MESES →
# vendido por mes, total, promedio (total / meses del rango, incluidos los de
# venta 0), máximo, mínimo > 0, total/máximo, total/mínimo, y stock por
# depósito (1/2/3, EVERWEAR.Stk_ArticSucursalDeposito — mismo criterio que
# /deposito/stock, ver deposito.py ARSU_*).
#
# "Vendido" = CantidadPedida de VenFer_PedidoReng de pedidos VÁLIDOS
# (Cerrado/Facturado, sin la blacklist de CompCodigo) por FechaPedido de la
# cabecera — exactamente el mismo criterio que /ventas/pedidos-mes, pero
# filtrado a un solo CodArticu y agrupado por mes.

# El código va contra la columna CRUDA (r.CodArticu = ?), no contra
# LTRIM(RTRIM(...)): envuelto en funciones el filtro no puede usar el índice
# VF_PEDREN_Cla_Articu y el detalle de un artículo terminaba barriendo la
# tabla de renglones entera. SQL Server ignora los espacios finales al
# comparar CHAR, así que el resultado es el mismo.
SQL_CONSUMO_ARTICULO = """
SELECT
    cab.FechaPedido                       AS FechaPedido,
    cab.CompCodigo                        AS CompCodigo,
    est.Ped_EstadoDescripcion             AS Estado,
    r.CantidadPedida                      AS Cantidad
FROM EVERWEAR.dbo.VenFer_PedidoReng r
INNER JOIN EVERWEAR.dbo.VenFer_PedidoCabecera cab ON cab.NroMovVenta = r.NroMovVenta
LEFT  JOIN MAGNUS_SITD.dbo.Pedido_Estados     est ON cab.EstadoPedido = est.Ped_Estado
WHERE r.CodArticu = ?
  AND cab.FechaPedido BETWEEN ? AND ?
"""

# Depósitos fijos 1/2/3 — mismos IDs confirmados que usa /deposito/stock
# (deposito.py DEPOSITOS). Se repiten acá para no importar media tabla de
# constantes; si algún día se agrega un depósito, actualizar en ambos lados.
CONSUMO_DEPOSITOS = (1, 2, 3)

# Mismo criterio que arriba: columna cruda para poder entrar por el índice
# agrupado (CodArticulo, CodSucursal, Deposito) en vez de barrer la tabla.
# Dos variantes del código en vez de LTRIM(): ver _variantes_cod.
SQL_STOCK_ARTICULO = """
SELECT a.Deposito, SUM(a.StkReal) AS Stock
FROM EVERWEAR.dbo.Stk_ArticSucursalDeposito a
WHERE a.CodArticulo IN (?, ?)
  AND a.Deposito IN (1, 2, 3)
GROUP BY a.Deposito
"""

SQL_NOMBRE_ARTICULO = """
SELECT TOP 1 ap.Detalle, s.DetalleMedida, s.UnidadMedida
FROM EVERWEAR.dbo.[StkFer_Articulos] s
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
WHERE s.CodArticulo IN (?, ?)
"""


def _variantes_cod(cod: str) -> list[str]:
    """El código tal cual y con un espacio adelante.

    Comparar con LTRIM(RTRIM(col)) = ? anula el índice y obliga a barrer la
    tabla entera (3,7 M de renglones, 558 mil filas de stock, 41 mil
    artículos) para buscar UN código. Comparando contra la columna cruda entra
    por índice, y el padding de la derecha no molesta porque SQL Server lo
    ignora al comparar CHAR. Lo único que se perdía era el puñado de códigos
    del catálogo cargados con un espacio ADELANTE (hoy 2 artículos), así que
    se buscan las dos formas: las dos siguen siendo búsquedas por índice."""
    c = (cod or "").strip()
    return [c, " " + c]


def _meses_rango(desde: str, hasta: str) -> list[str]:
    """['2026-03', '2026-04', ...] entre desde y hasta (YYYY-MM, inclusive)."""
    y1, m1 = int(desde[:4]), int(desde[5:7])
    y2, m2 = int(hasta[:4]), int(hasta[5:7])
    if (y1, m1) > (y2, m2):
        (y1, m1), (y2, m2) = (y2, m2), (y1, m1)
    out = []
    y, m = y1, m1
    while (y, m) <= (y2, m2):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def fetch_consumo_articulo(codigo: str, desde: str, hasta: str):
    """Consumo mensual de `codigo` en el rango de meses [desde, hasta]
    (formato YYYY-MM) + stock actual por depósito.

    Devuelve SIEMPRE un bucket por cada mes del rango (cantidad 0 si no se
    vendió) — el promedio divide por la cantidad de meses del rango, no por
    los meses con venta. FechaPedido es int días-Magnus (BASE_DATE), así que
    el rango se filtra directo en SQL como enteros (mismo patrón que
    fetch_pedidos_mes)."""
    cod = (codigo or "").strip()
    if not cod:
        raise ValueError("codigo vacío")

    meses = _meses_rango(str(desde)[:7], str(hasta)[:7])
    y1, m1 = int(meses[0][:4]), int(meses[0][5:7])
    y2, m2 = int(meses[-1][:4]), int(meses[-1][5:7])
    d1 = date(y1, m1, 1)
    d2 = (date(y2 + 1, 1, 1) if m2 == 12 else date(y2, m2 + 1, 1)) - timedelta(days=1)
    d1n = (d1 - BASE_DATE).days
    d2n = (d2 - BASE_DATE).days

    por_mes: dict[str, float] = {m: 0.0 for m in meses}
    nombre = None
    stock_por_dep: dict[int, float] = {d: 0.0 for d in CONSUMO_DEPOSITOS}

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute(SQL_CONSUMO_ARTICULO, (cod, d1n, d2n))
        cols = [c[0] for c in cur.description]
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            try:
                comp = int(d.get("CompCodigo")) if d.get("CompCodigo") is not None else None
            except (TypeError, ValueError):
                comp = None
            if comp in COMP_CODIGOS_EXCLUIDOS:
                continue
            if not _es_valido(d.get("Estado")):
                continue
            fec = _to_date(d.get("FechaPedido"))
            if fec is None:
                continue
            key = f"{fec.year:04d}-{fec.month:02d}"
            if key not in por_mes:
                continue
            por_mes[key] += float(_safe(d.get("Cantidad")) or 0)

        # Nombre del artículo (para confirmar en la vista que el código existe)
        cur.execute(SQL_NOMBRE_ARTICULO, _variantes_cod(cod))
        row = cur.fetchone()
        if row:
            nombre = " ".join(
                " ".join(str(_safe(x) or "").strip() for x in row).split()
            ) or None

        # Stock actual por depósito (1/2/3)
        cur.execute(SQL_STOCK_ARTICULO, _variantes_cod(cod))
        for dep, stk in cur.fetchall():
            try:
                dep_i = int(dep)
            except (TypeError, ValueError):
                continue
            if dep_i in stock_por_dep:
                stock_por_dep[dep_i] = float(_safe(stk) or 0)
    finally:
        conn.close()

    cantidades = [round(por_mes[m], 2) for m in meses]
    total = round(sum(cantidades), 2)
    n_meses = len(meses)
    promedio = round(total / n_meses, 2) if n_meses else 0.0
    maximo = max(cantidades) if cantidades else 0.0
    positivos = [c for c in cantidades if c > 0]
    minimo = min(positivos) if positivos else None
    return {
        "codigo": cod,
        "nombre": nombre,
        "desde": meses[0],
        "hasta": meses[-1],
        "mesesEnRango": n_meses,
        "meses": [{"mes": m, "cantidad": round(por_mes[m], 2)} for m in meses],
        "totalVendido": total,
        "promedio": promedio,
        "maximo": maximo,
        "totalSobreMaximo": round(total / maximo, 2) if maximo > 0 else None,
        "minimo": minimo,
        "totalSobreMinimo": round(total / minimo, 2) if minimo else None,
        "stock": {
            "porDeposito": [
                {"deposito": d, "stock": round(stock_por_dep[d], 2)}
                for d in CONSUMO_DEPOSITOS
            ],
            "total": round(sum(stock_por_dep.values()), 2),
        },
    }


# ── Consumo mensual de TODOS los artículos + stock (vista "Tabla") ───────────
# 2026-08-11 (mismo día que fetch_consumo_articulo, arriba):
# botón en /compras/consumo para alternar de "un artículo" a una TABLA con
# todos los artículos del rango, una fila por artículo, paginada de a 20 y
# ordenable por Código/Stock/Vendido/Promedio/Máximo/Mínimo en el front.
#
# Mismo criterio de "vendido" y de stock que fetch_consumo_articulo, pero sin
# filtrar por CodArticu — se trae TODO el rango, agrupado por artículo+mes
# (ver NOTA rendimiento abajo). Solo se listan artículos con alguna venta en
# el rango O con stock actual > 0 en algún depósito (evita listar SKUs de
# baja sin stock ni movimiento).
#
# SOLO NACIONALES (2026-09-07): todo lo que suma esta vista —
# artículos, líneas, stock y el datalist de líneas — se recorta a artículos de
# tipo Nacional (StkFer_Articulos.NacionalImportado → Stk_TiposArticulos.
# Descripcion = 'Nacional'). Criterio de origenArticulo.ts, NO el de
# _cond_tipo de este archivo: Original, Importado y Fabril quedan afuera.
# Verificado en la base: los 41.219 artículos del catálogo tienen SIEMPRE un
# tipo cargado (21.012 Nacional, 7.035 Fabril, 6.604 Original, 6.555
# Importado, 13 Generico), así que el INNER JOIN no pierde filas por tipo
# nulo y no hace falta el ISNULL(..., 'Nacional') que usa el resto del
# archivo. El join va char = char sin LTRIM/RTRIM para que use índice (SQL
# Server ignora los espacios finales al comparar).
_JOIN_NACIONAL_RENG = """
INNER JOIN EVERWEAR.dbo.StkFer_Articulos   s_n ON s_n.CodArticulo = r.CodArticu
INNER JOIN EVERWEAR.dbo.Stk_TiposArticulos t_n ON t_n.CodigoTipo  = s_n.NacionalImportado
"""
_JOIN_NACIONAL_STOCK = """
INNER JOIN EVERWEAR.dbo.StkFer_Articulos   s_n ON s_n.CodArticulo = a.CodArticulo
INNER JOIN EVERWEAR.dbo.Stk_TiposArticulos t_n ON t_n.CodigoTipo  = s_n.NacionalImportado
"""
_COND_NACIONAL = "AND t_n.Descripcion = 'Nacional'"

# Joins al catálogo de líneas (Nivel1). Se agregan SOLO cuando hay filtro de
# línea: sin filtro son dos joins por fila que no se usan para nada.
_JOIN_LINEA_ART = """
LEFT  JOIN EVERWEAR.dbo.[StkFer_ArtParamet]   ap ON ap.ArticuloPatron = s_n.ArticuloPatron
LEFT  JOIN EVERWEAR.dbo.[Stk_Nivel1]          n1 ON n1.Nivel1         = ap.Nivel1
"""

# Artículos sin Nivel1 resuelto: mismo rótulo que usa el dashboard /compras
# para no inventar una etiqueta nueva por vista.
LINEA_SIN_ASIGNAR = "SIN LÍNEA"

# ── Criterio de "pedido válido" resuelto a CÓDIGOS de estado ─────────────────
# _es_valido() compara la DESCRIPCIÓN del estado (Cerrado/Facturado), lo que
# obligaba a arrastrar el join a MAGNUS_SITD.dbo.Pedido_Estados y a filtrar en
# Python fila por fila. Pedido_Estados tiene 8 filas y no cambia, así que se
# resuelve UNA VEZ por proceso a la lista de Ped_Estado que pasan _es_valido y
# después se filtra en SQL con `cab.EstadoPedido IN (...)`.
#
# El criterio no cambia: los códigos salen de aplicar _es_valido a las mismas
# descripciones que antes se evaluaban en Python. Ganancia doble — se cae el
# join entre bases y el GROUP BY puede dejar de arrastrar CompCodigo/Estado,
# que era lo que multiplicaba las filas que viajaban a Python.
_ESTADOS_VALIDOS_CACHE: tuple[int, ...] | None = None

SQL_PEDIDO_ESTADOS = """
SELECT Ped_Estado, Ped_EstadoDescripcion FROM MAGNUS_SITD.dbo.Pedido_Estados
"""


def _estados_validos(cur) -> tuple[int, ...]:
    """Códigos de Ped_Estado cuya descripción pasa _es_valido, cacheados."""
    global _ESTADOS_VALIDOS_CACHE
    if _ESTADOS_VALIDOS_CACHE is None:
        cur.execute(SQL_PEDIDO_ESTADOS)
        codigos = []
        for cod, desc in cur.fetchall():
            if cod is None or not _es_valido(desc):
                continue
            try:
                codigos.append(int(cod))
            except (TypeError, ValueError):
                continue
        _ESTADOS_VALIDOS_CACHE = tuple(sorted(codigos))
    return _ESTADOS_VALIDOS_CACHE


def _cond_pedido_valido(cur) -> str:
    """Fragmento de WHERE con el criterio completo de "pedido válido":
    blacklist de comprobantes + estados Cerrado/Facturado. Son enteros
    resueltos del propio catálogo, nunca texto del cliente."""
    estados = _estados_validos(cur)
    cond = ""
    if COMP_CODIGOS_EXCLUIDOS:
        cond += f"\n  AND cab.CompCodigo NOT IN ({','.join(str(c) for c in COMP_CODIGOS_EXCLUIDOS)})"
    # Sin estados válidos no hay venta posible: 1 = 0 corta la consulta en vez
    # de devolver todo.
    cond += (
        f"\n  AND cab.EstadoPedido IN ({','.join(str(e) for e in estados)})"
        if estados else "\n  AND 1 = 0"
    )
    return cond


# ── Cache en proceso de las tablas de consumo ────────────────────────────────
# Ordenar por otra columna o pasar de página NO cambia el universo consultado:
# el backend calcula la misma lista de métricas y recién después ordena y
# recorta. Antes cada clic en un encabezado o en "siguiente" volvía a barrer
# ventas y stock enteros; ahora el resultado del cálculo se guarda en memoria
# con clave (rango, q, línea, exacta) y esos clics no tocan la base.
#
# TTL corto y explícito: la vista mira meses cerrados, pero el stock es de
# hoy. El botón "Refrescar" manda fresh=1 y saltea la lectura del cache (igual
# reescribe la entrada), así que siempre hay una forma de forzar datos nuevos.
_CACHE_TTL_SEG = 120
_CACHE_MAX = 32
_cache_consumo: "OrderedDict[tuple, tuple[float, object]]" = OrderedDict()
_cache_lock = Lock()


def _cache_leer(clave: tuple):
    """Valor cacheado y no vencido, o None."""
    with _cache_lock:
        item = _cache_consumo.get(clave)
        if item is None:
            return None
        guardado, valor = item
        if monotonic() - guardado > _CACHE_TTL_SEG:
            _cache_consumo.pop(clave, None)
            return None
        _cache_consumo.move_to_end(clave)
        return valor


def _cache_guardar(clave: tuple, valor):
    with _cache_lock:
        _cache_consumo[clave] = (monotonic(), valor)
        _cache_consumo.move_to_end(clave)
        while len(_cache_consumo) > _CACHE_MAX:
            _cache_consumo.popitem(last=False)

# NOTA rendimiento (2026-08-12, timeout real reportado): traer CADA
# renglón de pedido de TODA la empresa para sumar en Python era demasiado
# lento (>45s, nunca llegaba a responder). El SUM se hace en SQL Server.
#
# Segunda vuelta de rendimiento: el recorte también se hace
# ENTERO EN SQL. Antes la consulta agregaba SIEMPRE toda la empresa (con
# CompCodigo y Estado en el GROUP BY, que multiplicaban las filas) y recién en
# Python se descartaban comprobantes, estados y los artículos que no eran de
# la línea pedida. Medido sobre 7 meses: 25.049 filas de ventas + 286.451 de
# stock viajaban a Python en CADA request; con el filtro de línea abajo (línea
# más grande del catálogo, 4.517 artículos) son 1.999 + 4.517. El criterio de
# "vendido" es idéntico, verificado contra la base: mismas unidades totales
# filtrando por descripción de estado en Python que por código en SQL.
#
# `{{valido}}` (comprobantes + estados), `{{q}}`, `{{linea}}` y `{{join_linea}}`
# los completa fetch_consumo_articulos; el texto del cliente viaja siempre como
# parámetro. El GROUP BY va por r.CodArticu crudo, sin LTRIM/RTRIM, para que
# pueda agrupar por índice — SQL Server ignora los espacios finales al
# comparar y el trim se hace al leer en Python. Año/mes se reconstruyen con
# DATEADD a partir del mismo FechaPedido int-días-desde-1800-12-28 que ya usa
# el resto de este archivo.
SQL_CONSUMO_TODOS = f"""
SELECT
    r.CodArticu                                                   AS CodArticu,
    DATEPART(year,  DATEADD(day, cab.FechaPedido, '1800-12-28'))  AS Anio,
    DATEPART(month, DATEADD(day, cab.FechaPedido, '1800-12-28'))  AS Mes,
    SUM(r.CantidadPedida)                                         AS Cantidad
FROM EVERWEAR.dbo.VenFer_PedidoReng r
INNER JOIN EVERWEAR.dbo.VenFer_PedidoCabecera cab ON cab.NroMovVenta = r.NroMovVenta
{_JOIN_NACIONAL_RENG}
{{join_linea}}
WHERE cab.FechaPedido BETWEEN ? AND ?
  {_COND_NACIONAL}
  {{valido}}
  {{q}}
  {{linea}}
GROUP BY r.CodArticu,
         DATEPART(year,  DATEADD(day, cab.FechaPedido, '1800-12-28')),
         DATEPART(month, DATEADD(day, cab.FechaPedido, '1800-12-28'))
"""

# Stock ya sumado por artículo: la vista de artículos muestra el stock TOTAL,
# nunca la apertura por depósito (esa es la vista de un solo artículo), así
# que traer una fila por artículo+depósito era traer 14 filas para sumar 3.
# Con `Deposito IN (1,2,3)` y el SUM en SQL, las 286.451 filas del catálogo
# nacional bajan a 21.014 sin filtro de línea — y a las de la línea con él.
SQL_STOCK_TODOS = f"""
SELECT a.CodArticulo AS CodArticulo, SUM(a.StkReal) AS Stock
FROM EVERWEAR.dbo.Stk_ArticSucursalDeposito a
{_JOIN_NACIONAL_STOCK}
{{join_linea}}
WHERE a.Deposito IN ({','.join(str(d) for d in CONSUMO_DEPOSITOS)})
  {_COND_NACIONAL}
  {{q}}
  {{linea}}
GROUP BY a.CodArticulo
"""

# El IN va contra la columna cruda para que entre por el índice agrupado de
# StkFer_Articulos: con LTRIM(RTRIM(...)) buscar 20 nombres barría las 41.000
# filas del catálogo. Cada código se manda en sus dos variantes (ver
# _variantes_cod). El SELECT sí devuelve el código trimmeado, que es la clave
# con la que se arman las filas en Python.
SQL_NOMBRES_CHUNK = """
SELECT LTRIM(RTRIM(s.CodArticulo)) AS CodArticulo, ap.Detalle, s.DetalleMedida, s.UnidadMedida
FROM EVERWEAR.dbo.[StkFer_Articulos] s
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
WHERE s.CodArticulo IN ({ph})
"""

# Línea = NOMBRE en EVERWEAR.dbo.Stk_Nivel1.Detalle, resuelto desde el CÓDIGO
# StkFer_ArtParamet.Nivel1 (int) — ver el bloque de catálogo en ventas.py.
# Antes esto filtraba y mostraba el Nivel1 crudo, o sea el número.
#
# El filtro se arma como fragmento de WHERE y se aplica DENTRO de las
# consultas de ventas y de stock (junto con _JOIN_LINEA_ART). Antes se
# resolvía aparte el universo de códigos de la línea y se intersectaba en
# Python contra todo el catálogo ya agregado: se agregaba la empresa entera
# para después tirar el 95%.
def _cond_linea(linea: str, exacta: bool) -> tuple[str, list]:
    """Fragmento de WHERE + parámetros para filtrar por línea sobre
    LTRIM(RTRIM(n1.Detalle)). Devuelve ("", []) si no hay línea.

    Dos modos (2026-09-07, al armar el drill-down
    Líneas → Artículos → Detalle de /compras/consumo):
      · `exacta=False` — substring (LIKE %...%). Es lo que escribe el usuario
        a mano en el input de línea.
      · `exacta=True`  — igualdad. Lo usa el drill-down, donde el nombre sale
        de una fila real y no de lo tipeado: con LIKE, entrar a una línea cuyo
        nombre es prefijo de otra arrastraría los artículos de las dos.
        `LINEA_SIN_ASIGNAR` no es un nombre del catálogo sino el rótulo de los
        artículos sin Nivel1 resuelto, así que ahí se filtra por NULL/vacío.

    El texto del usuario nunca se interpola: siempre viaja como parámetro."""
    if not linea:
        return "", []
    if not exacta:
        return "AND LTRIM(RTRIM(n1.Detalle)) LIKE ?", [f"%{linea}%"]
    if linea == LINEA_SIN_ASIGNAR:
        return "AND (n1.Detalle IS NULL OR LTRIM(RTRIM(n1.Detalle)) = '')", []
    return "AND LTRIM(RTRIM(n1.Detalle)) = ?", [linea]

# Líneas del catálogo con cantidad de artículos en cada una — para el
# datalist del input "línea" de /compras/consumo (
# 2026-08-12): así se ve en la propia vista cuántos artículos hay por línea,
# sin tener que adivinar de antemano si conviene dropdown o texto libre.
#
# 2026-09-07: cuenta SOLO artículos nacionales, para que el número del
# datalist sea el mismo universo que después suman las tablas de artículos y
# de líneas (antes decía "N artículo(s)" contando importados y fabriles que
# la vista nunca iba a mostrar).
SQL_LINEAS_COUNT = """
SELECT LTRIM(RTRIM(n1.Detalle)) AS Linea, COUNT(DISTINCT s.CodArticulo) AS Cantidad
FROM EVERWEAR.dbo.[StkFer_Articulos] s
INNER JOIN EVERWEAR.dbo.[Stk_TiposArticulos] t_n ON t_n.CodigoTipo    = s.NacionalImportado
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]        n1 ON n1.Nivel1         = ap.Nivel1
WHERE t_n.Descripcion = 'Nacional'
GROUP BY LTRIM(RTRIM(n1.Detalle))
"""


def fetch_lineas():
    """Líneas (nombre de Stk_Nivel1) con cantidad de artículos del catálogo en
    cada una, ordenadas de mayor a menor. Ver SQL_LINEAS_COUNT."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_LINEAS_COUNT)
        rows = []
        for linea, cant in cur.fetchall():
            nombre = (str(linea or "")).strip()
            if not nombre:
                continue
            rows.append({"linea": nombre, "cantidadArticulos": int(cant or 0)})
        rows.sort(key=lambda r: -r["cantidadArticulos"])
        return {"total": len(rows), "lineas": rows}
    finally:
        conn.close()


# Columnas ordenables desde el front (whitelist — nunca se interpola el sort
# del cliente directo en SQL/Python, se mapea contra esto).
_SORT_KEYS = ("codigo", "stock", "totalVendido", "promedio", "maximo", "minimo")


def _fragmentos_filtro(q_norm: str, linea_norm: str, linea_exacta: bool,
                       col_q: str) -> tuple[str, str, str, list]:
    """(join_linea, frag_q, frag_linea, params) para armar las consultas de
    consumo con el filtro ya aplicado en SQL.

    `col_q` es la columna de código de la tabla que se está filtrando
    (`r.CodArticu` en ventas, `a.CodArticulo` en stock). El texto del cliente
    nunca se interpola: viaja como parámetro."""
    frag_q = f"AND {col_q} LIKE ?" if q_norm else ""
    frag_linea, params_linea = _cond_linea(linea_norm, linea_exacta)
    join_linea = _JOIN_LINEA_ART if linea_norm else ""
    params: list = []
    if q_norm:
        params.append(f"%{q_norm}%")
    params.extend(params_linea)
    return join_linea, frag_q, frag_linea, params


def _metricas_articulos(cur, meses, meses_set, n_meses, d1n, d2n,
                        q_norm, linea_norm, linea_exacta):
    """Una fila de métricas por artículo (sin nombre, sin ordenar, sin
    paginar) para el universo que matchea `q`/`linea`.

    Es la parte cara de fetch_consumo_articulos y la que se cachea: no
    depende del orden ni de la página pedida."""
    cond_valido = _cond_pedido_valido(cur)

    join_v, frag_qv, frag_lv, params_v = _fragmentos_filtro(
        q_norm, linea_norm, linea_exacta, "r.CodArticu")
    join_s, frag_qs, frag_ls, params_s = _fragmentos_filtro(
        q_norm, linea_norm, linea_exacta, "a.CodArticulo")

    ventas: dict[str, dict[str, float]] = {}
    stock: dict[str, float] = {}

    cur.execute(
        SQL_CONSUMO_TODOS.format(
            join_linea=join_v, valido=cond_valido, q=frag_qv, linea=frag_lv),
        [d1n, d2n] + params_v,
    )
    for cod, anio, mes_n, cant in cur.fetchall():
        cod = (str(cod or "")).strip()
        if not cod:
            continue
        try:
            key = f"{int(anio):04d}-{int(mes_n):02d}"
        except (TypeError, ValueError):
            continue
        if key not in meses_set:
            continue
        m = ventas.get(cod)
        if m is None:
            m = {mes: 0.0 for mes in meses}
            ventas[cod] = m
        m[key] += float(_safe(cant) or 0)

    cur.execute(
        SQL_STOCK_TODOS.format(join_linea=join_s, q=frag_qs, linea=frag_ls),
        params_s,
    )
    for cod, stk in cur.fetchall():
        cod = (str(cod or "")).strip()
        if not cod:
            continue
        stock[cod] = stock.get(cod, 0.0) + float(_safe(stk) or 0)

    # El filtro de código ya lo aplicó SQL (LIKE, collation CI = el .lower()
    # de antes). Se repite acá sobre una lista chica por si el padding de los
    # CHAR de Magnus hiciera entrar algo de más.
    codigos = sorted(set(ventas.keys()) | set(stock.keys()))
    ql = q_norm.lower()
    if ql:
        codigos = [c for c in codigos if ql in c.lower()]

    metrics = []
    for cod in codigos:
        ventas_cod = ventas.get(cod)
        cantidades = [round(ventas_cod[m], 2) for m in meses] if ventas_cod else [0.0] * n_meses
        total = round(sum(cantidades), 2)
        promedio = round(total / n_meses, 2) if n_meses else 0.0
        maximo = max(cantidades) if cantidades else 0.0
        positivos = [c for c in cantidades if c > 0]
        minimo = min(positivos) if positivos else None
        metrics.append({
            "codigo": cod,
            "totalVendido": total,
            "promedio": promedio,
            "maximo": maximo,
            "minimo": minimo,
            "stock": round(stock.get(cod, 0.0), 2),
        })
    return metrics


def fetch_consumo_articulos(
    desde: str,
    hasta: str,
    sort: str = "totalVendido",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 20,
    q: str | None = None,
    linea: str | None = None,
    linea_exacta: bool = False,
    export: bool = False,
    fresh: bool = False,
):
    """Igual que fetch_consumo_articulo pero para TODOS los artículos a la
    vez: vendido por mes, total, promedio, máximo, mínimo > 0 y stock actual
    (1+2+3), uno por artículo — ORDENADO Y PAGINADO EN EL SERVIDOR (de a
    `page_size`, default 20).

    SOLO ARTÍCULOS NACIONALES (2026-09-07, ver _COND_NACIONAL): tanto las
    ventas como el stock se recortan en SQL a tipo 'Nacional'. Importados,
    Originales y Fabriles no suman ni aparecen como fila.

    `export=True` (para el botón "Exportar Excel" de /compras/consumo, 2026-08-12) devuelve TODOS los artículos que matchean el filtro
    de una sola vez, sin paginar — y exige `linea` (no alcanza con `q`): sin
    esa exigencia, exportar por código de forma amplia podría volcar a Excel
    una porción enorme del catálogo por accidente. El nombre de cada artículo
    (la parte pesada) se resuelve igual que en la vista paginada, pero en
    chunks (ver CHUNK_NOMBRES abajo) porque acá la lista de códigos no está
    acotada a `page_size`.

    `q` (código, substring) y `linea` (StkFer_ArtParamet.Nivel1, substring) se
    combinan con AND cuando vienen los dos, pero ninguno es obligatorio por
    separado — CON UNA SALVEDAD (2026-08-12): hace falta AL
    MENOS UNO de los dos. Sin ningún filtro esto agregaría en SQL las ventas y
    el stock de TODO el catálogo — exactamente el escenario que ya tiró abajo
    el proceso una vez (ver NOTA rendimiento más abajo) — así que se corta
    ACÁ, antes de tocar la base, en vez de confiar solo en que el front no
    dispare el fetch.

    NOTA (2026-08-12, segundo incidente real): la primera versión traía el
    catálogo COMPLETO (nombre incluido) en cada respuesta y el front paginaba
    en el navegador — con un catálogo grande eso tira abajo el proceso
    (killed a mitad de respuesta, sin log de uvicorn: 'other side closed').
    Ahora los números (vendido/promedio/máximo/mínimo/stock) SÍ se calculan
    para todo el universo filtrado — hace falta para poder ordenar
    correctamente — pero eso es liviano (son floats, no texto). El nombre del
    artículo (join a StkFer_Articulos) se busca SOLO para los `page_size`
    códigos de la página pedida, así la respuesta nunca crece con el tamaño
    del catálogo.

    `fresh=True` saltea el cache de métricas (lo manda el botón "Refrescar"):
    ordenar por otra columna o pasar de página reusa el cálculo cacheado y no
    vuelve a consultar la base — ver _cache_leer/_cache_guardar."""
    q_norm = (q or "").strip()
    linea_norm = (linea or "").strip()
    if not q_norm and not linea_norm:
        raise ValueError("Ingresá 'q' (código) o 'linea' para buscar")
    if export and not linea_norm:
        raise ValueError("Elegí una línea para exportar")

    meses = _meses_rango(str(desde)[:7], str(hasta)[:7])
    y1, m1 = int(meses[0][:4]), int(meses[0][5:7])
    y2, m2 = int(meses[-1][:4]), int(meses[-1][5:7])
    d1 = date(y1, m1, 1)
    d2 = (date(y2 + 1, 1, 1) if m2 == 12 else date(y2, m2 + 1, 1)) - timedelta(days=1)
    d1n = (d1 - BASE_DATE).days
    d2n = (d2 - BASE_DATE).days
    n_meses = len(meses)
    meses_set = set(meses)

    sort = sort if sort in _SORT_KEYS else "totalVendido"
    reverse = str(sort_dir).lower() != "asc"
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 20), 200))  # tope defensivo

    # Las métricas de TODO el universo filtrado (sin ordenar ni paginar) son
    # lo caro y no dependen de sort/page: se cachean con clave (rango, filtro)
    # para que ordenar por otra columna o pasar de página no vuelva a la base.
    clave_cache = ("articulos", d1n, d2n, q_norm.lower(), linea_norm.lower(), bool(linea_exacta))
    metrics = None if fresh else _cache_leer(clave_cache)

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        if metrics is None:
            metrics = _metricas_articulos(
                cur, meses, meses_set, n_meses, d1n, d2n,
                q_norm, linea_norm, linea_exacta,
            )
            _cache_guardar(clave_cache, metrics)
        # Ordenar y paginar: sobre una COPIA de la lista cacheada, y cada fila
        # de la página se copia antes de pegarle el nombre — así el cache
        # guarda siempre métricas puras, reutilizables con cualquier orden.
        ordenadas = list(metrics)
        if sort == "codigo":
            ordenadas.sort(key=lambda r: r["codigo"], reverse=reverse)
        else:
            ordenadas.sort(key=lambda r: (r[sort] if r[sort] is not None else -1), reverse=reverse)

        total_items = len(ordenadas)
        if export:
            # Sin paginar — TODOS los artículos filtrados, de una vez (ver
            # docstring: exige `linea`, gateado más arriba).
            page = 1
            page_size = total_items or 1
            total_pages = 1
            page_rows = [dict(r) for r in ordenadas]
        else:
            total_pages = max(1, -(-total_items // page_size))  # ceil
            page = min(page, total_pages)
            start = (page - 1) * page_size
            page_rows = [dict(r) for r in ordenadas[start:start + page_size]]

        # Nombre del artículo: para export, TODOS los códigos filtrados; si
        # no, solo los de esta página (máx. page_size) — es la parte pesada
        # (join a StkFer_Articulos/StkFer_ArtParamet). Se pide en chunks
        # (tope defensivo de parámetros por consulta a SQL Server) en vez de
        # un solo IN gigante — relevante sobre todo para export, donde la
        # lista de códigos no está acotada a 200.
        page_codes = [r["codigo"] for r in page_rows]
        nombres: dict[str, str] = {}
        CHUNK_NOMBRES = 500
        for i in range(0, len(page_codes), CHUNK_NOMBRES):
            batch = page_codes[i:i + CHUNK_NOMBRES]
            # Dos variantes por código (ver _variantes_cod), de ahí el x2 en
            # los placeholders — el chunk sigue lejos del tope de parámetros.
            valores = [v for c in batch for v in _variantes_cod(c)]
            ph = ",".join("?" for _ in valores)
            cur.execute(SQL_NOMBRES_CHUNK.format(ph=ph), valores)
            for cod, detalle, dmed, umed in cur.fetchall():
                cod = (str(cod or "")).strip()
                nombre = " ".join(
                    " ".join(str(_safe(x) or "").strip() for x in (detalle, dmed, umed)).split()
                ) or None
                if nombre:
                    nombres[cod] = nombre
        for r in page_rows:
            r["nombre"] = nombres.get(r["codigo"])
    finally:
        conn.close()

    return {
        "desde": meses[0],
        "hasta": meses[-1],
        "mesesEnRango": n_meses,
        "total": total_items,
        "page": page,
        "pageSize": page_size,
        "totalPages": total_pages,
        "sort": sort,
        "sortDir": "asc" if not reverse else "desc",
        "articulos": page_rows,
    }


# ── Consumo mensual por LÍNEA + stock (vista "Líneas" de /compras/consumo) ───
# 2026-09-07: mismo tablero que la vista "Artículos", pero con
# la línea (Stk_Nivel1.Detalle) como unidad en vez del artículo — vendido,
# promedio mensual, máximo, mínimo > 0, stock actual y coberturas.
#
# La agrupación se hace ENTERA EN SQL por (línea, año, mes): no se pasa por el
# artículo intermedio ni se resuelve la línea de cada código en Python (que
# sería un dict de decenas de miles de entradas).
#
# CompCodigo y Estado salieron del GROUP BY: el criterio de
# "pedido válido" (blacklist de comprobantes + Cerrado/Facturado) se aplica en
# el WHERE con _cond_pedido_valido, así que ya no hay que arrastrar una fila
# por combinación de comprobante y estado ni el join a MAGNUS_SITD. Mismo
# criterio, verificado contra la base; menos de la mitad de filas viajando.
#
# Máximo/mínimo son del MES DE LA LÍNEA COMPLETA (la suma de todos sus
# artículos en ese mes), no el máximo de sus artículos — es la lectura que
# tiene sentido para decidir compras por línea.
#
# {q}, {linea} y {valido} los completa fetch_consumo_lineas con los filtros
# aplicados (parametrizados, nunca interpolados).
SQL_CONSUMO_LINEAS = f"""
SELECT
    ISNULL(NULLIF(LTRIM(RTRIM(n1.Detalle)), ''), '{LINEA_SIN_ASIGNAR}')  AS Linea,
    DATEPART(year,  DATEADD(day, cab.FechaPedido, '1800-12-28'))         AS Anio,
    DATEPART(month, DATEADD(day, cab.FechaPedido, '1800-12-28'))         AS Mes,
    SUM(r.CantidadPedida)                                                 AS Cantidad
FROM EVERWEAR.dbo.VenFer_PedidoReng r
INNER JOIN EVERWEAR.dbo.VenFer_PedidoCabecera cab ON cab.NroMovVenta = r.NroMovVenta
{_JOIN_NACIONAL_RENG}
{_JOIN_LINEA_ART}
WHERE cab.FechaPedido BETWEEN ? AND ?
  {_COND_NACIONAL}
  {{valido}}
  {{q}}
  {{linea}}
GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(n1.Detalle)), ''), '{LINEA_SIN_ASIGNAR}'),
         DATEPART(year,  DATEADD(day, cab.FechaPedido, '1800-12-28')),
         DATEPART(month, DATEADD(day, cab.FechaPedido, '1800-12-28'))
"""

# Stock actual por línea (depósitos 1/2/3) + cuántos artículos nacionales
# tiene cada una. Se cuenta sobre Stk_ArticSucursalDeposito y no sobre el
# catálogo entero porque la fila de la tabla habla del stock: "artículos" acá
# es "artículos nacionales de la línea con registro de stock", que es el
# universo que suma la columna Stock.
SQL_STOCK_LINEAS = f"""
SELECT
    ISNULL(NULLIF(LTRIM(RTRIM(n1.Detalle)), ''), '{LINEA_SIN_ASIGNAR}')  AS Linea,
    COUNT(DISTINCT a.CodArticulo)                                        AS Articulos,
    SUM(a.StkReal)                                                       AS Stock
FROM EVERWEAR.dbo.Stk_ArticSucursalDeposito a
{_JOIN_NACIONAL_STOCK}
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s_n.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]        n1 ON n1.Nivel1         = ap.Nivel1
WHERE a.Deposito IN ({','.join(str(d) for d in CONSUMO_DEPOSITOS)})
  {_COND_NACIONAL}
  {{q}}
  {{linea}}
GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(n1.Detalle)), ''), '{LINEA_SIN_ASIGNAR}')
"""

_SORT_KEYS_LINEAS = ("linea", "stock", "totalVendido", "promedio", "maximo", "minimo")


def fetch_consumo_lineas(
    desde: str,
    hasta: str,
    sort: str = "totalVendido",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 20,
    q: str | None = None,
    linea: str | None = None,
    linea_exacta: bool = False,
    export: bool = False,
    fresh: bool = False,
):
    """Misma tabla que fetch_consumo_articulos pero agregada por LÍNEA
    (Stk_Nivel1.Detalle), sobre artículos NACIONALES únicamente.

    SIN FILTRO OBLIGATORIO, a diferencia de fetch_consumo_articulos
    (2026-09-07): esta es la pantalla de entrada de
    /compras/consumo, así que tiene que abrir mostrando TODAS las líneas. Se
    puede porque lo que viaja de SQL Server a Python es chico y no crece con
    el catálogo: la agregación por (línea, mes, comprobante, estado) da ~2.150
    filas para 6 meses de toda la empresa, y el universo son 48 líneas. El
    filtro de artículos, en cambio, sigue exigiendo `q`/`linea` porque ahí sí
    la respuesta escala con el catálogo (ver la NOTA de rendimiento allá).

    `q` (substring de código) y `linea` se combinan con AND cuando vienen.
    `export=True` devuelve todas las líneas del filtro sin paginar.
    `fresh=True` saltea el cache (lo manda el botón "Refrescar"): ordenar por
    otra columna o cambiar de página reusa el cálculo y no toca la base."""
    q_norm = (q or "").strip()
    linea_norm = (linea or "").strip()

    meses = _meses_rango(str(desde)[:7], str(hasta)[:7])
    y1, m1 = int(meses[0][:4]), int(meses[0][5:7])
    y2, m2 = int(meses[-1][:4]), int(meses[-1][5:7])
    d1 = date(y1, m1, 1)
    d2 = (date(y2 + 1, 1, 1) if m2 == 12 else date(y2, m2 + 1, 1)) - timedelta(days=1)
    d1n = (d1 - BASE_DATE).days
    d2n = (d2 - BASE_DATE).days
    n_meses = len(meses)
    meses_set = set(meses)

    # sort/página se normalizan en _armar_pagina_lineas, que es lo único que
    # corre cuando el cálculo viene del cache.

    # Los filtros se arman como fragmentos con `?` y los valores se pasan
    # aparte — el texto del cliente NUNCA se interpola en el SQL.
    _, frag_q_reng, frag_linea, params_q_linea = _fragmentos_filtro(
        q_norm, linea_norm, linea_exacta, "r.CodArticu")
    _, frag_q_stock, _, _ = _fragmentos_filtro(
        q_norm, linea_norm, linea_exacta, "a.CodArticulo")
    params_reng: list = [d1n, d2n] + params_q_linea
    params_stock: list = list(params_q_linea)

    # Igual que en la vista de artículos: la lista de líneas ya calculada no
    # depende del orden ni de la página, así que se cachea.
    clave_cache = ("lineas", d1n, d2n, q_norm.lower(), linea_norm.lower(), bool(linea_exacta))
    filas = None if fresh else _cache_leer(clave_cache)
    if filas is not None:
        return _armar_pagina_lineas(filas, meses, n_meses, sort, sort_dir, page, page_size, export)

    ventas: dict[str, dict[str, float]] = {}
    stock_linea: dict[str, float] = {}
    articulos_linea: dict[str, int] = {}

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute(
            SQL_CONSUMO_LINEAS.format(
                valido=_cond_pedido_valido(cur), q=frag_q_reng, linea=frag_linea),
            params_reng,
        )
        for lin, anio, mes_n, cant in cur.fetchall():
            lin = (str(lin or "")).strip() or LINEA_SIN_ASIGNAR
            try:
                key = f"{int(anio):04d}-{int(mes_n):02d}"
            except (TypeError, ValueError):
                continue
            if key not in meses_set:
                continue
            m = ventas.get(lin)
            if m is None:
                m = {mes: 0.0 for mes in meses}
                ventas[lin] = m
            m[key] += float(_safe(cant) or 0)

        cur.execute(
            SQL_STOCK_LINEAS.format(q=frag_q_stock, linea=frag_linea),
            params_stock,
        )
        for lin, cant_art, stk in cur.fetchall():
            lin = (str(lin or "")).strip() or LINEA_SIN_ASIGNAR
            stock_linea[lin] = stock_linea.get(lin, 0.0) + float(_safe(stk) or 0)
            articulos_linea[lin] = articulos_linea.get(lin, 0) + int(cant_art or 0)

        # Una fila por línea con venta en el rango O con stock hoy — mismo
        # criterio de universo que la vista de artículos.
        nombres_lineas = sorted(set(ventas.keys()) | set(stock_linea.keys()))
        filas = []
        for lin in nombres_lineas:
            ventas_lin = ventas.get(lin)
            cantidades = (
                [round(ventas_lin[m], 2) for m in meses] if ventas_lin else [0.0] * n_meses
            )
            total = round(sum(cantidades), 2)
            promedio = round(total / n_meses, 2) if n_meses else 0.0
            maximo = max(cantidades) if cantidades else 0.0
            positivos = [c for c in cantidades if c > 0]
            minimo = min(positivos) if positivos else None
            filas.append({
                "linea": lin,
                "articulos": articulos_linea.get(lin, 0),
                "totalVendido": total,
                "promedio": promedio,
                "maximo": maximo,
                "minimo": minimo,
                "stock": round(stock_linea.get(lin, 0.0), 2),
            })
    finally:
        conn.close()

    _cache_guardar(clave_cache, filas)
    return _armar_pagina_lineas(filas, meses, n_meses, sort, sort_dir, page, page_size, export)


def _armar_pagina_lineas(filas, meses, n_meses, sort, sort_dir, page, page_size, export):
    """Ordena, pagina y arma la respuesta de fetch_consumo_lineas.

    Aparte de la consulta porque es lo único que hace falta rehacer cuando el
    cálculo ya está cacheado: ordenar por otra columna o pasar de página no
    vuelve a la base. Ordena sobre una COPIA — la lista del cache queda intacta
    y sirve para cualquier orden."""
    sort = sort if sort in _SORT_KEYS_LINEAS else "totalVendido"
    reverse = str(sort_dir).lower() != "asc"
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 20), 200))

    ordenadas = list(filas)
    if sort == "linea":
        ordenadas.sort(key=lambda r: r["linea"], reverse=reverse)
    else:
        ordenadas.sort(key=lambda r: (r[sort] if r[sort] is not None else -1), reverse=reverse)

    total_items = len(ordenadas)
    if export:
        page = 1
        page_size = total_items or 1
        total_pages = 1
        page_rows = ordenadas
    else:
        total_pages = max(1, -(-total_items // page_size))
        page = min(page, total_pages)
        start = (page - 1) * page_size
        page_rows = ordenadas[start:start + page_size]

    return {
        "desde": meses[0],
        "hasta": meses[-1],
        "mesesEnRango": n_meses,
        "total": total_items,
        "page": page,
        "pageSize": page_size,
        "totalPages": total_pages,
        "sort": sort,
        "sortDir": "asc" if not reverse else "desc",
        "lineas": page_rows,
    }


# ── Línea (Stk_Nivel1) de una lista puntual de artículos ─────────────────────
# Para /compras (dashboard, sección "Faltantes por línea",
# 2026-08-26): los faltantes del mes salen del Postgres propio como lista de
# CodArticulo, y hay que agruparlos por LÍNEA. Misma resolución de línea que
# SQL_CODIGOS_POR_LINEA (StkFer_ArtParamet.Nivel1 → Stk_Nivel1.Detalle), pero
# al revés: dado el código, devolver el nombre de la línea.
SQL_LINEA_POR_ARTICULO = """
SELECT LTRIM(RTRIM(s.CodArticulo)) AS CodArticulo,
       LTRIM(RTRIM(n1.Detalle))    AS Linea
FROM EVERWEAR.dbo.[StkFer_Articulos] s
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]        n1 ON n1.Nivel1         = ap.Nivel1
WHERE LTRIM(RTRIM(s.CodArticulo)) IN ({ph})
"""


def fetch_lineas_por_articulos(codigos: list[str]):
    """{CodArticulo: nombre de línea} para los códigos pedidos.

    Los códigos que no existen en el catálogo, o cuyo Nivel1 no resuelve a un
    Stk_Nivel1, simplemente NO aparecen en el dict — el que llama decide qué
    poner (la vista de /compras los agrupa como 'SIN LÍNEA'). Se consulta en
    lotes de 900 por el límite de parámetros de SQL Server."""
    limpios = sorted({(str(c) or "").strip() for c in codigos if (str(c) or "").strip()})
    if not limpios:
        return {"total": 0, "lineas": {}}

    out: dict[str, str] = {}
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        for i in range(0, len(limpios), 900):
            batch = limpios[i:i + 900]
            ph = ",".join("?" for _ in batch)
            cur.execute(SQL_LINEA_POR_ARTICULO.format(ph=ph), batch)
            for cod, linea in cur.fetchall():
                cod = (str(cod or "")).strip()
                nombre = (str(linea or "")).strip()
                if cod and nombre:
                    out[cod] = nombre
        return {"total": len(out), "lineas": out}
    finally:
        conn.close()
