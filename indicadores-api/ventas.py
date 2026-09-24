"""
Total de pedidos de venta del mes (Magnus, SOLO LECTURA).

Para /compras/metricas: denominador contra el que se compara el total de
faltantes del mes (unidades y $) — "cuánto representa lo que faltó sobre el
total pedido ese mes" (pedido 2026-07-28). Reusa el mismo criterio de
"pedido válido" que ya usa deposito.py/main.py (_es_valido: Estado
Cerrado/Facturado, blacklist de CompCodigo) para no contar comprobantes que
no son pedidos reales — mismos valores confirmados 2026-07-10 (ver
deposito.py).

Tablas (EVERWEAR, confirmadas por deposito.py/main.py):
  · VenFer_PedidoCabecera → NroMovVenta, FechaPedido (int, días desde
    1800-12-28), CompCodigo, EstadoPedido
  · VenFer_PedidoReng     → NroMovVenta, CodArticu, CantidadPedida,
    PrecioVenta
  · Pedido_Estados (MAGNUS_SITD) → Ped_Estado, Ped_EstadoDescripcion
"""
from datetime import datetime, date
from decimal import Decimal
import calendar
import os
import re
import time
from db import get_connection
from clientes import fetch_cliente
from cartera import cliente_es_de_vendedor
from vendedores import MARCA as MARCA_VENDEDOR, aplicar as recortar_vendedor
from vendedores import clave as clave_vendedor
from subempresas import filas_dos, sql_prueba, unir
from catalogo_pg import (
    mapa_articulo_sub_linea,
    codigos_de_sub_linea,
    codigos_de_linea,
    lineas_con_apertura_comercial,
    LINEA_SIN_CLASIFICAR,
    SUB_LINEA_SIN_CLASIFICAR,
)

BASE_DATE = date(1800, 12, 28)  # Magnus guarda fechas como días desde esta base

# Mismo blacklist que COMP_CODIGOS_EXCLUIDOS_HORA (deposito.py) y SQL_QUERY
# (main.py): comprobantes que no son pedidos de venta reales.
COMP_CODIGOS_EXCLUIDOS = (9, 49, 208, 410)
# Mismo whitelist que _es_valido (deposito.py): solo pedidos ya Cerrados o
# Facturados cuentan como "pedido real" del mes (no Abiertos/Cancelados).
ESTADOS_VALIDOS = ("CERRADO", "FACTURADO")
PATRONES_CANCELADO = ("CANCEL",)


def _es_valido(estado_desc) -> bool:
    s = str(estado_desc or "").upper()
    if any(p in s for p in PATRONES_CANCELADO):
        return False
    return any(p in s for p in ESTADOS_VALIDOS)


