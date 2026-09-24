"""Bonificaciones y ajustes de venta (Magnus, SOLO LECTURA).

Qué resuelve
------------
Las vistas de ventas (`ventas.py`, `bulones.py`) leen `Ven_CompRenglon`: un
renglón por artículo. Los descuentos comerciales de Ever Wear NO se
instrumentan ahí — se emiten como notas de crédito por CONCEPTO, que viven en
`Ven_RenDebCre` y no tienen artículo. Por eso nunca restaron en las vistas y
los totales quedaban por encima del BI. Ene-ago 2026 son -840,7M, un 8,2% de
la venta con artículo.

Es la misma fuente que el BI: `_VEN_05_REAL_Debitos_y_Creditos` arma con esto
las filas `Concept(N)` de la tabla de hechos `MAGNUS_SITD.dbo.Ventas_Hechos`
(las que en el pivot caen bajo "Artículos Sin Patrón"). El recorte de acá es
el del SP, salvo el filtro de conceptos.

Criterio (cambiado 2026-09-07: por COMPROBANTE, no por concepto)
--------
· Entran los comprobantes de ajuste de la lista blanca de contaduría —
  `ventas.COMPROBANTES_AJUSTE`: 24 CREDITO BONIFICACION, 60 CREDITO BONIF.
  FUERA DE RECIBO, 25 CREDITO INTERNO, 23 CRED. BONIFIC. FISCAL (sin
  movimiento) y 62 AJUSTE SALDOS DEBITOS. Quedan afuera los financieros
  —12 débito por cheque rechazado, 13 intereses, 15 gastos de cheques,
  63 crédito cheque rechazado—, que SUMAN (+184M en ene-ago 2026) y no son
  venta.
· DENTRO de esos comprobantes NO se filtra por concepto: entra el renglón
  completo, salvo IIBB (`Ven_ConcDebCre.TotalizaImpEn = 6`, igual que el SP
  del BI). Esto reemplaza al filtro anterior `CodConcepto IN (3,4,12,24,28,
  29)`, que daba -813,2M contra -840,7M del criterio nuevo en ene-ago 2026.
  La diferencia son las dos puntas que el filtro por concepto trataba mal:
  conceptos financieros que viajan adentro de una NC comercial (el 25 lleva
  -1,9M de cheque rechazado) y conceptos comerciales que viajan adentro de un
  comprobante de débito descartado (el 15 lleva +8,6M de BONIFICACION y
  +10,7M de AJUSTES VENTAS).
· Sólo la sub-empresa REAL, igual que el resto de las vistas comerciales. El
  par PRUEBA (`PRU_Ven_RenDebCre`, vía `_VEN_06`) NO se suma, y no es sólo por
  consistencia: verificado 2026-09-04, PRUEBA es un registro paralelo que
  ESPEJA operaciones que ya están en REAL. Sobre la bulonería de 2026, 53 de
  87 renglones tienen gemelo exacto en REAL —mismo cliente, fecha, artículo,
  cantidad y precio al cuarto decimal—, el 73% del monto; hasta las notas de
  crédito de corrección están duplicadas. Sumarlo contaría esa plata dos
  veces. Ojo también con el maestro: `PRU_Ven_ConcDebCre` tiene los códigos
  corridos (allá el 29 es AJUSTE VENTAS EXENTO y se usa para siniestros de
  transporte, y el 31 es SINIESTROS), así que esta lista de conceptos NO se
  puede reusar para PRUEBA. Ver la nota de sub-empresas del proyecto.
  `finanza.py` sí suma PRUEBA a la facturación: es otro criterio, a propósito.
· El signo sale de `Ven_CodCom.DebitoCredito` igual que la venta: 1 = débito
  suma, 2 = crédito resta. Una NC de bonificación da negativo.
· NO hay unidades que restar: el concepto no tiene cantidad (el SP del BI
  emite `0 AS Cantidad`). Estas funciones devuelven sólo $.

Gotchas heredados (ver el docstring de ventas.py antes de tocar nada)
· Las fechas van SIEMPRE como enteros Magnus (días desde 1800-12-28)
  comparados contra la columna cruda. Nunca `dbo.fecha_cla2sql(...)` contra un
  parámetro ni DATEADD en el SELECT.
· El año/mes sale del CASE de rangos enteros de `ventas._case_anio_mes`.
"""
import os
import time
from datetime import date, timedelta