def _safe(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return value


SQL_PEDIDOS_RANGO = """
SELECT cab.NroMovVenta, cab.CompCodigo, est.Ped_EstadoDescripcion AS Estado
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
LEFT JOIN MAGNUS_SITD.dbo.Pedido_Estados est ON cab.EstadoPedido = est.Ped_Estado
WHERE cab.FechaPedido BETWEEN ? AND ?
"""

SQL_RENGLONES = """
SELECT
    SUM(r.CantidadPedida)                 AS TotalUnidades,
    SUM(r.CantidadPedida * r.PrecioVenta) AS TotalImporte
FROM EVERWEAR.dbo.VenFer_PedidoReng r
WHERE r.NroMovVenta IN ({ph})
"""


def fetch_pedidos_mes(desde: str, hasta: str) -> dict:
    """Total de unidades y $ pedidos (solo pedidos válidos: Cerrado/Facturado,
    sin comprobantes de la blacklist) con FechaPedido en [desde, hasta].

    Para el % de faltantes/total del mes en /compras/metricas — no filtra por
    artículo, es el total de TODO lo pedido en el mes (hayan faltado o no)."""
    d1 = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
    d2 = datetime.strptime(str(hasta)[:10], "%Y-%m-%d").date()
    d1n = (d1 - BASE_DATE).days
    d2n = (d2 - BASE_DATE).days

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_PEDIDOS_RANGO, (d1n, d2n))
        colps = [c[0] for c in cur.description]
        pedidos_validos: set[int] = set()
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
            nro = d.get("NroMovVenta")
            if nro is not None:
                pedidos_validos.add(int(nro))

        total_unidades = 0.0
        total_importe = 0.0
        CH = 1000
        pedidos_lista = sorted(pedidos_validos)
        for i in range(0, len(pedidos_lista), CH):
            chunk = pedidos_lista[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            cur.execute(SQL_RENGLONES.format(ph=ph), chunk)
            row = cur.fetchone()
            if row:
                total_unidades += float(_safe(row[0]) or 0)
                total_importe += float(_safe(row[1]) or 0)

        return {
            "desde": d1.isoformat(),
            "hasta": d2.isoformat(),
            "pedidos": len(pedidos_lista),
            "totalUnidades": round(total_unidades, 2),
            "totalImporte": round(total_importe, 2),
        }
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────
# Ventas por línea de un cliente — /ventas/vendedor (
# 2026-08-14): vista con filtro de cliente (código/nombre), tabla líneas x
# año actual/anterior (con desglose mensual opcional) y switch
# unidades/pesos.
#
# Fuente y criterio de "venta neta" — MISMOS que ya se verificaron a mano
# contra el pivot Excel real (ver HANDOFF_extracciones_sql.md,
# extraccion_ventas_todos_C00.py, ver_sp_ventas_hechos.py → SP
# _VEN_01_REAL_Ventas_Hechos): Ven_CompCabecera + Ven_CompRenglon
# (comprobantes REALES, no pedidos), cantidad/monto NETOS de nota de crédito
# según Ven_CodCom.DebitoCredito (1=Débito suma, 2=Crédito resta), filtro
# cc.EvitaInformesYListados <> 1 + la lista blanca COMPROBANTES_VENTA (ver
# el bloque de abajo, 2026-09-07), mes = FecMovim del COMPROBANTE vía
# dbo.fecha_cla2sql() (no FechaPedido del pedido — ver nota en el HANDOFF de
# por qué esto importa: un pedido de un mes facturado al siguiente cae en el
# mes de la factura).
#
# Línea = línea/sub_línea del catálogo de Postgres (`catalogo.*`), resuelta
# en Python desde `r.CodArticu` vía catalogo_pg.mapa_articulo_sub_linea —
# reemplaza el join a dbo.Stk_Nivel1 (2026-09-15, mismo motivo y mecanismo
# que fetch_top_lineas — ver el comentario de más abajo y
# depara_pool_linea_sublinea_patron.md).
#
# Gotcha fecha (ver HANDOFF): NO se filtra por fecha en el SQL (comparar una
# fecha calculada con dbo.fecha_cla2sql() contra un parámetro de fecha no
# filtra bien con el driver viejo, se pierden filas sin error). Acá se filtra
# por CodCliente en el WHERE (columna simple, sí filtra bien) — se trae TODO
# el historial de ESE cliente y se agrupa por año/mes en Python.
MESES_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

# ──────────────────────────────────────────────────────────────────────────
# QUÉ COMPROBANTES SON VENTA (criterio de contaduría, 2026-09-07)
# ──────────────────────────────────────────────────────────────────────────
# Hasta ahora el universo de la venta era "todo comprobante con renglón de
# artículo y EvitaInformesYListados <> 1". Eso dejaba entrar cosas que no son
# venta de mercadería (bienes de uso, líquido producto, la factura contado
# fiscal en desuso) y dejaba AFUERA las notas de crédito de bonificación, que
# no tienen renglón de artículo.
#
# El criterio ahora es una LISTA BLANCA de `Ven_CodCom.CompCodigo`. El signo
# lo sigue poniendo `Ven_CodCom.DebitoCredito` (1 débito suma, 2 crédito
# resta), así que la lista sola alcanza: no hace falta ninguna otra marca.
#
#   ENTRAN, con renglón de artículo (Ven_CompRenglon)
#     11 FACTURA CTA.CTE. MAYORISTA      28 FACTURA CONTADO (MOSTRADOR)
#     42 FACTURA CTA. CTE. MOSTRADOR     47 FACTURA DIRECTA (sin mov.)
#      2 FCT. CTE.CTE. (FISCAL) (sin mov.)
#     22 CREDITO DEVOL. MERCAD. MAYORIS  43 NOTA CRED DEVOL CTA CTE MOSTR
#     29 NOTA CRED. DEVOL. CDO. MOSTRAD
#   ENTRAN, con renglón de CONCEPTO (Ven_RenDebCre) → ver COMPROBANTES_AJUSTE
#     24 CREDITO BONIFICACION            60 CREDITO BONIF. FUERA DE RECIBO
#     25 CREDITO  INTERNO                23 CRED. BONIFIC. FISCAL (sin mov.)
#     62 AJUSTE SALDOS DEBITOS
#   QUEDAN AFUERA
#      1 FCT. CONTADO (FISCAL)          12 DEBITO POR CHEQUE RECHAZADO
#     13 DEBITO INTERESES               15 DEBITO GASTOS - CHEQUES
#     63 CREDITO CH RECHAZADO           27 VENTA BIENES DE USO
#     61 AJUSTE SALDOS CREDITOS         81 LIQUIDO PRODUCTO
#    102 FC CTA CTE USD (FISCAL)
#
# Los débitos financieros (12/13/15/63) ya quedaban afuera solos por no tener
# renglón de artículo; lo que la lista agrega de nuevo es sacar 1/27/81/102 y
# habilitar el bloque de concepto. Se mantiene `EvitaInformesYListados <> 1`.
#
# Overrideable por env para poder reclasificar sin tocar código.
COMPROBANTES_VENTA = tuple(
    int(x)
    for x in os.getenv(
        "VENTAS_COMPROBANTES", "2,11,22,23,24,25,28,29,42,43,47,60,62"
    ).split(",")
    if x.strip()
)
# Subconjunto que NO tiene renglón de artículo: el importe vive en
# `Ven_RenDebCre` (notas de crédito/débito por concepto). Lo consume
# bonificaciones.py — acá está para que la lista y su partición se lean en un
# solo lugar.
COMPROBANTES_AJUSTE = tuple(c for c in COMPROBANTES_VENTA if c in (23, 24, 25, 60, 62))

_WHERE_LEGACY = "WHERE cc.EvitaInformesYListados <> 1"
_WHERE_VENTA = _WHERE_LEGACY + "\n  AND cc.CompCodigo IN (%s)" % ",".join(
    str(c) for c in COMPROBANTES_VENTA
)


def _solo_venta(sql: str) -> str:
    """Agrega el IN de comprobantes de venta al WHERE de una consulta de
    renglones de artículo. Se aplica al definir la constante (antes de
    cualquier .format()), así el filtro vive en un solo lugar."""
    return sql.replace(_WHERE_LEGACY, _WHERE_VENTA)


# ──────────────────────────────────────────────────────────────────────────
# LA OTRA SUB-EMPRESA (2026-09-07)
# ──────────────────────────────────────────────────────────────────────────
# La venta de Ever Wear sale de DOS sub-empresas: MAGNUS (`Ven_*`) y PRUEBA
# (`PRU_Ven_*`). `PRU_` no es una copia de prueba — son comprobantes reales,
# ≈5% de la facturación, y el cubo del BI los suma. Leyendo sólo `Ven_*` todos
# los totales de esta vista quedaban por debajo del pivot: ej. BECCARIA
# GERARDO del 1 al 6/09/2026 daba 20.249.816 en vez de 16.487.281 (PRUEBA le
# aportaba +3,7M de facturas y −7,5M de notas de crédito).
#
# PRUEBA tiene su propio maestro de comprobantes y sus propios códigos: la
# lista blanca y la transformación viven en subempresas.py. Acá cada constante
# SQL tiene su gemela `_PRUEBA` y las dos se ejecutan con LOS MISMOS
# parámetros; las filas se suman en Python.
def _prueba(sql: str) -> str:
    """Gemela de una consulta de venta contra la sub-empresa PRUEBA."""
    return sql_prueba(sql, COMPROBANTES_VENTA, COMPROBANTES_AJUSTE)

# ──────────────────────────────────────────────────────────────────────────
# Catálogo de líneas: catalogo.* en Postgres (reemplazó a dbo.Stk_Nivel1 acá
# el 2026-09-15, mismo motivo que fetch_top_lineas: Stk_Nivel1 no tiene
# noción de sub_línea y Magnus/Postgres son motores distintos sin JOIN
# posible). SQL_VENTAS_CLIENTE ya no resuelve la línea en SQL Server: trae
# `r.CodArticu` crudo y fetch_ventas_por_linea cruza contra
# catalogo_pg.mapa_articulo_sub_linea() en Python (ver
# depara_pool_linea_sublinea_patron.md). Un código sin match — o mientras
# `catalogo.articulo` esté vacía — cae en LINEA_SIN_CLASIFICAR.


SQL_VENTAS_CLIENTE = """
SELECT  -- ver COMPROBANTES_VENTA: el IN del WHERE define qué es venta
    r.CodArticu AS CodArticu,
    -- Antes: dbo.fecha_cla2sql(c.FecMovim). Es una función escalar, y una
    -- función escalar en el SELECT se evalúa fila por fila. La cuenta directa
    -- da exactamente lo mismo (verificado contra los 4.595 valores distintos
    -- de FecMovim de la tabla, cero diferencias) y el motor la resuelve en la
    -- misma pasada. La única diferencia sería con FecMovim negativo, que no
    -- existe en la tabla.
    DATEADD(day, c.FecMovim, '1800-12-28') AS Fecha,
    cc.EvitaInformesYListados AS Evita,
    CASE cc.DebitoCredito WHEN 1 THEN r.Cantidad ELSE r.Cantidad * -1 END AS CantidadNeta,
    CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) ELSE (r.Cantidad * r.PrecioVenta) * -1 END AS MontoNeto
FROM Ven_CompCabecera c
JOIN Ven_CompRenglon r ON r.NroMovVenta = c.NroMovVenta
JOIN Ven_CodCom cc      ON c.CompCodigo = cc.CompCodigo
WHERE c.CodCliente = ?
  AND cc.CompCodigo IN (%s)
""" % ",".join(str(c) for c in COMPROBANTES_VENTA)

SQL_VENTAS_CLIENTE_PRUEBA = _prueba(SQL_VENTAS_CLIENTE)

# Catálogo de vendedores — maestro `Vendedores` (ver cartera.py para por qué
# este y no `Ped_Usu_Arma`). Alimenta el selector de /admin/usuarios y el
# filtro de vendedor de /ventas/vendedor.
#
# Se devuelve TODO el maestro con dos banderas, en vez de filtrar en SQL:
#   · activo  → Estado_Desc empieza con "Habilitado" (los "No Habilitado->"
#     son bajas) y el nombre no arranca con "(baja)".
#   · persona → NO es un seudo-vendedor. El maestro mezcla vendedores reales
#     con canales y agrupadores: MOSTRADORES, SIN VENDEDOR, ZONA CBA,
#     VIAJANTE ZONA ROSARIO, VENDEDOR MERCADO LIBRE, COMERCIO EXTERIOR,
#     GERENCIA COMERCIAL, ATENDIDOS POR LA EMPRESA, cooperativas, etc.
#
# Filtrar en el front y no acá es a propósito: /ventas/vendedor quiere solo
# personas activas, pero /admin/usuarios tiene que poder asignar igual un
# seudo-vendedor (alguien que atiende mostrador) y mostrar el nombre de un
# vendedor dado de baja que quedó asignado a un usuario. Si se filtrara en
# SQL, ese usuario mostraría "(sin nombre)" y nadie entendería por qué.
SQL_VENDEDORES = """
SELECT VendedorCodigo AS codigo,
       LTRIM(RTRIM(VendedorNombre)) AS nombre,
       LTRIM(RTRIM(Estado_Desc)) AS estado
FROM MAGNUS_SITD.dbo.Vendedores
ORDER BY VendedorNombre
"""

# Prefijos/palabras que marcan un seudo-vendedor (canal, zona, agrupador).
# Se comparan en MAYÚSCULAS contra el nombre completo.
_NO_PERSONA = (
    "MOSTRADOR", "SIN VENDEDOR", "ZONA ", "VIAJANTE ZONA", "VENDEDOR ",
    "COMERCIO EXTERIOR", "GERENCIA", "ATENDIDOS POR LA EMPRESA", "COOP",
)


def _es_persona(nombre: str | None) -> bool:
    if not nombre:
        return False
    u = nombre.strip().upper()
    if u in ("VENDEDOR CERO", "VENDEDOR 0"):
        return False
    return not any(u.startswith(p) or p in u for p in _NO_PERSONA)


def fetch_vendedores() -> list[dict]:
    """Catálogo completo de `Vendedores` como
    {'codigo', 'nombre', 'activo', 'persona'} — chico, sin paginar."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_VENDEDORES)
        out = []
        for cod, nombre, estado in cur.fetchall():
            if cod is None:
                continue
            nom = str(nombre).strip() if nombre else None
            est = (str(estado).strip() if estado else "").upper()
            de_baja = bool(nom and nom.upper().startswith("(BAJA)"))
            out.append({
                "codigo": int(cod),
                "nombre": nom,
                "activo": est.startswith("HABILITADO") and not de_baja,
                "persona": _es_persona(nom),
            })
        return out
    finally:
        conn.close()


def _anio_vacio() -> dict:
    return {
        "cantidad": 0.0,
        "monto": 0.0,
        "meses": [{"mes": m, "label": MESES_ES[m - 1], "cantidad": 0.0, "monto": 0.0} for m in range(1, 13)],
    }


def _round_anio(a: dict) -> dict:
    a["cantidad"] = round(a["cantidad"], 2)
    a["monto"] = round(a["monto"], 2)
    for m in a["meses"]:
        m["cantidad"] = round(m["cantidad"], 2)
        m["monto"] = round(m["monto"], 2)
    return a


def _bloqueado(cod_cliente: int, anio_anterior: int, anio_actual: int) -> dict:
    """Respuesta para un cliente que NO corresponde al vendedor logueado —
    a propósito no incluye nombre del cliente ni ningún número (ver
    docstring de fetch_ventas_por_linea): esto es el chequeo de defensa en
    profundidad server-side, no debería alcanzarse en uso normal (el
    buscador de clientes ya filtra antes), pero si alguien arma la URL a
    mano con un `cliente=` ajeno no tiene que filtrar nada."""
    return {
        "cliente": {"codigo": int(cod_cliente), "nombre": None},
        "anioAnterior": anio_anterior,
        "anioActual": anio_actual,
        "tieneDatos": False,
        "permitido": False,
        "lineas": [],
        "totales": {"anioAnterior": _anio_vacio(), "anioActual": _anio_vacio()},
    }


# ──────────────────────────────────────────────────────────────────────────
# Rankings del pie de /ventas/vendedor — top clientes ($) y top líneas
# (unidades) en un rango de meses. Ambos toman SOLO los clientes que ya
# pasan el mismo filtro de acceso por vendedor que usa el buscador de
# clientes (clientes.fetch_clientes_search, recorte por cartera) — un
# no-admin nunca ve acá un cliente que no es suyo. Admin (`vendedor=None`)
# ve el ranking de toda la empresa.
#
# RANGO (2026-09-04, antes ventana móvil de 12 meses): meses TRANSCURRIDOS
# del AÑO EN CURSO — Enero → mes ANTERIOR al actual. En septiembre 2026 eso
# es enero 2026 → agosto 2026. El mes en curso sale aparte, en su propia
# columna (`montoMes` / `unidadesMes`), en la MISMA consulta. El front ya no
# manda `desde`/`hasta` ni deja elegir el rango; los parámetros siguen
# existiendo en la ruta HTTP solo para debug, y mueven solo el acumulado.
# Ver _rango_ytd_y_mes.
#
# FILTRO DE FECHA EN SQL (2026-08-18, "todo el trabajo
# debe ser en sql porque se ralentiza mucho la consulta"): ahora el rango
# se recorta en el WHERE, no en Python. El filtro va contra la COLUMNA
# CRUDA `vc.FecMovim` — entero base 1800-12-28, igual que FechaPedido en
# fetch_pedidos_mes (ver HANDOFF_extracciones_sql.md: "las tablas Magnus
# usan fecha entera base 1800-12-28") — y NO contra
# `dbo.fecha_cla2sql(vc.FecMovim)`. Esto importa por dos razones:
#
#   1. Esquiva el gotcha ya documentado del driver viejo (comparar una
#      fecha CALCULADA contra un parámetro de FECHA se come filas sin
#      tirar error). Acá los dos lados son enteros, no fechas.
#   2. Es sargable: sin UDF escalar por fila, el motor puede usar índice
#      sobre FecMovim. Un `WHERE YEAR(dbo.fecha_cla2sql(...)) = ?` habría
#      forzado igual el scan completo + una llamada a la UDF por renglón,
#      o sea el problema de velocidad que había que arreglar.
#
# Si `FecMovim` no fuera ese entero, esta query falla RUIDOSAMENTE (error
# de conversión o cero filas), no en silencio — que es justo lo contrario
# del gotcha de arriba, y por eso es una apuesta segura.
#
# La suma se hace entera en SQL (GROUP BY por cliente / por línea, ya sin
# desglose año-mes: nada de lo que se traía a Python se usaba para otra
# cosa que sumar). Además cada resultado se cachea en memoria por 15 min
# — el front pide esto al montar la página o al cambiar el rango, no hace
# falta que sea al segundo. Cache simple de proceso (uvicorn con 1 worker,
# ver main.py); con más workers cada uno cachea por su lado, lo cual sigue
# siendo correcto, solo menos efectivo.
# Largo de la ventana móvil, en meses. Ya NO lo usan los rankings de
# /ventas/vendedor (pasaron al año en curso, ver _rango_ytd_y_mes); sigue
# siendo el default de _resolver_rango, o sea de bulones y bonificaciones.
TOP_MESES = 12

_TOP_CLIENTES_CACHE: dict[tuple, tuple[float, dict]] = {}
_TOP_CLIENTES_TTL_SEG = 15 * 60  # 15 minutos

_TOP_LINEAS_CACHE: dict[tuple, tuple[float, dict]] = {}
_TOP_LINEAS_TTL_SEG = 15 * 60  # 15 minutos

_YM_RE = re.compile(r"^(\d{4})-(\d{1,2})$")


def _parse_ym(s: str) -> tuple[int, int]:
    """'YYYY-MM' -> (año, mes). ValueError si no matchea o el mes no es
    1..12 — se propaga tal cual (el caller/ruta HTTP lo envuelve)."""
    m = _YM_RE.match((s or "").strip())
    if not m:
        raise ValueError(f"Formato de mes inválido: {s!r} (esperado YYYY-MM)")
    anio, mes = int(m.group(1)), int(m.group(2))
    if not (1 <= mes <= 12):
        raise ValueError(f"Mes inválido: {s!r}")
    return anio, mes


def _mes_atras(ym: tuple[int, int], n: int) -> tuple[int, int]:
    """(año, mes) que queda `n` meses antes de `ym`."""
    anio, mes = ym
    idx = anio * 12 + (mes - 1) - n
    return idx // 12, idx % 12 + 1


def _resolver_rango(desde: str | None, hasta: str | None, meses: int = TOP_MESES):
    """('YYYY-MM'|None, 'YYYY-MM'|None) -> (desde_ym, hasta_ym, dia_desde,
    dia_hasta), donde los `dia_*` son el entero Magnus (días desde
    BASE_DATE) del PRIMER día del mes `desde` y del ÚLTIMO día del mes
    `hasta` — o sea, ambos meses quedan incluidos completos.

    Default (2026-08-18): ventana FIJA de `meses` meses que
    termina en el MES ANTERIOR al actual — el mes en curso NO entra porque
    está incompleto. Corriendo en agosto 2026 da agosto 2025 → julio 2026.

    `desde`/`hasta` explícitos siguen andando (la ruta HTTP los expone para
    debug y consultas puntuales), pero el front ya no los manda: la vista
    usa siempre la ventana fija. Si vienen invertidos se reordenan. Lanza
    ValueError si el formato no es 'YYYY-MM'."""
    hoy_ym = (date.today().year, date.today().month)
    hasta_ym = _parse_ym(hasta) if hasta else _mes_atras(hoy_ym, 1)
    desde_ym = _parse_ym(desde) if desde else _mes_atras(hasta_ym, meses - 1)
    if desde_ym > hasta_ym:
        desde_ym, hasta_ym = hasta_ym, desde_ym

    primer_dia = date(desde_ym[0], desde_ym[1], 1)
    ultimo_dia = date(
        hasta_ym[0], hasta_ym[1], calendar.monthrange(hasta_ym[0], hasta_ym[1])[1]
    )
    return desde_ym, hasta_ym, (primer_dia - BASE_DATE).days, (ultimo_dia - BASE_DATE).days


# ── Rango de los rankings de /ventas/vendedor (2026-09-04) ────────────────
# Reemplaza a la ventana móvil de 12 meses (_resolver_rango, que sigue igual
# para bulones/bonificaciones) por DOS ventanas que viajan juntas y se
# resuelven en UNA sola pasada de SQL:
#
#   · Acumulado  → meses TRANSCURRIDOS del año en curso: Enero → mes
#     ANTERIOR al actual. El mes en curso no entra (está incompleto).
#   · Mes en curso → del 1° al último día del mes actual. Es la columna
#     nueva de la derecha de la tabla.
#
# Las dos salen del MISMO scan: el WHERE recorta al rango que las cubre a
# las dos y cada métrica se separa con un CASE sobre `vc.FecMovim` (entero
# base 1800-12-28, sargable — ver el comentario largo de arriba sobre por
# qué nunca se filtra contra la fecha calculada). Hacer dos queries habría
# duplicado el costo de la parte cara, que es el JOIN cabecera×renglón.
#
# En ENERO el acumulado queda vacío: no hay ningún mes cerrado del año
# todavía. En vez de un caso especial en SQL se arma un rango imposible
# (hasta = desde - 1, ningún comprobante entra) y `desde`/`hasta` viajan en
# null para que el front sepa que esa columna no aplica.
def _rango_ytd_y_mes(desde: str | None = None, hasta: str | None = None):
    """(desde|None, hasta|None) -> (desde_ym|None, hasta_ym|None, mes_ym,
    dias_acum, dias_mes, dias_total), donde cada `dias_*` es el par
    (primer_día, último_día) en entero Magnus.

    Default: acumulado = Enero..mes anterior del año en curso; mes en curso
    = el mes actual completo. `desde`/`hasta` explícitos (la ruta HTTP los
    sigue exponiendo para debug) mueven SOLO el acumulado — la columna del
    mes en curso es siempre el mes del calendario. Lanza ValueError si el
    formato no es 'YYYY-MM'."""
    hoy = date.today()
    mes_ym = (hoy.year, hoy.month)

    primer_dia_mes = date(hoy.year, hoy.month, 1)
    ultimo_dia_mes = date(
        hoy.year, hoy.month, calendar.monthrange(hoy.year, hoy.month)[1]
    )
    dias_mes = (
        (primer_dia_mes - BASE_DATE).days,
        (ultimo_dia_mes - BASE_DATE).days,
    )

    if desde or hasta:
        desde_ym = _parse_ym(desde) if desde else (hoy.year, 1)
        hasta_ym = _parse_ym(hasta) if hasta else _mes_atras(mes_ym, 1)
        if desde_ym > hasta_ym:
            desde_ym, hasta_ym = hasta_ym, desde_ym
    elif hoy.month == 1:
        desde_ym = hasta_ym = None
    else:
        desde_ym, hasta_ym = (hoy.year, 1), (hoy.year, hoy.month - 1)

    if desde_ym is None:
        dias_acum = (dias_mes[0], dias_mes[0] - 1)  # rango imposible
    else:
        primer_dia = date(desde_ym[0], desde_ym[1], 1)
        ultimo_dia = date(
            hasta_ym[0], hasta_ym[1], calendar.monthrange(hasta_ym[0], hasta_ym[1])[1]
        )
        dias_acum = ((primer_dia - BASE_DATE).days, (ultimo_dia - BASE_DATE).days)

    dias_total = (min(dias_acum[0], dias_mes[0]), max(dias_acum[1], dias_mes[1]))
    return desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total


# Monto neto de un renglón, con el signo de la nota de crédito. Se repite
# dentro de cada CASE de ventana, así que va como constante para que las dos
# métricas (acumulado y mes en curso) no se puedan desincronizar.
_MONTO_NETO = (
    "CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) "
    "ELSE (r.Cantidad * r.PrecioVenta) * -1 END"
)
_UNIDADES_NETAS = (
    "CASE cc.DebitoCredito WHEN 1 THEN r.Cantidad ELSE r.Cantidad * -1 END"
)


def _ventana(expr: str) -> str:
    """Suma de `expr` acotada a una ventana de fechas — consume 2 parámetros
    (primer y último día en entero Magnus)."""
    return f"SUM(CASE WHEN vc.FecMovim BETWEEN ? AND ? THEN ({expr}) ELSE 0 END)"


# UNA sola consulta para admin y para vendedor (2026-09-08): el recorte por
# vendedor es una línea de WHERE sobre `vc.vendedor` que se inyecta en
# MARCA_VENDEDOR al ejecutar (ver vendedores.py). Antes eran dos constantes
# gemelas — una con el JOIN de cartera y otra sin él — que había que
# mantener en sincronía a mano.
#
# Importante para el orden de los `?`: la marca NO consume parámetros, así
# que la lista de params es la misma con y sin vendedor.
SQL_TOP_CLIENTES = _solo_venta(f"""
SELECT
    c.CodCliente AS CodCliente,
    MAX(LTRIM(RTRIM(c.Cliente_Nombre))) AS Nombre,
    {_ventana(_MONTO_NETO)} AS MontoNeto,
    {_ventana(_MONTO_NETO)} AS MontoMes
FROM MAGNUS_SITD.dbo.Clientes c
JOIN Ven_CompCabecera vc ON vc.CodCliente = c.CodCliente
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
WHERE cc.EvitaInformesYListados <> 1
  AND vc.FecMovim BETWEEN ? AND ?
{MARCA_VENDEDOR}
GROUP BY c.CodCliente
""")

# El `HAVING SUM(...) > 0` y el `ORDER BY` que tenían estas dos consultas se
# fueron a Python (fetch_top_clientes): con dos sub-empresas el corte hay que
# hacerlo sobre la SUMA de las dos — un cliente puede quedar negativo en una y
# positivo en el total — y ningún ORDER BY de una consulta sola sirve para el
# ranking final.
SQL_TOP_CLIENTES_PRUEBA = _prueba(SQL_TOP_CLIENTES)


# ──────────────────────────────────────────────────────────────────────────
# Ajuste de la venta (notas de crédito por concepto) en los rankings
# ──────────────────────────────────────────────────────────────────────────
# Las bonificaciones y los ajustes de saldo se emiten como ND/NC por CONCEPTO
# (comprobantes 24/60/25/23/62): no tienen renglón de artículo, así que no
# aparecen en ninguna de las consultas de arriba y el bruto de los rankings
# queda por encima de la venta real. Se traen aparte, con el mismo rango y el
# mismo recorte por vendedor, y viajan en el payload como `ajuste`/`ajusteMes`
# para que el pie de la tabla pueda mostrar bruto → ajuste → neto.
#
# NO se prorratean adentro de las filas: la NC es de la empresa, no de un
# cliente ni de una línea en particular, así que repartirla por fila sería un
# supuesto. Cada fila del ranking sigue siendo venta BRUTA; el neto es del
# total.
#
# El import va adentro de la función a propósito: bonificaciones.py importa de
# este módulo (la lista blanca de comprobantes), así que a nivel de módulo
# sería un import circular.
def _ajuste_rankings(dias_acum, dias_mes, dias_total, vendedor, forzar):
    """{'ajuste': x, 'ajusteMes': y} para el payload de un ranking. Nunca
    rompe la vista: si la consulta del ajuste falla, devuelve ceros y el
    ranking se sigue mostrando en bruto."""
    try:
        from bonificaciones import ajuste_ventanas

        aj = ajuste_ventanas(dias_acum, dias_mes, dias_total,
                             vendedor=vendedor, forzar=forzar)
        return {"ajuste": aj["acum"], "ajusteMes": aj["mes"]}
    except Exception:
        return {"ajuste": 0.0, "ajusteMes": 0.0}


# Nombres del maestro de clientes para códigos sueltos (los que entran al
# ranking sólo por una nota de crédito). Va en lotes: `IN` con miles de
# parámetros no lo acepta el driver, y 500 por vuelta alcanza de sobra.
def _nombres_clientes(cur, codigos: list) -> dict:
    out: dict[int, str] = {}
    codigos = [int(c) for c in codigos if c is not None]
    for i in range(0, len(codigos), 500):
        lote = codigos[i:i + 500]
        marcas = ",".join("?" for _ in lote)
        cur.execute(
            "SELECT CodCliente, LTRIM(RTRIM(Cliente_Nombre)) "
            f"FROM MAGNUS_SITD.dbo.Clientes WHERE CodCliente IN ({marcas})",
            tuple(lote),
        )
        for cod, nombre in cur.fetchall():
            if cod is not None:
                out[int(cod)] = (str(nombre).strip() if nombre else None)
    return out


def fetch_top_clientes(
    vendedor: int | None = None,
    limit: int = 1_000_000,  # "sin límite" (2026-08-19) — ver main.py
    desde: str | None = None,
    hasta: str | None = None,
    forzar: bool = False,
) -> dict:
    """Top clientes por MONTO (venta neta, $) en un rango de meses — para el
    ranking debajo de la tabla de /ventas/vendedor.

    Devuelve `porMonto` (las `limit` primeras, ya ordenadas por SQL) y
    `totalClientes` (2026-08-18: cuántos clientes distintos
    entran en la filtración, NO cuántos se muestran — o sea, el total puede
    ser mucho mayor que len(porMonto)).

    Solo $: el ranking por unidades se sacó a propósito (
    2026-08-18, "acá solo dejamos ver $ gastado por ese cliente"). Las
    unidades ahora viven en fetch_top_lineas.

    `vendedor`: si se pasa, el ranking sale SOLO de los comprobantes cuyo
    `Ven_CompCabecera.vendedor` es el suyo o el de alguno de sus antecesores
    (eje comprobante, ver vendedores.py — es el mismo eje del pivot
    `Ventas_Debitos_Creditos`). `None` (admin) no filtra, ranking de toda la
    empresa.

    Hasta 2026-09-08 el corte era por CARTERA del cliente y por eso un
    vendedor se llevaba venta emitida con otro código y dos vendedores
    podían sumar al mismo cliente. La cartera quedó sólo para permisos
    (buscador y faltantes, ver cartera.py).

    `desde`/`hasta` ("YYYY-MM"): rango de meses, AMBOS inclusive y
    completos. Default (2026-09-04): meses TRANSCURRIDOS del año en curso,
    Enero → mes ANTERIOR — ver _rango_ytd_y_mes. Cada cliente trae además
    `montoMes`: lo mismo pero SOLO del mes en curso (columna aparte en la
    tabla, no entra en `monto`). No respeta el selector de período
    (YTD/meses) de la tabla principal. Lanza `ValueError` si el formato no
    es "YYYY-MM".

    `forzar=True` ignora el cache (para refrescar a mano sin esperar el
    TTL — no expuesto en la ruta HTTP, pensado para debug)."""
    desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total = _rango_ytd_y_mes(
        desde, hasta
    )

    limit_i = int(limit)
    cache_key = (clave_vendedor(vendedor), limit_i, desde_ym, hasta_ym, mes_ym)
    ahora = time.monotonic()
    if not forzar:
        cacheado = _TOP_CLIENTES_CACHE.get(cache_key)
        if cacheado is not None and (ahora - cacheado[0]) < _TOP_CLIENTES_TTL_SEG:
            return cacheado[1]

    # Orden de los parámetros = orden en que aparecen los "?" en el texto de
    # la query: primero los dos CASE del SELECT (acumulado, mes en curso) y
    # al final el WHERE. El recorte por vendedor no consume parámetros.
    params_ventanas = dias_acum + dias_mes

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        sql_m = recortar_vendedor(SQL_TOP_CLIENTES, vendedor)
        sql_p = recortar_vendedor(SQL_TOP_CLIENTES_PRUEBA, vendedor)
        params = params_ventanas + dias_total

        # Las dos sub-empresas se suman por CodCliente (col. 0) antes de
        # filtrar y ordenar — ver el bloque de subempresas arriba.
        filas = unir(filas_dos(cur, sql_m, sql_p, params), (0,), (2, 3))

        # Ajuste POR CLIENTE (2026-09-08): las ND/NC por concepto
        # (23/24/25/60/62) no tienen artículo pero sí cliente, así que se
        # imputan a la fila y las columnas del ranking dejan de ser brutas.
        # Antes viajaban sólo en el pie (`ajuste`/`ajusteMes`), que ahora es
        # informativo: el número ya está adentro de `monto`/`montoMes`.
        # El import va acá adentro por el ciclo bonificaciones→ventas.
        try:
            from bonificaciones import ajuste_por_cliente

            ajustes = dict(
                ajuste_por_cliente(dias_acum, dias_mes, dias_total,
                                   vendedor=vendedor, forzar=forzar)
            )
        except Exception:
            ajustes = {}

        clientes: list[dict] = []
        for cod, nombre, monto, monto_mes in filas:
            if cod is None:
                continue
            bruto = round(float(_safe(monto) or 0), 2)
            bruto_mes = round(float(_safe(monto_mes) or 0), 2)
            a_acum, a_mes = ajustes.pop(int(cod), (0.0, 0.0))
            m = round(bruto + a_acum, 2)
            m_mes = round(bruto_mes + a_mes, 2)
            # Equivalente al HAVING que estaba en el SQL, pero SOLO descarta
            # al cliente SIN MOVIMIENTO en el período (todo en cero). Un
            # bruto NEGATIVO — devolución (comp. 22) sin factura en el rango —
            # es plata real del período y tiene que entrar: descartarlo dejaba
            # esa resta afuera y el total del pie quedaba por ENCIMA del
            # pivot (2026-09-08: BECCARIA GERARDO, ene→ago, +43.251,70 por el
            # cliente 15740).
            if not (bruto or bruto_mes or a_acum or a_mes):
                continue
            clientes.append(
                {
                    "numero": int(cod),
                    "nombre": (str(nombre).strip() if nombre else None),
                    "monto": m,
                    "montoMes": m_mes,
                    "bruto": bruto,
                    "brutoMes": bruto_mes,
                    "ajuste": a_acum,
                    "ajusteMes": a_mes,
                }
            )

        # Clientes que en el período SOLO tienen nota de crédito por concepto
        # (ninguna factura con artículo): no vienen en `filas`, y sin esto el
        # pie no cerraría con el pivot. El nombre se busca en el maestro.
        if ajustes:
            nombres = _nombres_clientes(cur, list(ajustes.keys()))
            for cod, (a_acum, a_mes) in ajustes.items():
                clientes.append(
                    {
                        "numero": int(cod),
                        "nombre": nombres.get(int(cod)),
                        "monto": a_acum,
                        "montoMes": a_mes,
                        "bruto": 0.0,
                        "brutoMes": 0.0,
                        "ajuste": a_acum,
                        "ajusteMes": a_mes,
                    }
                )

        clientes.sort(key=lambda c: (c["monto"], c["montoMes"]), reverse=True)

        resultado = {
            # En enero no hay acumulado (ningún mes cerrado del año todavía)
            # y los dos viajan en null — ver _rango_ytd_y_mes.
            "desde": f"{desde_ym[0]:04d}-{desde_ym[1]:02d}" if desde_ym else None,
            "hasta": f"{hasta_ym[0]:04d}-{hasta_ym[1]:02d}" if hasta_ym else None,
            "mesActual": f"{mes_ym[0]:04d}-{mes_ym[1]:02d}",
            "totalClientes": len(clientes),
            "porMonto": clientes[:limit_i],
            # Netos del ranking COMPLETO (no sólo de las filas mostradas) —
            # ya incluyen el ajuste.
            "total": round(sum(c["monto"] for c in clientes), 2),
            "totalMes": round(sum(c["montoMes"] for c in clientes), 2),
            # Informativo: cuánto de ese total es ajuste. NO se vuelve a
            # sumar en el pie (ver `ajusteIncluido`).
            "ajuste": round(sum(c["ajuste"] for c in clientes), 2),
            "ajusteMes": round(sum(c["ajusteMes"] for c in clientes), 2),
            "ajusteIncluido": True,
        }
        _TOP_CLIENTES_CACHE[cache_key] = (ahora, resultado)
        return resultado
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────
# Top líneas (2026-08-18: "agregamos vista de líneas, al
# igual que el top, traemos el total de líneas y acá dejamos ver solo
# unidades compradas").
#
# Reemplazado 2026-09-15: el agrupado ya NO es Stk_Nivel1 (catálogo propio
# de Magnus) — es Pool > Línea > Sub Línea > Patrón, un esquema NUEVO que
# vive en POSTGRES (`catalogo.*`, ver cargar_depara.py y
# depara_pool_linea_sublinea_patron.md) porque Stk_Nivel1 no tiene noción de
# sub_línea. Como Magnus (SQL Server) y ese Postgres son motores distintos,
# no hay join posible en una sola consulta: acá se agrupa por CÓDIGO DE
# ARTÍCULO (`r.CodArticu`, sin ningún JOIN a catálogo) y fetch_top_lineas
# hace el cruce contra el mapeo de catalogo_pg.py en Python — mismo patrón
# que tenía el viejo `ventas.linea` antes de deprecarse (ver el comentario
# de "Catálogo de líneas" más arriba), reintroducido acá porque esta vez no
# hay alternativa server-side.
#
# Un código de artículo que no está en `catalogo.articulo` (o mientras el
# DePara no se cargó — la tabla puede estar vacía) cae en
# SUB_LINEA_SIN_CLASIFICAR / LINEA_SIN_CLASIFICAR — se resuelve en Python,
# no acá.
SQL_TOP_LINEAS = _solo_venta(f"""
SELECT
    r.CodArticu AS CodArticu,
    {_ventana(_UNIDADES_NETAS)} AS UnidadesNetas,
    {_ventana(_UNIDADES_NETAS)} AS UnidadesMes,
    {_ventana(_MONTO_NETO)} AS MontoNeto,
    {_ventana(_MONTO_NETO)} AS MontoMes
FROM Ven_CompCabecera vc
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
WHERE cc.EvitaInformesYListados <> 1
  AND vc.FecMovim BETWEEN ? AND ?
""" + MARCA_VENDEDOR + """
GROUP BY r.CodArticu
""")

SQL_TOP_LINEAS_PRUEBA = _prueba(SQL_TOP_LINEAS)


def fetch_top_lineas(
    vendedor: int | None = None,
    limit: int = 1_000_000,  # "sin límite" (2026-08-19) — ver main.py
    desde: str | None = None,
    hasta: str | None = None,
    forzar: bool = False,
) -> dict:
    """Top líneas por UNIDADES compradas en un rango de meses — gemelo de
    fetch_top_clientes, mismo rango/cache/criterio de acceso por vendedor,
    pero agrupando por Línea > Sub Línea (catálogo de Postgres, ver el
    comentario de SQL_TOP_LINEAS) en vez de por cliente.

    Devuelve las DOS métricas (2026-08-26: "que tenga las 2
    vistas, por unidad y por $"): `porUnidades` (ordenado por unidades) y
    `porMonto` (ordenado por $). Cada item es una LÍNEA con `unidades`/`monto`
    (suma de todas sus sub_líneas) y `subLineas`, la lista de sus sub_líneas
    con las mismas cuatro métricas — el front muestra la línea como grupo
    colapsable y la sub_línea como fila clickeable (abre el modal de
    clientes). `totalLineas`/`totalLineasMonto` cuentan líneas distintas
    (no sub_líneas) — el front alterna la lista con un botón $ | Unidades
    sin volver a pegarle al back.

    Desde 2026-09-04 el rango por defecto es el año en curso hasta el mes
    ANTERIOR y cada sub_línea trae aparte `unidadesMes`/`montoMes`, el mismo
    número pero solo del mes en curso — ver _rango_ytd_y_mes."""
    desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total = _rango_ytd_y_mes(
        desde, hasta
    )

    limit_i = int(limit)
    cache_key = (clave_vendedor(vendedor), limit_i, desde_ym, hasta_ym, mes_ym)
    ahora = time.monotonic()
    if not forzar:
        cacheado = _TOP_LINEAS_CACHE.get(cache_key)
        if cacheado is not None and (ahora - cacheado[0]) < _TOP_LINEAS_TTL_SEG:
            return cacheado[1]

    # Cuatro CASE en el SELECT (unidades acum/mes, monto acum/mes) antes del
    # WHERE — el orden de los "?" manda. El recorte por vendedor no consume
    # parámetros, así que la lista es la misma con y sin vendedor.
    params_ventanas = dias_acum + dias_mes + dias_acum + dias_mes

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        sql_m = recortar_vendedor(SQL_TOP_LINEAS, vendedor)
        sql_p = recortar_vendedor(SQL_TOP_LINEAS_PRUEBA, vendedor)
        params = params_ventanas + dias_total

        # Mapeo COMPLETO código de artículo -> (sub_línea, línea), cacheado
        # 15 min en catalogo_pg (Postgres, motor aparte — no hay JOIN posible
        # acá). Vacío mientras el DePara no se cargó: todo cae en
        # SIN_CLASIFICAR, no es un error.
        mapa = mapa_articulo_sub_linea()
        # Set de líneas con al menos un patrón de apertura comercial — ver
        # catalogo_pg.lineas_con_apertura_comercial. El front sólo deja
        # desplegar (ver sub_líneas) las líneas de este set; las demás se
        # muestran sin chevron y sin click, aunque tengan venta.
        lineas_apertura = lineas_con_apertura_comercial()

        # Acumulado en DOS niveles: por (línea, sub_línea) para las filas, y
        # por línea sola para el total del grupo. Las filas de las DOS
        # sub-empresas caen en el mismo acumulador: el código de artículo ya
        # es la clave. Un código sin match en `catalogo.articulo` (o con
        # match pero DePara sin cargar) cae en SIN_CLASIFICAR.
        acumulado_sl: dict[tuple[str, str], list[float]] = {}
        for codigo, unidades, unidades_mes, monto, monto_mes in filas_dos(
            cur, sql_m, sql_p, params
        ):
            cod_norm = str(codigo or "").strip()
            sub_linea, linea = mapa.get(
                cod_norm, (SUB_LINEA_SIN_CLASIFICAR, LINEA_SIN_CLASIFICAR)
            )
            acc = acumulado_sl.setdefault((linea, sub_linea), [0.0, 0.0, 0.0, 0.0])
            acc[0] += float(_safe(unidades) or 0)
            acc[1] += float(_safe(monto) or 0)
            acc[2] += float(_safe(unidades_mes) or 0)
            acc[3] += float(_safe(monto_mes) or 0)

        # Una sub_línea puede tener unidades > 0 y monto <= 0 (o al revés) por
        # las notas de crédito, así que cada vista filtra por SU métrica —
        # pero los dos objetos llevan los dos números para que el front
        # pueda mostrar el que quiera sin refetch. El filtro mira acumulado +
        # mes en curso: si no, una sub_línea que empezó a venderse este mes
        # no aparecería en ninguna de las dos listas.
        lineas: dict[str, dict] = {}
        for (linea, sub_linea), (u, m, um, mm) in acumulado_sl.items():
            grupo = lineas.setdefault(
                linea,
                {"linea": linea, "unidades": 0.0, "monto": 0.0,
                 "unidadesMes": 0.0, "montoMes": 0.0, "subLineas": []},
            )
            grupo["unidades"] += u
            grupo["monto"] += m
            grupo["unidadesMes"] += um
            grupo["montoMes"] += mm
            grupo["subLineas"].append({
                "subLinea": sub_linea,
                "unidades": round(u, 2),
                "monto": round(m, 2),
                "unidadesMes": round(um, 2),
                "montoMes": round(mm, 2),
            })

        def _armar(orden_key):
            # Cada sub_línea entra en SU métrica sólo si acumulado+mes > 0
            # (mismo criterio que antes por línea) — una línea sin ninguna
            # sub_línea activa en esta métrica no entra tampoco.
            out = []
            for g in lineas.values():
                subs = sorted(
                    (s for s in g["subLineas"] if orden_key(s) > 0),
                    key=orden_key,
                    reverse=True,
                )
                if not subs:
                    continue
                out.append({
                    "linea": g["linea"],
                    "unidades": round(g["unidades"], 2),
                    "monto": round(g["monto"], 2),
                    "unidadesMes": round(g["unidadesMes"], 2),
                    "montoMes": round(g["montoMes"], 2),
                    "subLineas": subs,
                    "aperturaComercial": g["linea"] in lineas_apertura,
                })
            out.sort(key=orden_key, reverse=True)
            return out

        por_unidades = _armar(lambda x: x["unidades"] + x["unidadesMes"])
        por_monto = _armar(lambda x: x["monto"] + x["montoMes"])

        # El ajuste sólo mueve $: el concepto no tiene cantidad (el SP del
        # BI emite 0 AS Cantidad), así que el ranking por unidades no se
        # toca. Ver bonificaciones.py.
        aj = _ajuste_rankings(dias_acum, dias_mes, dias_total, vendedor, forzar)

        resultado = {
            "desde": f"{desde_ym[0]:04d}-{desde_ym[1]:02d}" if desde_ym else None,
            "hasta": f"{hasta_ym[0]:04d}-{hasta_ym[1]:02d}" if hasta_ym else None,
            "mesActual": f"{mes_ym[0]:04d}-{mes_ym[1]:02d}",
            "totalLineas": len(por_unidades),
            "totalLineasMonto": len(por_monto),
            "porUnidades": por_unidades[:limit_i],
            "porMonto": por_monto[:limit_i],
            # Total NETO en $ de las dos ventanas (filas brutas + ajuste), ya
            # calculado acá (2026-09-20). El front no puede armarlo solo: a un
            # usuario NO admin la ruta le borra `ajuste`/`ajusteMes` del
            # payload y el total de esta pestaña quedaba en BRUTO, por encima
            # del de la pestaña Clientes (que trae el ajuste adentro de cada
            # fila desde 2026-09-08). Mismo universo que las filas que se
            # muestran: `porMonto`.
            "total": round(sum(g["monto"] for g in por_monto) + aj["ajuste"], 2),
            "totalMes": round(
                sum(g["montoMes"] for g in por_monto) + aj["ajusteMes"], 2
            ),
            **aj,
        }
        _TOP_LINEAS_CACHE[cache_key] = (ahora, resultado)
        return resultado
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────
# Clientes por línea — /ventas/vendedor/clientes-por-linea (
# 2026-08-18: al hacer click en una línea del ranking "Top líneas", el
# modal de /ventas/vendedor tiene que mostrar los CLIENTES que compraron esa
# línea).
#
# Drill-down "línea de un cliente puntual → quién más la compró"
# (fetch_ventas_por_linea / LineaRow, adentro del modo "cliente" del
# modal). Migrado a Postgres el 2026-09-15 (mismo día y mismo motivo que
# fetch_ventas_por_linea y fetch_top_lineas): la línea que manda el front ya
# no es Stk_Nivel1 de Magnus, es línea del catálogo `catalogo.*` de
# Postgres — el filtro de "artículos de esta línea" también se resuelve ahí
# (catalogo_pg.codigos_de_linea) en vez de un JOIN a Stk_Nivel1. La función
# HERMANA `fetch_clientes_por_sub_linea`, más abajo, hace lo mismo un nivel
# más abajo (sub_línea) para el ranking "Top líneas" del PIE de la página.
#
# Desde 2026-08-20 esta vista es el ESPEJO EXACTO de la
# tabla línea×año del modo "cliente" (fetch_ventas_por_linea): mismos dos
# años (anterior/actual), mismo desglose mensual y mismas dos métricas
# ($/unidades), para que el modal pueda ofrecer los mismos toggles
# "$/Unidades" y "por mes/por año". Cambia únicamente qué identifica a la
# fila: allá una línea, acá un cliente.
#
# Eso reemplaza la versión anterior, que traía un único total en $ por
# cliente dentro de una ventana desde/hasta y volvía a pegarle al back en
# cada toggle YTD/Meses. Ahora se traen los 2 años completos de una y el
# filtro YTD/Meses lo hace el front sobre el desglose mensual ya cargado —
# igual que en modo "cliente", y sin refetch por toggle.
#
# `linea == LINEA_SIN_CLASIFICAR` ("(Sin línea)") es el caso especial: no
# hay una lista de códigos que mandar (es el COMPLEMENTO — artículos sin
# match en `catalogo.articulo`, o el catálogo todavía sin cargar), así que
# ahí se trae el rango completo con CodArticu y se descarta en Python lo
# que SÍ matchea — mismo patrón y mismas consultas
# (`_SUB_CLIENTES_SIN_CLASIF_TPL`/`SQL_CLIENTES_SIN_CLASIF_WRAP`, definidas
# más abajo) que usa fetch_clientes_por_sub_linea para su propio
# SUB_LINEA_SIN_CLASIFICAR.
#
# Agregación en SQL (GROUP BY cliente/año/mes) y no en Python — el
# resultset que viaja es a lo sumo clientes × 24 filas, no un renglón por
# comprobante. El rango de fechas va como enteros Magnus sobre la columna
# vc.FecMovim (ver _resolver_rango / gotcha del HANDOFF: nunca comparar
# dbo.fecha_cla2sql(...) contra un parámetro de fecha). El año/mes también
# sale de comparar enteros — ver _case_anio_mes acá abajo.
_TOP_CLIENTES_LINEA_CACHE: dict[tuple, tuple[float, dict]] = {}
_TOP_CLIENTES_LINEA_TTL_SEG = 15 * 60  # 15 minutos

# El año/mes de cada comprobante NO se calcula con fechas: se mapea el entero
# Magnus `vc.FecMovim` a un YYYYMM con un CASE de rangos enteros, generado en
# Python con los límites de cada mes (_case_anio_mes). Sin DATEADD/YEAR/MONTH
# ni dbo.fecha_cla2sql: cualquiera de esos evalúa una función por renglón y,
# peor, DATEADD revienta la query entera con "Adding a value to a datetime
# column caused an overflow" si UNA sola fila tiene FecMovim basura (0,
# negativo, sentinela) — y el optimizador puede evaluar el SELECT antes del
# WHERE que las filtraría. Comparar enteros no puede fallar así.
#
# El CASE va en una subconsulta y el GROUP BY afuera, para no repetirlo.

# ── Variante rápida: arrancar por los ARTÍCULOS de la línea ────────────────
# (2026-08-26, medido, la razón sigue valiendo con la lista de códigos
# resuelta en Postgres) Arrancar por Clientes/comprobantes y filtrar por
# línea al final hacía Clustered Index Scan de `Ven_CompRenglon` (385.232
# filas leídas para quedarse con 3.896, sobre una tabla de 3,1 M) y 90.697
# key lookups en `Ven_CompCabecera` (7,5 GB).
#
# Una línea son POCOS artículos (PRECINTOS: 40) y existe el índice
# `V_REN_Cla_Articu (CodArticu, FecMovim)`: resolviendo primero los códigos
# (ahora vía catalogo_pg.codigos_de_linea) se entra por SEEK en vez de
# escanear la tabla entera. Medido en PRECINTOS: 4,07 s -> 0,69 s en frío,
# 1,34 s -> 0,53 s en caliente.
#
# `r.FecMovim BETWEEN ...` es lo que habilita el seek — sin eso el índice no
# sirve. Va con margen de ±_MARGEN_FECHA_RENGLON días y la fecha que MANDA
# sigue siendo `vc.FecMovim`.
#
# Solo aplica a una línea concreta. Para LINEA_SIN_CLASIFICAR se usa la
# variante SIN_CLASIFICAR de más abajo: ahí el criterio es el COMPLEMENTO
# (artículos sin match en el catálogo), no una lista de códigos.
#
# `_MARGEN_FECHA_RENGLON`, `SQL_CLIENTES_LINEA_WRAP` y las consultas
# `_SUB_CLIENTES_SUB_LINEA_ART_TPL`/`_SUB_CLIENTES_SIN_CLASIF_TPL`/
# `SQL_CLIENTES_SIN_CLASIF_WRAP` (agregadores genéricos, no dependen de qué
# nivel de la jerarquía vino la lista de códigos) se comparten con
# fetch_clientes_por_sub_linea, más abajo.
_MARGEN_FECHA_RENGLON = 7

# Nombre por MAX() y fuera del GROUP BY: depende de CodCliente, agruparlo
# también sólo agregaba una columna de texto a la clave del hash.
SQL_CLIENTES_LINEA_WRAP = """
SELECT CodCliente, MAX(Nombre) AS Nombre, AnioMes,
       SUM(Cant)  AS CantidadNeta,
       SUM(Monto) AS MontoNeto
FROM ({sub}) t
WHERE AnioMes IS NOT NULL
GROUP BY CodCliente, AnioMes
"""


def _case_anio_mes(anios: tuple[int, ...], columna: str = "vc.FecMovim") -> str:
    """CASE que mapea el entero Magnus de `columna` al YYYYMM del mes al que
    pertenece, con un WHEN por mes de cada año de `anios`. Todo comparación
    de enteros — ver la nota de arriba de por qué no se usa DATEADD."""
    ramas = []
    for anio in anios:
        for mes in range(1, 13):
            d1 = (date(anio, mes, 1) - BASE_DATE).days
            d2 = (date(anio, mes, calendar.monthrange(anio, mes)[1]) - BASE_DATE).days
            ramas.append(f"WHEN {columna} BETWEEN {d1} AND {d2} THEN {anio * 100 + mes}")
    return "CASE " + " ".join(ramas) + " ELSE NULL END"


def fetch_clientes_por_linea(
    linea: str,
    vendedor: int | None = None,
    limit: int = 1_000_000,  # "sin límite" (2026-08-19) — ver main.py
    forzar: bool = False,
) -> dict:
    """Clientes que compraron una línea de artículo (catálogo de Postgres),
    con el MISMO desglose que la tabla línea×año del modo "cliente": año
    anterior y año actual, cada uno con total y los 12 meses, en cantidad y
    en monto.

    Usado SOLO por el drill-down "línea de un cliente → quién más la
    compró" (LineaRow / fetch_ventas_por_linea, modo "cliente" del modal).
    El ranking "Top líneas" del pie usa fetch_clientes_por_sub_linea, más
    abajo — mismo catálogo, un nivel más abajo (sub_línea): acá se agrupa
    TODA la línea (todas sus sub_líneas juntas), no son intercambiables.

    El front elige qué métrica mostrar ($/unidades) y si desglosar por mes,
    y filtra YTD/Meses sobre los meses ya traídos — acá no se recorta nada
    por período (a diferencia de la versión anterior de este endpoint, que
    recibía desde/hasta).

    `linea`: nombre de línea tal cual lo devuelve fetch_ventas_por_linea
    (catálogo de Postgres) — o LINEA_SIN_CLASIFICAR, caso especial que no
    compara nombre sino que filtra los artículos sin match en el catálogo.

    `vendedor`: mismo criterio que fetch_top_clientes — si se pasa, sólo
    los comprobantes de ese vendedor y sus antecesores (ver vendedores.py).

    Orden: por monto total de los 2 años, de mayor a menor (mismo criterio
    de "los que más gastaron" que tenía la versión anterior)."""
    linea_norm = (linea or "").strip()
    if not linea_norm:
        raise ValueError("Falta 'linea'")

    hoy = date.today()
    anio_actual = hoy.year
    anio_anterior = anio_actual - 1
    dia_desde = (date(anio_anterior, 1, 1) - BASE_DATE).days
    dia_hasta = (date(anio_actual, 12, 31) - BASE_DATE).days

    limit_i = int(limit)
    cache_key = (linea_norm, clave_vendedor(vendedor), limit_i, anio_anterior, anio_actual)
    ahora = time.monotonic()
    if not forzar:
        cacheado = _TOP_CLIENTES_LINEA_CACHE.get(cache_key)
        if cacheado is not None and (ahora - cacheado[0]) < _TOP_CLIENTES_LINEA_TTL_SEG:
            return cacheado[1]

    es_sin_linea = linea_norm == LINEA_SIN_CLASIFICAR

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        case_am = _case_anio_mes((anio_anterior, anio_actual))

        clientes: dict[int, dict] = {}
        tot_anterior = _anio_vacio()
        tot_actual = _anio_vacio()

        def _acumular(filas, con_codigo: bool):
            """con_codigo=True: la fila trae CodArticu en la posición 2 (caso
            LINEA_SIN_CLASIFICAR, hay que descartar en Python lo que SÍ
            matchea)."""
            mapa = mapa_articulo_sub_linea() if con_codigo else None
            for fila in filas:
                if con_codigo:
                    cod, nombre, cod_articu, anio_mes, cant, monto = fila
                    if str(cod_articu or "").strip() in mapa:
                        continue  # tiene línea: no es Sin clasificar
                else:
                    cod, nombre, anio_mes, cant, monto = fila
                if cod is None or anio_mes is None:
                    continue
                anio, mes = divmod(int(anio_mes), 100)
                if anio not in (anio_actual, anio_anterior) or not 1 <= mes <= 12:
                    continue
                cod = int(cod)
                cant = float(_safe(cant) or 0)
                monto = float(_safe(monto) or 0)

                bucket = clientes.get(cod)
                if bucket is None:
                    bucket = {
                        "numero": cod,
                        "nombre": (str(nombre).strip() if nombre else None),
                        "anioAnterior": _anio_vacio(),
                        "anioActual": _anio_vacio(),
                    }
                    clientes[cod] = bucket

                destino = bucket["anioActual"] if anio == anio_actual else bucket["anioAnterior"]
                destino["cantidad"] += cant
                destino["monto"] += monto
                destino["meses"][mes - 1]["cantidad"] += cant
                destino["meses"][mes - 1]["monto"] += monto

                tot_destino = tot_actual if anio == anio_actual else tot_anterior
                tot_destino["cantidad"] += cant
                tot_destino["monto"] += monto
                tot_destino["meses"][mes - 1]["cantidad"] += cant
                tot_destino["meses"][mes - 1]["monto"] += monto

        if es_sin_linea:
            # Complemento del catálogo: SIN filtro de artículo del lado de
            # SQL Server — se trae el rango completo con CodArticu y se
            # descarta en Python lo que sí tiene match en Postgres. Reusa el
            # template de la función hermana (definido junto a ella, más
            # abajo).
            sub = _SUB_CLIENTES_SIN_CLASIF_TPL.format(case_anio_mes=case_am)
            sub = recortar_vendedor(sub, vendedor)
            sql_m = SQL_CLIENTES_SIN_CLASIF_WRAP.format(sub=sub)
            sql_p = SQL_CLIENTES_SIN_CLASIF_WRAP.format(sub=_prueba(sub))
            params = (dia_desde, dia_hasta)
            _acumular(filas_dos(cur, sql_m, sql_p, params), con_codigo=True)
        else:
            # Forma rápida: arranca por los artículos de la línea (TODAS sus
            # sub_líneas, resueltos en Postgres vía codigos_de_linea) y
            # entra a Ven_CompRenglon por seek, en chunks para no pasarse
            # del límite de parámetros de SQL Server.
            codigos = codigos_de_linea(linea_norm)
            m = _MARGEN_FECHA_RENGLON
            for i in range(0, len(codigos), _CHUNK_CODIGOS):
                chunk = codigos[i:i + _CHUNK_CODIGOS]
                placeholders = ",".join("?" for _ in chunk)
                sub = _SUB_CLIENTES_SUB_LINEA_ART_TPL.format(
                    case_anio_mes=case_am, placeholders=placeholders)
                # El recorte por vendedor se inyecta ANTES de armar la
                # gemela: es una línea de WHERE sobre `vc.vendedor`, sin
                # tablas `Ven_*`, así que sobrevive intacta la
                # transformación a PRUEBA.
                sub = recortar_vendedor(sub, vendedor)
                sql_m = SQL_CLIENTES_LINEA_WRAP.format(sub=sub)
                sql_p = SQL_CLIENTES_LINEA_WRAP.format(sub=_prueba(sub))
                params = tuple(chunk) + (dia_desde - m, dia_hasta + m, dia_desde, dia_hasta)
                _acumular(filas_dos(cur, sql_m, sql_p, params), con_codigo=False)

        clientes_out = []
        for b in clientes.values():
            b["anioAnterior"] = _round_anio(b["anioAnterior"])
            b["anioActual"] = _round_anio(b["anioActual"])
            clientes_out.append(b)
        clientes_out.sort(
            key=lambda b: b["anioAnterior"]["monto"] + b["anioActual"]["monto"],
            reverse=True,
        )

        resultado = {
            "linea": linea_norm,
            "anioAnterior": anio_anterior,
            "anioActual": anio_actual,
            "tieneDatos": bool(clientes_out),
            "totalClientes": len(clientes_out),
            "clientes": clientes_out[:limit_i],
            "totales": {
                "anioAnterior": _round_anio(tot_anterior),
                "anioActual": _round_anio(tot_actual),
            },
        }
        _TOP_CLIENTES_LINEA_CACHE[cache_key] = (ahora, resultado)
        return resultado
    finally:
        conn.close()


# Clientes por sub_línea — /ventas/vendedor/clientes-por-sub-linea (nuevo
# 2026-09-15). Hermana de fetch_clientes_por_linea (arriba, migrada a
# Postgres el mismo día): mismo contrato de salida, mismo desglose año×mes,
# mismo mecanismo (resolver códigos de artículo en Postgres y filtrar
# `r.CodArticu IN (...)` en Magnus, en chunks) — la diferencia es el nivel
# de la jerarquía: acá sub_línea puntual (para el ranking "Top líneas" del
# PIE, que agrupa por línea > sub_línea vía fetch_top_lineas), allá la línea
# completa (para el drill-down dentro de la ficha de un cliente).
#
# La sub_línea se resuelve con catalogo_pg.codigos_de_sub_linea (cacheado 15
# min) — la hermana usa codigos_de_linea, mismo mapa subyacente
# (mapa_articulo_sub_linea). SUB_LINEA_SIN_CLASIFICAR sigue el mismo patrón
# que el LINEA_SIN_CLASIFICAR de la función hermana: es el COMPLEMENTO
# (artículos sin match en `catalogo.articulo`), así que ahí no hay lista de
# códigos para filtrar del lado de SQL Server — se trae TODO el rango sin
# filtrar por artículo y se descarta en Python lo que SÍ tiene match.
_TOP_CLIENTES_SUBLINEA_CACHE: dict[tuple, tuple[float, dict]] = {}
_TOP_CLIENTES_SUBLINEA_TTL_SEG = 15 * 60  # 15 minutos

# Variante SIN_CLASIFICAR: trae TODO el rango con el código de artículo
# (para descartar en Python), sin filtro de artículo — mismo costo que tiene
# el caso LINEA_SIN_CLASIFICAR de la función hermana.
_SUB_CLIENTES_SIN_CLASIF_TPL = _solo_venta("""
SELECT
    c.CodCliente AS CodCliente,
    LTRIM(RTRIM(c.Cliente_Nombre)) AS Nombre,
    r.CodArticu AS CodArticu,
    {case_anio_mes} AS AnioMes,
    CASE cc.DebitoCredito WHEN 1 THEN r.Cantidad ELSE r.Cantidad * -1 END AS Cant,
    CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) ELSE (r.Cantidad * r.PrecioVenta) * -1 END AS Monto
FROM MAGNUS_SITD.dbo.Clientes c
JOIN Ven_CompCabecera vc ON vc.CodCliente = c.CodCliente
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
WHERE cc.EvitaInformesYListados <> 1
  AND vc.FecMovim BETWEEN ? AND ?
""" + MARCA_VENDEDOR + """
""")

# Tope de códigos por chunk: SQL Server no acepta más de ~2100 parámetros
# por consulta y este template ya usa 4 fijos (2 fechas de renglón + 2 de
# cabecera) — 900 deja margen de sobra y sigue siendo pocas idas y vueltas
# incluso para una sub_línea con varios miles de artículos.
_CHUNK_CODIGOS = 900

_SUB_CLIENTES_SUB_LINEA_ART_TPL = _solo_venta("""
SELECT
    c.CodCliente AS CodCliente,
    LTRIM(RTRIM(c.Cliente_Nombre)) AS Nombre,
    {case_anio_mes} AS AnioMes,
    CASE cc.DebitoCredito WHEN 1 THEN r.Cantidad ELSE r.Cantidad * -1 END AS Cant,
    CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) ELSE (r.Cantidad * r.PrecioVenta) * -1 END AS Monto
FROM Ven_CompRenglon r
JOIN Ven_CompCabecera vc        ON vc.NroMovVenta = r.NroMovVenta
JOIN Ven_CodCom cc              ON cc.CompCodigo  = vc.CompCodigo
JOIN MAGNUS_SITD.dbo.Clientes c ON c.CodCliente   = vc.CodCliente
WHERE cc.EvitaInformesYListados <> 1
  AND r.CodArticu IN ({placeholders})
  AND r.FecMovim  BETWEEN ? AND ?
  AND vc.FecMovim BETWEEN ? AND ?
""" + MARCA_VENDEDOR + """
""")

# Gemela de SQL_CLIENTES_LINEA_WRAP para el caso SIN_CLASIFICAR: el filtro
# "no tiene match en Postgres" se aplica en PYTHON después de traer las
# filas (ver _acumular), así que acá NO se puede agregar por (cliente,
# año/mes) todavía — perdería el CodArticu de cada renglón antes de poder
# filtrarlo. Se agrupa por (cliente, artículo, año/mes) — sigue siendo
# agregación en SQL, sólo con una dimensión más — y _acumular hace la suma
# final por cliente/año/mes en Python al descartar los artículos que sí
# matchean.
# El nombre del cliente sale con MAX() y NO entra al GROUP BY: depende
# funcionalmente de CodCliente, así que agruparlo también sólo engordaba la
# clave del hash con una columna de texto sobre millones de renglones.
SQL_CLIENTES_SIN_CLASIF_WRAP = """
SELECT CodCliente, MAX(Nombre) AS Nombre, CodArticu, AnioMes,
       SUM(Cant)  AS CantidadNeta,
       SUM(Monto) AS MontoNeto