from vendedores import MARCA as MARCA_VENDEDOR, aplicar as recortar_vendedor
from vendedores import clave as clave_vendedor
from db import get_connection
from subempresas import (COMPROBANTES_AJUSTE_PRUEBA, filas_dos, sql_prueba,
                         unir)
from ventas import (BASE_DATE, COMPROBANTES_AJUSTE, COMPROBANTES_VENTA,
                    _case_anio_mes, _resolver_rango, _safe)

# Comprobantes que ajustan la VENTA y no tienen renglón de artículo. La lista
# blanca completa vive en ventas.py (COMPROBANTES_VENTA); acá se usa su
# partición `COMPROBANTES_AJUSTE` para no repetir el criterio.
_IN_COMPROBANTES = ",".join(str(c) for c in COMPROBANTES_AJUSTE)

# Recorte del SP del BI, con el filtro de conceptos reemplazado por el de
# comprobantes. `cc.CompCodigo IN (...)` es lo que hace selectiva la consulta
# junto con el rango de fechas (CompCodigo es columna del comprobante, no
# calculada); el join a Ven_Clientes está porque lo tiene el SP (es un lookup
# por PK y no descarta ninguna fila del período, verificado 2026-09-04).
#
# `TotalizaImpEn = 6` marca los conceptos de IIBB (33, 35, 36) y el SP los
# excluye — se mantiene. Va con ISNULL porque el join al maestro es LEFT: un
# concepto sin fila en `Ven_ConcDebCre` no puede desaparecer.
_FROM = """
FROM Ven_RenDebCre    rd
JOIN Ven_CompCabecera c   ON c.NroMovVenta = rd.NroMovVenta
JOIN Ven_CodCom       cc  ON cc.CompCodigo = c.CompCodigo
JOIN Ven_Clientes     cli ON cli.CodCliente = c.CodCliente
LEFT JOIN Ven_ConcDebCre cn ON cn.CodConcepto = rd.CodConcepto
WHERE cc.CompCodigo IN (%s)
  AND cc.EvitaInformesYListados <> 1
  AND ISNULL(cn.TotalizaImpEn, 0) <> 6
  AND c.FecMovim BETWEEN ? AND ?
""" % _IN_COMPROBANTES

_IMPORTE = "SUM(CASE cc.DebitoCredito WHEN 1 THEN rd.Importe ELSE rd.Importe * -1 END)"


# La sub-empresa PRUEBA (`PRU_Ven_*`) también emite notas de crédito por
# concepto y hay que restarlas: sin ellas el neto de /ventas/vendedor queda
# por encima del cubo del BI. Comprobantes de ajuste de PRUEBA: 23/24/25 (no
# existen 60 ni 62). Ver subempresas.py.
def _prueba(sql: str) -> str:
    return sql_prueba(sql, COMPROBANTES_VENTA, COMPROBANTES_AJUSTE)


_FROM_PRUEBA = _prueba(_FROM)

_TTL_SEG = 15 * 60
_CACHE: dict[tuple, tuple[float, dict]] = {}


def _conn():
    conn = get_connection("EVERWEAR")
    cur = conn.cursor()
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
    return conn, cur


def _cacheado(key: tuple, forzar: bool):
    if forzar:
        return None
    hit = _CACHE.get(key)
    if hit is not None and (time.monotonic() - hit[0]) < _TTL_SEG:
        return hit[1]
    return None


def _guardar(key: tuple, valor: dict) -> dict:
    _CACHE[key] = (time.monotonic(), valor)
    return valor


def _ym(t: tuple[int, int]) -> str:
    return "%04d-%02d" % t