FROM ({sub}) t
WHERE AnioMes IS NOT NULL
GROUP BY CodCliente, CodArticu, AnioMes
"""


def fetch_clientes_por_sub_linea(
    sub_linea: str,
    linea: str | None = None,
    vendedor: int | None = None,
    limit: int = 1_000_000,  # "sin límite" (2026-08-19) — ver main.py
    forzar: bool = False,
) -> dict:
    """Clientes que compraron una SUB_LÍNEA de artículo (catálogo de
    Postgres), con el MISMO desglose que la tabla línea×año del modo
    "cliente": año anterior y año actual, cada uno con total y los 12 meses,
    en cantidad y en monto. Hermana de fetch_clientes_por_linea — ver el
    comentario de arriba para por qué son DOS funciones y no una.

    El front elige qué métrica mostrar ($/unidades) y si desglosar por mes,
    y filtra YTD/Meses sobre los meses ya traídos — acá no se recorta nada
    por período.

    `sub_linea` + `linea`: tal cual los devuelve fetch_top_lineas — hacen
    falta LOS DOS porque el mismo nombre de sub_línea puede repetirse bajo
    líneas distintas (`catalogo.sub_linea` es UNIQUE(nombre, linea_id), no
    UNIQUE(nombre)). `sub_linea == SUB_LINEA_SIN_CLASIFICAR` es el caso
    especial: no compara nombre, filtra los artículos SIN match en
    `catalogo.articulo` (ignora `linea` en ese caso).

    `vendedor`: mismo criterio que fetch_top_clientes — si se pasa, sólo
    los comprobantes de ese vendedor y sus antecesores (ver vendedores.py).

    Orden: por monto total de los 2 años, de mayor a menor."""
    sub_linea_norm = (sub_linea or "").strip()
    if not sub_linea_norm:
        raise ValueError("Falta 'subLinea'")
    linea_norm = (linea or "").strip()
    es_sin_clasificar = sub_linea_norm == SUB_LINEA_SIN_CLASIFICAR
    if not es_sin_clasificar and not linea_norm:
        raise ValueError("Falta 'linea'")

    hoy = date.today()
    anio_actual = hoy.year
    anio_anterior = anio_actual - 1
    dia_desde = (date(anio_anterior, 1, 1) - BASE_DATE).days
    dia_hasta = (date(anio_actual, 12, 31) - BASE_DATE).days

    limit_i = int(limit)
    cache_key = (linea_norm, sub_linea_norm, clave_vendedor(vendedor), limit_i, anio_anterior, anio_actual)
    ahora = time.monotonic()
    if not forzar:
        cacheado = _TOP_CLIENTES_SUBLINEA_CACHE.get(cache_key)
        if cacheado is not None and (ahora - cacheado[0]) < _TOP_CLIENTES_SUBLINEA_TTL_SEG:
            return cacheado[1]

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        case_am = _case_anio_mes((anio_anterior, anio_actual))

        clientes: dict[int, dict] = {}
        tot_anterior = _anio_vacio()
        tot_actual = _anio_vacio()

        def _acumular(filas, con_codigo: bool):
            """con_codigo=True: la fila trae CodArticu en la posición 2 (caso
            SIN_CLASIFICAR, hay que descartar en Python lo que SÍ matchea)."""
            mapa = mapa_articulo_sub_linea() if con_codigo else None
            for fila in filas:
                if con_codigo:
                    cod, nombre, cod_articu, anio_mes, cant, monto = fila
                    if str(cod_articu or "").strip() in mapa:
                        continue  # tiene línea: no es Sin clasificar
                else:
                    cod, nombre, anio_mes, cant, monto = fila
                if cod is None or anio_mes is None:
                    continue
                anio, mes = divmod(int(anio_mes), 100)
                if anio not in (anio_actual, anio_anterior) or not 1 <= mes <= 12:
                    continue
                cod = int(cod)
                cant = float(_safe(cant) or 0)
                monto = float(_safe(monto) or 0)

                bucket = clientes.get(cod)
                if bucket is None:
                    bucket = {
                        "numero": cod,
                        "nombre": (str(nombre).strip() if nombre else None),
                        "anioAnterior": _anio_vacio(),
                        "anioActual": _anio_vacio(),
                    }
                    clientes[cod] = bucket

                destino = bucket["anioActual"] if anio == anio_actual else bucket["anioAnterior"]
                destino["cantidad"] += cant
                destino["monto"] += monto
                destino["meses"][mes - 1]["cantidad"] += cant
                destino["meses"][mes - 1]["monto"] += monto

                tot_destino = tot_actual if anio == anio_actual else tot_anterior
                tot_destino["cantidad"] += cant
                tot_destino["monto"] += monto
                tot_destino["meses"][mes - 1]["cantidad"] += cant
                tot_destino["meses"][mes - 1]["monto"] += monto

        if es_sin_clasificar:
            # Complemento del catálogo: SIN filtro de artículo del lado de
            # SQL Server (no hay "lista de códigos Sin clasificar" que
            # mandar) — se trae el rango completo con CodArticu y se
            # descarta en Python lo que sí tiene match en Postgres.
            sub = _SUB_CLIENTES_SIN_CLASIF_TPL.format(case_anio_mes=case_am)
            sub = recortar_vendedor(sub, vendedor)
            sql_m = SQL_CLIENTES_SIN_CLASIF_WRAP.format(sub=sub)
            sql_p = SQL_CLIENTES_SIN_CLASIF_WRAP.format(sub=_prueba(sub))
            params = (dia_desde, dia_hasta)
            _acumular(filas_dos(cur, sql_m, sql_p, params), con_codigo=True)
        else:
            # Forma rápida: arranca por los artículos de la sub_línea
            # (resueltos en Postgres) y entra a Ven_CompRenglon por seek, en
            # chunks para no pasarse del límite de parámetros de SQL Server.
            codigos = codigos_de_sub_linea(sub_linea_norm, linea_norm)
            m = _MARGEN_FECHA_RENGLON
            for i in range(0, len(codigos), _CHUNK_CODIGOS):
                chunk = codigos[i:i + _CHUNK_CODIGOS]
                placeholders = ",".join("?" for _ in chunk)
                sub = _SUB_CLIENTES_SUB_LINEA_ART_TPL.format(
                    case_anio_mes=case_am, placeholders=placeholders)
                # El recorte por vendedor se inyecta ANTES de armar la
                # gemela: es una línea de WHERE sobre `vc.vendedor`, sin
                # tablas `Ven_*`, así que sobrevive intacta la
                # transformación a PRUEBA.
                sub = recortar_vendedor(sub, vendedor)
                sql_m = SQL_CLIENTES_LINEA_WRAP.format(sub=sub)
                sql_p = SQL_CLIENTES_LINEA_WRAP.format(sub=_prueba(sub))
                params = tuple(chunk) + (dia_desde - m, dia_hasta + m, dia_desde, dia_hasta)
                _acumular(filas_dos(cur, sql_m, sql_p, params), con_codigo=False)

        clientes_out = []
        for b in clientes.values():
            b["anioAnterior"] = _round_anio(b["anioAnterior"])
            b["anioActual"] = _round_anio(b["anioActual"])
            clientes_out.append(b)
        clientes_out.sort(
            key=lambda b: b["anioAnterior"]["monto"] + b["anioActual"]["monto"],
            reverse=True,
        )

        resultado = {
            "linea": linea_norm,
            "subLinea": sub_linea_norm,
            "anioAnterior": anio_anterior,
            "anioActual": anio_actual,
            "tieneDatos": bool(clientes_out),
            "totalClientes": len(clientes_out),
            "clientes": clientes_out[:limit_i],
            "totales": {
                "anioAnterior": _round_anio(tot_anterior),
                "anioActual": _round_anio(tot_actual),
            },
        }
        _TOP_CLIENTES_SUBLINEA_CACHE[cache_key] = (ahora, resultado)
        return resultado
    finally:
        conn.close()


def fetch_ventas_por_linea(cod_cliente: int, vendedor: int | None = None) -> dict:
    """Ventas (cantidad neta y monto neto) de UN cliente, agrupadas por línea
    de artículo y por año actual/año anterior, con desglose mensual — para
    /ventas/vendedor. Ver docstring del módulo (arriba) para la fuente y el
    criterio de "venta neta".

    `vendedor` (2026-08-14, acceso por vendedor): si se
    pasa, se chequea que el cliente esté en la cartera de ese vendedor
    (cartera.cliente_es_de_vendedor — zona declarada o historial de
    facturación, mismo criterio exacto que usa el buscador de /clientes, así
    que un cliente que aparece en el buscador nunca es rechazado acá). Si no
    está, se devuelve `_bloqueado(...)` SIN calcular
    ni filtrar/agrupar nada más — nunca se arma `lineas`/`totales` reales
    para un cliente ajeno. `None` (admin) no filtra nada, mismo
    comportamiento que antes."""
    hoy = date.today()
    anio_actual = hoy.year
    anio_anterior = anio_actual - 1

    if vendedor is not None:
        if not cliente_es_de_vendedor(cod_cliente, vendedor):
            return _bloqueado(cod_cliente, anio_anterior, anio_actual)

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        # Las dos sub-empresas: mismas columnas, mismo parámetro. Se
        # concatenan las filas y el acumulador de abajo las suma por línea.
        cur.execute(SQL_VENTAS_CLIENTE, (int(cod_cliente),))
        cols = [c[0] for c in cur.description]
        filas = list(cur.fetchall())
        cur.execute(SQL_VENTAS_CLIENTE_PRUEBA, (int(cod_cliente),))
        filas += list(cur.fetchall())

        lineas: dict[str, dict] = {}
        tot_anterior = _anio_vacio()
        tot_actual = _anio_vacio()
        tiene_datos = False
        # Mapeo código de artículo -> (sub_línea, línea) del catálogo de
        # Postgres, cacheado 15 min — mismo mecanismo que fetch_top_lineas
        # (ver catalogo_pg.py). Se trae UNA vez para todo el historial del
        # cliente, no por renglón.
        mapa = mapa_articulo_sub_linea()

        for row in filas:
            d = dict(zip(cols, row))
            try:
                evita = int(d.get("Evita")) if d.get("Evita") is not None else 0
            except (TypeError, ValueError):
                evita = 0
            if evita == 1:
                continue
            fecha = d.get("Fecha")
            if fecha is None:
                continue
            anio = fecha.year
            if anio not in (anio_actual, anio_anterior):
                continue
            mes = fecha.month
            cod_articu = str(d.get("CodArticu") or "").strip()
            _, linea = mapa.get(cod_articu, (SUB_LINEA_SIN_CLASIFICAR, LINEA_SIN_CLASIFICAR))
            cant = float(_safe(d.get("CantidadNeta")) or 0)
            monto = float(_safe(d.get("MontoNeto")) or 0)
            tiene_datos = True

            bucket = lineas.get(linea)
            if bucket is None:
                bucket = {"linea": linea, "anioAnterior": _anio_vacio(), "anioActual": _anio_vacio()}
                lineas[linea] = bucket

            destino = bucket["anioActual"] if anio == anio_actual else bucket["anioAnterior"]
            destino["cantidad"] += cant
            destino["monto"] += monto
            destino["meses"][mes - 1]["cantidad"] += cant
            destino["meses"][mes - 1]["monto"] += monto

            tot_destino = tot_actual if anio == anio_actual else tot_anterior
            tot_destino["cantidad"] += cant
            tot_destino["monto"] += monto
            tot_destino["meses"][mes - 1]["cantidad"] += cant
            tot_destino["meses"][mes - 1]["monto"] += monto

        # Ajuste del cliente por mes (2026-09-08): comprobantes 23/24/25/60/62.
        # No tienen artículo, así que NO se pueden abrir por línea — las filas
        # de la tabla siguen en bruto y el ajuste entra en los TOTALES (año y
        # cada columna de mes) y viaja aparte en `ajustes` para poder
        # mostrarlo. Sin unidades: el concepto no tiene cantidad.
        ajustes_ant, ajustes_act = _anio_vacio(), _anio_vacio()
        try:
            from bonificaciones import ajuste_cliente_por_mes

            for (anio, mes), monto in ajuste_cliente_por_mes(
                cod_cliente, anio_anterior
            ).items():
                if anio not in (anio_actual, anio_anterior) or not monto:
                    continue
                destino = ajustes_act if anio == anio_actual else ajustes_ant
                tot_destino = tot_actual if anio == anio_actual else tot_anterior
                destino["monto"] += monto
                destino["meses"][mes - 1]["monto"] += monto
                tot_destino["monto"] += monto
                tot_destino["meses"][mes - 1]["monto"] += monto
                tiene_datos = True
        except Exception:
            ajustes_ant, ajustes_act = _anio_vacio(), _anio_vacio()

        lineas_out = []
        for b in lineas.values():
            b["anioAnterior"] = _round_anio(b["anioAnterior"])
            b["anioActual"] = _round_anio(b["anioActual"])
            lineas_out.append(b)
        # Orden por peso (cantidad total de las 2 años) — línea más vendida
        # primero, igual criterio que /compras/consumo (totalVendido desc).
        lineas_out.sort(
            key=lambda b: b["anioAnterior"]["cantidad"] + b["anioActual"]["cantidad"],
            reverse=True,
        )

        cliente_nombre = None
        try:
            cli = fetch_cliente(cod_cliente)
            if cli:
                cliente_nombre = cli.get("nombre")
        except Exception:
            cliente_nombre = None

        return {
            "cliente": {"codigo": int(cod_cliente), "nombre": cliente_nombre},
            "anioAnterior": anio_anterior,
            "anioActual": anio_actual,
            "tieneDatos": tiene_datos,
            "permitido": True,
            "lineas": lineas_out,
            "totales": {
                "anioAnterior": _round_anio(tot_anterior),
                "anioActual": _round_anio(tot_actual),
            },
            # Parte del total que NO está en ninguna fila (bonificaciones y
            # ajustes, sin línea). Ya está sumada adentro de `totales`.
            "ajustes": {
                "anioAnterior": _round_anio(ajustes_ant),
                "anioActual": _round_anio(ajustes_act),
            },
        }
    finally:
        conn.close()