def fetch_bonificaciones(desde: str | None = None, hasta: str | None = None,
                         vendedor: int | None = None,
                         forzar: bool = False) -> dict:
    """Bonificaciones y ajustes de venta de un rango de meses.

    `vendedor`: acota al vendedor grabado en el comprobante de la ND/NC
    (`Ven_CompCabecera.Vendedor`), que es el mismo criterio que el ranking de
    vendedores de bulones.py — no la cartera del cliente.

    `desde`/`hasta` ('YYYY-MM'), ambos meses completos; default, la ventana
    fija de _resolver_rango. Devuelve el total y tres aperturas: por concepto,
    por mes y por vendedor. Todo en $ — no hay unidades.

    Ojo con el alcance: el importe es de TODA la empresa, no de una línea de
    artículo. Restarlo dentro de una vista acotada a una línea (bulonería)
    sobredimensiona el descuento; ahí hay que prorratear o mostrarlo aparte.
    """
    desde_ym, hasta_ym, d1, d2 = _resolver_rango(desde, hasta)
    key = ("bonif", desde_ym, hasta_ym, vendedor)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    where = _FROM
    where_p = _FROM_PRUEBA
    params: tuple = (d1, d2)
    if vendedor is not None:
        cola = "  AND c.Vendedor = ?\n"
        where = _FROM + cola
        where_p = _FROM_PRUEBA + cola
        params = (d1, d2, int(vendedor))

    anios = tuple(range(desde_ym[0], hasta_ym[0] + 1))
    case_mes = _case_anio_mes(anios, "c.FecMovim")

    conn, cur = _conn()
    try:
        # Cada apertura se pide a las DOS sub-empresas y se sumariza por su
        # clave en Python (`unir`). Los códigos de comprobante y de concepto
        # de ajuste significan lo mismo en las dos (23/24/25 = bonific.
        # fiscal / bonificación / crédito interno), así que agrupar por código
        # es correcto; el detalle lo pone el primer grupo que aparece.
        filas = filas_dos(
            cur, f"SELECT {_IMPORTE} AS Importe, COUNT(*) AS Renglones {where}",
            f"SELECT {_IMPORTE} AS Importe, COUNT(*) AS Renglones {where_p}", params)
        total = round(sum(float(_safe(f[0]) or 0) for f in filas), 2)
        renglones = sum(int(f[1] or 0) for f in filas)

        sel = (f"SELECT cc.CompCodigo, MAX(LTRIM(RTRIM(cc.Detalle))) AS Detalle, "
               f"{_IMPORTE} AS Importe %s GROUP BY cc.CompCodigo")
        por_comprobante = [
            {"comprobante": int(c), "detalle": (d or "").strip() or str(c),
             "monto": round(float(_safe(m) or 0), 2)}
            for c, d, m in unir(
                filas_dos(cur, sel % where, sel % where_p, params), (0,), (2,))
        ]
        por_comprobante.sort(key=lambda x: x["monto"])

        sel = (f"SELECT rd.CodConcepto, MAX(LTRIM(RTRIM(cn.Detalle))) AS Detalle, "
               f"{_IMPORTE} AS Importe %s GROUP BY rd.CodConcepto")
        por_concepto = [
            {"concepto": int(c), "detalle": (d or "").strip() or str(c),
             "monto": round(float(_safe(m) or 0), 2)}
            for c, d, m in unir(
                filas_dos(cur, sel % where, sel % where_p, params), (0,), (2,))
        ]
        por_concepto.sort(key=lambda x: x["monto"])

        sel = (f"SELECT {case_mes} AS AnioMes, {_IMPORTE} AS Importe "
               f"%s GROUP BY {case_mes}")
        por_mes = [
            {"mes": "%04d-%02d" % (int(am) // 100, int(am) % 100),
             "monto": round(float(_safe(m) or 0), 2)}
            for am, m in unir(
                filas_dos(cur, sel % where, sel % where_p, params), (0,), (1,))
            if am is not None
        ]
        por_mes.sort(key=lambda x: x["mes"])

        sel = f"SELECT c.Vendedor, {_IMPORTE} AS Importe %s GROUP BY c.Vendedor"
        por_vendedor = [
            {"codigo": int(v), "monto": round(float(_safe(m) or 0), 2)}
            for v, m in unir(
                filas_dos(cur, sel % where, sel % where_p, params), (0,), (1,))
            if v is not None
        ]
        por_vendedor.sort(key=lambda x: x["monto"])
    finally:
        cur.close()
        conn.close()

    return _guardar(key, {
        "desde": _ym(desde_ym),
        "hasta": _ym(hasta_ym),
        "comprobantes": list(COMPROBANTES_AJUSTE),
        "comprobantesPrueba": list(COMPROBANTES_AJUSTE_PRUEBA),
        "total": total,
        "renglones": renglones,
        "porComprobante": por_comprobante,
        "porConcepto": por_concepto,
        "porMes": por_mes,
        "porVendedor": por_vendedor,
    })


# ──────────────────────────────────────────────────────────────────────────
# Prorrateo a la línea BULONERÍA
# ──────────────────────────────────────────────────────────────────────────
# La bonificación no tiene artículo y por lo tanto no tiene línea: es de toda
# la empresa. Para /ventas/bulones se prorratea por la PARTICIPACIÓN de la
# línea en la venta con artículo del mismo rango.
#
# Por qué el prorrateo GLOBAL y no uno por vendedor: medido 2026-09-04 sobre
# ene-ago, las dos formas dan casi lo mismo (−2.641.778 global contra
# −2.648.775 sumando el prorrateo vendedor por vendedor, 0,26% de diferencia),
# pero la participación individual es dispar y sin sentido comercial — el
# vendedor 804 tiene 36% de bulonería sobre 1,8M de venta, el 18000 un 11,7%
# con CERO bonificación registrada, y el resto está por debajo del 0,7%.
# Repartir por esa proporción mete ruido en el ranking sin ganar exactitud.
#
# La misma línea que bulones.py (LIKE 'BULON%' contra Stk_Nivel1, que tiene 82
# filas) para que las dos vistas hablen de lo mismo. Las dos sumas salen de UNA
# sola pasada por Ven_CompRenglon: el total y el de bulonería se calculan en el
# mismo GROUP.
#
# OJO con la forma de escribirlo: bulones.py resuelve la línea con
# `ap.Nivel1 IN (SELECT …)` en el WHERE, pero acá el filtro tiene que ir
# ADENTRO de un SUM y SQL Server no admite una subconsulta dentro de un
# agregado ("No es posible usar una función de agregado con una expresión que
# contiene un agregado o una subconsulta", error 130). Por eso la lista de
# Nivel1 de bulonería entra como LEFT JOIN a una tabla derivada y el CASE
# pregunta si matcheó: mismo resultado, un solo LIKE resuelto una vez, y la
# comparación por fila termina siendo de enteros. El DISTINCT de la derivada no
# es decorativo: sin él, un Nivel1 repetido en Stk_Nivel1 multiplicaría los
# renglones del LEFT JOIN e inflaría VentaTotal, que es el DENOMINADOR del
# prorrateo.
_LINEA_BULON_LIKE = os.getenv("BULONES_LINEA_LIKE", "BULON%")

_MONTO_VENTA = ("CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) "
                "ELSE (r.Cantidad * r.PrecioVenta) * -1 END")

_SQL_PARTICIPACION = f"""
SELECT SUM({_MONTO_VENTA}) AS VentaTotal,
       SUM(CASE WHEN bul.Nivel1 IS NOT NULL THEN {_MONTO_VENTA} ELSE 0 END) AS VentaBulones
FROM Ven_CompCabecera vc
JOIN Ven_CompRenglon r    ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc        ON cc.CompCodigo = vc.CompCodigo
JOIN StkFer_Articulos  s  ON s.CodArticulo = r.CodArticu
JOIN StkFer_ArtParamet ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN (SELECT DISTINCT n.Nivel1 FROM Stk_Nivel1 n
            WHERE LTRIM(RTRIM(n.Detalle)) LIKE '{_LINEA_BULON_LIKE}') bul
       ON bul.Nivel1 = ap.Nivel1
WHERE cc.EvitaInformesYListados <> 1
  AND vc.FecMovim BETWEEN ? AND ?
"""

_SQL_PARTICIPACION_PRUEBA = _prueba(_SQL_PARTICIPACION)


def fetch_bonificacion_bulones(desde: str | None = None, hasta: str | None = None,
                               forzar: bool = False) -> dict:
    """Cuánto de la bonificación de la empresa le toca a BULONERÍA.

    Devuelve el total de la empresa, la participación de la línea en la venta
    con artículo y el monto prorrateado — los tres, porque el número que sirve
    para leer la vista es el prorrateado pero SIN el total no se entiende de
    dónde sale.

    No lleva `vendedor`: es un número de empresa. Acotarlo a la cartera de un
    no-admin daría un prorrateo sobre una venta parcial y no significaría nada.

    Referencia de la medición (ene-ago 2026): bonificación −813,2M,
    participación de bulonería 0,3249% (33,3M sobre 10.256,8M), prorrateado
    −2,64M, que es el 7,9% de la venta de la línea.
    """
    desde_ym, hasta_ym, d1, d2 = _resolver_rango(desde, hasta)
    key = ("bonif-bul", desde_ym, hasta_ym)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    data = fetch_bonificaciones(desde=desde, hasta=hasta, forzar=forzar)
    total = data["total"]

    conn, cur = _conn()
    try:
        # El denominador del prorrateo es la venta de la EMPRESA: las dos
        # sub-empresas, o la participación de bulonería queda inflada.
        filas = filas_dos(cur, _SQL_PARTICIPACION, _SQL_PARTICIPACION_PRUEBA,
                          (d1, d2))
        venta_total = sum(float(_safe(f[0]) or 0) for f in filas)
        venta_bulones = sum(float(_safe(f[1]) or 0) for f in filas)
    finally:
        cur.close()
        conn.close()

    # Sin venta con artículo en el rango no hay proporción que aplicar. Pasa
    # con rangos vacíos; devolver 0 es más honesto que dividir por cero.
    participacion = (venta_bulones / venta_total) if venta_total else 0.0

    return _guardar(key, {
        "desde": _ym(desde_ym),
        "hasta": _ym(hasta_ym),
        "bonificacionEmpresa": total,
        "ventaTotal": round(venta_total, 2),
        "ventaBulones": round(venta_bulones, 2),
        "participacion": round(participacion, 6),
        "montoBulones": round(total * participacion, 2),
        "porConcepto": data["porConcepto"],
        "porMes": data["porMes"],
    })


def bonificacion_por_vendedor(desde: str | None = None, hasta: str | None = None,
                              forzar: bool = False) -> dict[int, float]:
    """{codigo_vendedor: monto} para restar de un ranking ya armado, sin pedir
    la apertura completa. Sale del mismo cache que fetch_bonificaciones."""
    data = fetch_bonificaciones(desde=desde, hasta=hasta, forzar=forzar)
    return {v["codigo"]: v["monto"] for v in data["porVendedor"]}


# ──────────────────────────────────────────────────────────────────────────
# Ajuste de las DOS ventanas de /ventas/vendedor (acumulado + mes en curso)
# ──────────────────────────────────────────────────────────────────────────
# Los rankings de esa vista traen cada fila con su monto del acumulado y su
# monto del mes en curso (ver ventas._rango_ytd_y_mes). El ajuste tiene que
# venir con la misma forma para poder mostrarse en el pie de la tabla:
# bruto → ajuste → neto, en las dos columnas.
#
# Sale de UNA sola consulta con dos SUM(CASE ...), igual que ventas._ventana,
# y con un BETWEEN externo que cubre la unión de las dos ventanas para que el
# filtro siga siendo sargable sobre `cab.FecMovim`.
#
# Criterio de vendedor: acá NO se usa `Ven_CompCabecera.Vendedor` de la nota
# de crédito sino la CARTERA del cliente (mismo JOIN que el ranking al que se
# le resta). Mezclar los dos criterios en una misma tabla haría que el neto
# no cierre: el bruto sale de la cartera, así que el ajuste también.
# `bonificacion_por_vendedor` (más abajo) sigue usando el vendedor del
# comprobante — es para el ranking de vendedores, que se arma con ese eje.
_AJUSTE_ROW = "CASE cc.DebitoCredito WHEN 1 THEN rd.Importe ELSE rd.Importe * -1 END"

# La marca de vendedor (vendedores.MARCA) se reemplaza al ejecutar por
# `AND cab.vendedor IN (...)` — el vendedor del COMPROBANTE, que desde
# 2026-09-08 es el eje de toda la vista. Con vendedor None se borra sola y
# queda la consulta de "toda la empresa": una sola constante para los dos
# casos, y como la marca no consume `?`, la lista de parámetros no cambia.
_WHERE_AJUSTE = ("""
WHERE cc.CompCodigo IN (%s)
  AND cc.EvitaInformesYListados <> 1
  AND ISNULL(cn.TotalizaImpEn, 0) <> 6
  AND cab.FecMovim BETWEEN ? AND ?
""" % _IN_COMPROBANTES) + MARCA_VENDEDOR + "\n"

_SELECT_AJUSTE = f"""
SELECT
    SUM(CASE WHEN cab.FecMovim BETWEEN ? AND ? THEN {_AJUSTE_ROW} ELSE 0 END) AS Acum,
    SUM(CASE WHEN cab.FecMovim BETWEEN ? AND ? THEN {_AJUSTE_ROW} ELSE 0 END) AS Mes
"""

_SQL_AJUSTE_TODOS = _SELECT_AJUSTE + """
FROM Ven_RenDebCre    rd
JOIN Ven_CompCabecera cab ON cab.NroMovVenta = rd.NroMovVenta
JOIN Ven_CodCom       cc  ON cc.CompCodigo   = cab.CompCodigo
LEFT JOIN Ven_ConcDebCre cn ON cn.CodConcepto = rd.CodConcepto
""" + _WHERE_AJUSTE

_SQL_AJUSTE_TODOS_PRUEBA = _prueba(_SQL_AJUSTE_TODOS)


def ajuste_ventanas(dias_acum: tuple[int, int], dias_mes: tuple[int, int],
                    dias_total: tuple[int, int],
                    vendedor: int | None = None,
                    forzar: bool = False) -> dict:
    """Ajuste neto (notas de crédito de bonificación y ajustes de saldo) de
    las dos ventanas de /ventas/vendedor.

    Devuelve `{"acum": float, "mes": float}`, ya con signo: negativo cuando
    hay bonificación (que es lo normal). Sumarlo al bruto da el neto.

    Los tres rangos son enteros Magnus, tal como los devuelve
    ventas._rango_ytd_y_mes — `dias_total` es la unión de los otros dos y es
    el que va al WHERE.
    """
    key = ("aj-vent", dias_acum, dias_mes, clave_vendedor(vendedor))
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    # Orden de los "?": los dos CASE del SELECT y al final el WHERE. El
    # recorte por vendedor no consume parámetros. Mismo criterio que ventas.py.
    sql = recortar_vendedor(_SQL_AJUSTE_TODOS, vendedor, "cab")
    sql_p = recortar_vendedor(_SQL_AJUSTE_TODOS_PRUEBA, vendedor, "cab")
    params = dias_acum + dias_mes + dias_total

    conn, cur = _conn()
    try:
        # Una fila por sub-empresa, se suman: el ajuste del pie tiene que ser
        # el de la empresa entera.
        filas = filas_dos(cur, sql, sql_p, params)
        acum = round(sum(float(_safe(f[0]) or 0) for f in filas), 2)
        mes = round(sum(float(_safe(f[1]) or 0) for f in filas), 2)
    finally:
        cur.close()
        conn.close()

    return _guardar(key, {"acum": acum, "mes": mes})


# ──────────────────────────────────────────────────────────────────────────
# Ajuste POR CLIENTE (2026-09-08)
# ──────────────────────────────────────────────────────────────────────────
# `ajuste_ventanas` devuelve UN número para todo el ranking y por eso el
# ajuste sólo podía vivir en el pie de la tabla. La ND/NC por concepto SÍ
# tiene cliente (`Ven_CompCabecera.CodCliente`) y vendedor: lo único que no
# tiene es artículo, o sea LÍNEA. Así que se puede imputar por cliente —
# es lo que hacen estas dos funciones — y con eso las columnas del ranking
# de clientes y los totales de la tabla del cliente pasan a contemplar los
# 13 comprobantes de la lista blanca, no sólo los 8 que tienen artículo.
# Los cortes por LÍNEA siguen en bruto a propósito: repartir una NC de
# empresa entre líneas sería un supuesto.
#
# Mismo criterio de vendedor que `ajuste_ventanas`: `cab.vendedor` (más los
# códigos de sus antecesores), porque es el eje con el que se arma el bruto
# al que se le suma. Hasta 2026-09-08 era la CARTERA del cliente, junto con
# el resto de la vista.
_SELECT_AJUSTE_CLI = f"""
SELECT
    cab.CodCliente AS CodCliente,
    SUM(CASE WHEN cab.FecMovim BETWEEN ? AND ? THEN {_AJUSTE_ROW} ELSE 0 END) AS Acum,
    SUM(CASE WHEN cab.FecMovim BETWEEN ? AND ? THEN {_AJUSTE_ROW} ELSE 0 END) AS Mes
"""

_GROUP_CLI = "GROUP BY cab.CodCliente\n"

_SQL_AJUSTE_CLI_TODOS = _SELECT_AJUSTE_CLI + """
FROM Ven_RenDebCre    rd
JOIN Ven_CompCabecera cab ON cab.NroMovVenta = rd.NroMovVenta
JOIN Ven_CodCom       cc  ON cc.CompCodigo   = cab.CompCodigo
LEFT JOIN Ven_ConcDebCre cn ON cn.CodConcepto = rd.CodConcepto
""" + _WHERE_AJUSTE + _GROUP_CLI

_SQL_AJUSTE_CLI_TODOS_PRUEBA = _prueba(_SQL_AJUSTE_CLI_TODOS)


def ajuste_por_cliente(dias_acum: tuple[int, int], dias_mes: tuple[int, int],
                       dias_total: tuple[int, int],
                       vendedor: int | None = None,
                       forzar: bool = False) -> dict[int, tuple[float, float]]:
    """{CodCliente: (ajuste_acumulado, ajuste_mes_en_curso)} de las dos
    ventanas de /ventas/vendedor, ya con signo (negativo = bonificación).

    Mismos rangos y mismo recorte por vendedor que `ajuste_ventanas`, de una
    sola pasada por sub-empresa. Cachea 15 min como el resto del módulo."""
    key = ("aj-cli", dias_acum, dias_mes, clave_vendedor(vendedor))
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    sql = recortar_vendedor(_SQL_AJUSTE_CLI_TODOS, vendedor, "cab")
    sql_p = recortar_vendedor(_SQL_AJUSTE_CLI_TODOS_PRUEBA, vendedor, "cab")
    params = dias_acum + dias_mes + dias_total

    conn, cur = _conn()
    try:
        out: dict[int, tuple[float, float]] = {}
        for cod, acum, mes in unir(filas_dos(cur, sql, sql_p, params), (0,), (1, 2)):
            if cod is None:
                continue
            a = round(float(_safe(acum) or 0), 2)
            m = round(float(_safe(mes) or 0), 2)
            if a or m:
                out[int(cod)] = (a, m)
    finally:
        cur.close()
        conn.close()
    return _guardar(key, out)


# Apertura mensual del ajuste de UN cliente — para los totales de la tabla
# línea×mes de /ventas/vendedor. Se filtra por `CodCliente` (columna simple,
# sargable) y por un piso de `FecMovim` entero: nunca contra una fecha
# calculada (ver el gotcha de fechas en ventas.py). El GROUP BY por FecMovim
# devuelve pocas filas por cliente y el año/mes se arma en Python.
_SQL_AJUSTE_CLI_DIA = f"""
SELECT cab.FecMovim AS Dia, {_IMPORTE} AS Importe
FROM Ven_RenDebCre    rd
JOIN Ven_CompCabecera cab ON cab.NroMovVenta = rd.NroMovVenta
JOIN Ven_CodCom       cc  ON cc.CompCodigo   = cab.CompCodigo
LEFT JOIN Ven_ConcDebCre cn ON cn.CodConcepto = rd.CodConcepto
WHERE cc.CompCodigo IN ({_IN_COMPROBANTES})
  AND cc.EvitaInformesYListados <> 1
  AND ISNULL(cn.TotalizaImpEn, 0) <> 6
  AND cab.CodCliente = ?
  AND cab.FecMovim >= ?
GROUP BY cab.FecMovim
"""

_SQL_AJUSTE_CLI_DIA_PRUEBA = _prueba(_SQL_AJUSTE_CLI_DIA)


def ajuste_cliente_por_mes(cod_cliente: int, anio_desde: int,
                           forzar: bool = False) -> dict[tuple[int, int], float]:
    """{(año, mes): monto} del ajuste de un cliente, desde el 1/1/`anio_desde`.
    Signo incluido; sin unidades (el concepto no tiene cantidad)."""
    key = ("aj-cli-mes", int(cod_cliente), int(anio_desde))
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    piso = (date(int(anio_desde), 1, 1) - BASE_DATE).days
    params = (int(cod_cliente), piso)

    conn, cur = _conn()
    try:
        out: dict[tuple[int, int], float] = {}
        for dia, importe in filas_dos(
            cur, _SQL_AJUSTE_CLI_DIA, _SQL_AJUSTE_CLI_DIA_PRUEBA, params
        ):
            if dia is None:
                continue
            f = BASE_DATE + timedelta(days=int(dia))
            k = (f.year, f.month)
            out[k] = out.get(k, 0.0) + float(_safe(importe) or 0)
    finally:
        cur.close()
        conn.close()
    return _guardar(key, out)
