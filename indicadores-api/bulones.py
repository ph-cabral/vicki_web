"""
Ventas POR LÍNEA (Magnus, SOLO LECTURA) — para /ventas/bulones, que en el
menú se llama "Líneas".

2026-09-23 — LA VISTA SE ABRIÓ A TODAS LAS LÍNEAS. Hasta acá todo estaba
clavado a BULONERÍA vía Stk_Nivel1 (catálogo de Magnus). Ahora cada consulta
recibe `linea` = `catalogo.linea.id` de Postgres (el MISMO catálogo Pool >
Línea > Sub Línea > Patrón que usa /ventas/vendedor, ver catalogo_pg.py) y se
acota a los códigos de artículo de esa línea con `r.CodArticu IN (...)` +
`r.FecMovim BETWEEN` (seek por el índice V_REN_Cla_Articu, en chunks de
_CHUNK_CODIGOS — mismo mecanismo que fetch_clientes_por_linea de ventas.py).
`linea=None` = la línea por defecto (Bulones). NO se mira apertura
comercial: acá cualquier línea se abre entera. Qué líneas puede pedir cada
usuario lo resuelve el front (everwear.usuario_linea_venta, ver
lib/ventas/lineasAcceso.ts); este módulo no valida permisos.

Consecuencia: Bulones ahora es la línea "Bulones" del catálogo (≈361
artículos) y no Stk_Nivel1 = BULONERÍA (377). El total puede moverse un poco
respecto de lo que se veía antes; queda alineado con /ventas/vendedor.

Lo que sigue es el docstring original (sigue valiendo, cambiando
"BULONERÍA" por "la línea elegida"):

 2026-08-26: "una vista igual a /ventas/vendedor pero con
agregados". Las diferencias con ventas.py son TRES y sólo tres:

  1. TODO está filtrado a la línea BULONERÍA (Stk_Nivel1.Detalle LIKE
     'BULON%' — el LIKE evita depender del acento/plural exacto con el que
     está cargado el catálogo). Ninguna consulta de este módulo devuelve
     nada de otra línea.
  2. Como la línea es UNA sola, el eje "línea" pierde sentido y se
     reemplaza por el CÓDIGO PATRÓN (StkFer_Articulos.ArticuloPatron), que
     es el que agrupa los artículos adentro de la línea. Se muestra el
     NOMBRE del patrón (StkFer_Articulos.DetallePatron) — el código es sólo
     un número y no dice nada; viaja igual en el payload (`patron`) porque
     es la clave del drill-down. El nombre va en `detalle`.
  3. Se agrega un tercer ranking: VENDEDORES — TODOS los que figuran en el
     comprobante (Ven_CompCabecera.vendedor), sin filtrar por estado ni por
     "que sea una persona": MOSTRADOR, ECOMMERCE y demás canales facturan
     bulonería y tienen que verse. Ver fetch_top_vendedores.

Fuente y criterio de "venta neta": IDÉNTICOS a ventas.py (Ven_CompCabecera +
Ven_CompRenglon, neto de nota de crédito según Ven_CodCom.DebitoCredito,
filtro cc.EvitaInformesYListados <> 1 + la lista blanca
COMPROBANTES_VENTA, mes = FecMovim del comprobante). Ver
el docstring de ventas.py y HANDOFF_extracciones_sql.md.

Gotchas heredados de ventas.py (NO tocar sin leer eso primero):
  · Las fechas van SIEMPRE como enteros Magnus (días desde 1800-12-28)
    comparados contra vc.FecMovim. Nunca dbo.fecha_cla2sql(...) contra un
    parámetro de fecha (no filtra bien con el driver viejo) ni DATEADD en el
    SELECT (revienta la query entera si una fila tiene FecMovim basura).
  · El año/mes sale de un CASE de rangos enteros generado en Python
    (_case_anio_mes de ventas.py), no de YEAR()/MONTH().
  · Acceso por vendedor: un no-admin sólo ve los clientes de SU cartera
    (zona declarada o historial de facturación) — el criterio está en
    cartera.py, mismo que usa clientes.py. Migrado 2026-08-27 del maestro
    `Ped_Usu_Arma` al correcto, `Vendedores`; ver cartera.py.
"""
from datetime import date
import os
import time

from db import get_connection
from vendedores import (MARCA as MARCA_VENDEDOR, aplicar as recortar_vendedor,
                        dueno_de)
from subempresas import filas_dos, sql_prueba, unir
from catalogo_pg import codigos_de_linea_id, linea_por_defecto, linea_por_id
from ventas import (
    BASE_DATE,
    _CHUNK_CODIGOS,
    _MARGEN_FECHA_RENGLON,
    COMPROBANTES_AJUSTE,
    COMPROBANTES_VENTA,
    _anio_vacio,
    _case_anio_mes,
    _rango_ytd_y_mes,
    _round_anio,
    _safe,
    _ventana,
)

# Qué comprobantes son VENTA. La lista blanca se define una sola vez en
# ventas.py (COMPROBANTES_VENTA, criterio de contaduría 2026-09-07); acá se
# arma el pedazo de WHERE que comparten todas las consultas de este módulo,
# para que /ventas/bulones y /ventas/vendedor no puedan divergir.
# Los comprobantes de ajuste (24/25/60/23/62) están en la lista pero no
# tienen renglón de artículo, así que no aportan nada a estas consultas: su
# importe vive en Ven_RenDebCre y lo trae bonificaciones.py.
_COMP = "cc.EvitaInformesYListados <> 1 AND cc.CompCodigo IN (%s)" % ",".join(
    str(c) for c in COMPROBANTES_VENTA
)

# Filtro de línea (2026-09-23). Reemplaza al viejo COND_BULON (Stk_Nivel1
# LIKE 'BULON%'). La marca se reemplaza por los `?` de un chunk de códigos en
# _filas_linea; los códigos van como PARÁMETROS (no inlineados) porque son
# texto. Tiene que ser lo ÚLTIMO del WHERE en el texto: sus params van al
# final de la lista.
_PH_CODIGOS = "/*@@CODIGOS@@*/"
COND_LINEA = (f"r.CodArticu IN ({_PH_CODIGOS})\n"
              "  AND r.FecMovim BETWEEN ? AND ?")


# "Todas las líneas" (2026-09-23): `linea=0`. Dos sabores:
#   · sin `lineas` (ADMIN) → SIN filtro de artículo: toda la venta, incluidos
#     los artículos que no están en el catálogo — así el total cierra con el
#     de /ventas/vendedor. COND_LINEA se reemplaza por `1=1` (no consume
#     parámetros) y la consulta es UNA por sub-empresa, sin chunks.
#   · con `lineas` (no-admin con varias líneas habilitadas) → la UNIÓN de
#     los códigos de esas líneas, por el mismo camino de chunks de siempre.
#     Las líneas son conjuntos disjuntos de artículos, así que no hay doble
#     conteo.
LINEA_TODAS = 0
NOMBRE_TODAS = "Todas las líneas"


def resolver_linea(linea: int | None, lineas: list[int] | None = None) -> dict:
    """{id, nombre, ids} de la línea pedida, o la de defecto (Bulones) si viene
    None. `linea=0` = todas (ver LINEA_TODAS); `ids` es el subconjunto de
    líneas a unir (None = sin filtro). ValueError si algún id no existe."""
    if linea == LINEA_TODAS:
        ids = None
        if lineas:
            ids = tuple(sorted({int(x) for x in lineas}))
            if any(linea_por_id(i) is None for i in ids):
                raise ValueError("Línea inexistente en el catálogo")
        return {"id": LINEA_TODAS, "nombre": NOMBRE_TODAS, "ids": ids}
    info = linea_por_id(linea) if linea is not None else linea_por_defecto()
    if info is None:
        raise ValueError("Línea inexistente en el catálogo")
    return {**info, "ids": None}


def _clave_linea(lin: dict):
    """Parte de la clave de cache que identifica la línea (o el conjunto)."""
    return (lin["id"], lin.get("ids"))


def _filas_linea(cur, sql: str, params_antes: tuple, lin: dict,
                 d1: int, d2: int) -> list:
    """Corre `sql` (con COND_LINEA al final del WHERE) contra las DOS
    sub-empresas, en chunks de códigos de la línea. Las filas de todos los
    chunks se devuelven juntas: como los chunks son conjuntos DISJUNTOS de
    artículos, sumarlas en Python (unir / acumuladores) da el mismo total que
    una sola consulta. `d1`/`d2` es el rango de vc.FecMovim; el de
    r.FecMovim va con ±_MARGEN_FECHA_RENGLON (sólo habilita el seek, la fecha
    que manda es la de la cabecera).

    "Todas" sin subconjunto: COND_LINEA → `1=1` y una sola consulta por
    sub-empresa (el recorte lo hace vc.FecMovim, igual que /ventas/vendedor)."""
    if lin["id"] == LINEA_TODAS and not lin.get("ids"):
        q = sql.replace(COND_LINEA, "1=1")
        return filas_dos(cur, q, _prueba(q), tuple(params_antes))
    if lin["id"] == LINEA_TODAS:
        codigos = [c for i in lin["ids"] for c in codigos_de_linea_id(i)]
    else:
        codigos = codigos_de_linea_id(lin["id"])
    m = _MARGEN_FECHA_RENGLON
    filas: list = []
    for i in range(0, len(codigos), _CHUNK_CODIGOS):
        chunk = tuple(codigos[i:i + _CHUNK_CODIGOS])
        q = sql.replace(_PH_CODIGOS, ",".join("?" for _ in chunk))
        filas += filas_dos(cur, q, _prueba(q),
                           tuple(params_antes) + chunk + (d1 - m, d2 + m))
    return filas


def _linea_payload(info: dict) -> dict:
    return {"id": info["id"], "nombre": info["nombre"]}


SIN_PATRON = "(Sin código patrón)"

# Nombre del patrón. StkFer_Articulos.DetallePatron es la descripción del
# patrón repetida en cada artículo (misma columna que el "Detalle" de los
# remitos de compra, ver HANDOFF_extracciones_sql.md). Se toma con MAX() en
# vez de agrupar por ella: agrupar sumaría una columna de texto al GROUP BY
# y, si un patrón tuviera dos escrituras distintas, lo partiría en dos filas
# del ranking. MAX sobre un grupo chico es gratis y siempre devuelve UNA.
_DETALLE_PATRON = "MAX(LTRIM(RTRIM(s.DetallePatron)))"

# El ranking de vendedores de ESTA vista NO filtra por estado ni por
# "seudo-vendedor": muestra el vendedor tal cual quedó grabado en el
# comprobante. MOSTRADOR y ECOMMERCE no son personas del maestro pero SÍ son
# canales que facturan bulonería, y sacarlos dejaba el ranking muy por debajo
# del total de la línea. Los dados de baja también entran: si vendieron en el
# período, esa venta existió. (En /ventas/vendedor el filtro sigue igual: allá
# el ranking es de personas.)


def _nombre_vendedor(codigo, nombre):
    """Etiqueta de la fila. Si el código del comprobante no está en el maestro
    Vendedores (venta vieja, código depurado) se muestra el código en vez de
    dejar la fila sin nombre."""
    n = (str(nombre).strip() if nombre else "")
    return n or "(sin nombre) {}".format(codigo)


# Join al artículo — SÓLO donde hace falta el patrón (ranking de patrones y
# modales que cortan por patrón). Desde 2026-09-23 el filtro de línea ya no
# pasa por acá (es COND_LINEA sobre r.CodArticu), así que el join es LEFT: un
# código que no esté en StkFer_Articulos suma igual, en "(Sin código patrón)".
_JOIN_ART = """
LEFT JOIN StkFer_Articulos s ON s.CodArticulo = r.CodArticu
"""

# Para AGRUPAR por vendedor (ranking): acá el vendedor de cada venta sale
# del comprobante mismo (Ven_CompCabecera.vendedor), no de la zona del
# cliente. Es más fiel — refleja quién vendió — y además no deja afuera a
# los vendedores sin zona cargada (ej. Julio Blanco 797).
#
# El JOIN al maestro es LEFT y sólo aporta el NOMBRE: la clave del ranking es
# vc.vendedor, así que un código que no exista en Vendedores igual suma su
# venta (con la etiqueta de _nombre_vendedor) en vez de desaparecer del total.
_JOIN_VENTA_VENDEDOR = """
FROM Ven_CompCabecera vc
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Vendedores v ON v.VendedorCodigo = vc.vendedor
"""

_JOIN_CLIENTE = """
FROM MAGNUS_SITD.dbo.Clientes c
JOIN Ven_CompCabecera vc ON vc.CodCliente = c.CodCliente
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
"""

_CANT = "CASE cc.DebitoCredito WHEN 1 THEN r.Cantidad ELSE r.Cantidad * -1 END"
_MONTO = (
    "CASE cc.DebitoCredito WHEN 1 THEN (r.Cantidad * r.PrecioVenta) "
    "ELSE (r.Cantidad * r.PrecioVenta) * -1 END"
)

# La otra sub-empresa. PRUEBA (`PRU_Ven_*`) también factura bulonería (1,8M en
# 2026) y sus notas de crédito también restan: las diez consultas de este
# módulo se corren contra las dos y se suman las filas en Python. La lista
# blanca propia de PRUEBA y la transformación viven en subempresas.py.
def _prueba(sql: str) -> str:
    return sql_prueba(sql, COMPROBANTES_VENTA, COMPROBANTES_AJUSTE)


_TTL_SEG = 15 * 60
_CACHE: dict[tuple, tuple[float, dict]] = {}


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


def _conn():
    conn = get_connection("EVERWEAR")
    cur = conn.cursor()
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
    return conn, cur


# ──────────────────────────────────────────────────────────────────────────
# Rankings del pie — DOS VENTANAS, mismo criterio que /ventas/vendedor
# (2026-09-09)
#
# Antes los tres rankings iban con la ventana MÓVIL de 12 meses que termina
# en el mes anterior (`_resolver_rango`). Ahora usan `_rango_ytd_y_mes`, o
# sea las mismas dos columnas que la tabla de /ventas/vendedor:
#
#   · ACUMULADO  Enero → mes ANTERIOR del año en curso (meses completos).
#     En enero no hay ningún mes cerrado: `desde`/`hasta` viajan en null y la
#     columna sale vacía a propósito.
#   · MES EN CURSO  del 1° al último día del mes de calendario. Va aparte
#     justamente porque está incompleto y no se puede comparar contra el
#     acumulado.
#
# Cómo se suman las dos de UNA consulta: `_ventana(expr)` (ventas.py) envuelve
# la expresión en `SUM(CASE WHEN vc.FecMovim BETWEEN ? AND ? THEN ... END)`,
# así que cada ventana cuesta 2 parámetros y NINGÚN scan extra — el WHERE
# recorta una sola vez por `dias_total` (la unión de las dos ventanas) y el
# CASE reparte cada fila en la columna que le toca. Partirlo en dos consultas
# habría duplicado el trabajo del motor sobre la misma tabla.
#
# ORDEN DE LOS `?` — es lo único frágil de esto: los parámetros van en el
# orden en que aparecen los `?` en el TEXTO, o sea primero los CASE del
# SELECT (de arriba hacia abajo) y recién al final el BETWEEN del WHERE. El
# recorte por vendedor (MARCA_VENDEDOR) inlinea los códigos y NO consume
# parámetros, así que la lista es la misma con y sin vendedor, y también la
# misma para la copia de la sub-empresa PRUEBA.
#
# OTRO CONSUMIDOR: /ventas/presupuestos pega a estos mismos endpoints pero
# SIEMPRE con `desde`/`hasta` explícitos (su default es el mes en curso) y
# lee sólo el acumulado. Para esa llamada la ventana del mes es ruido, así
# que `_mes_cuenta()` la saca del corte: si no, un patrón que se vendió este
# mes pero no en el rango pedido aparecería en su ranking con un cero.
# ──────────────────────────────────────────────────────────────────────────
def _mes_cuenta(desde: str | None, hasta: str | None) -> bool:
    """Si la ventana del mes en curso puede meter una fila en el ranking.
    Sólo en la vista por defecto (sin rango pedido a mano): ahí las dos
    columnas se muestran juntas y el que compró sólo este mes tiene que
    estar. Con rango explícito manda el acumulado y nada más."""
    return desde is None and hasta is None
def fetch_top_clientes(vendedor: int | None = None, limit: int = 1_000_000,
                       desde: str | None = None, hasta: str | None = None,
                       forzar: bool = False, linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Clientes que compraron BULONERÍA, por monto ($) — gemelo de
    ventas.fetch_top_clientes pero acotado a la línea. `monto` es el
    acumulado del año y `montoMes` el mes en curso, en columnas aparte."""
    desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total = _rango_ytd_y_mes(
        desde, hasta
    )
    limit_i = int(limit)
    lin = resolver_linea(linea, lineas)
    key = ("cli", _clave_linea(lin), vendedor, limit_i, desde_ym, hasta_ym, mes_ym)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    # Un solo par joins/where para admin y para vendedor: el recorte es la
    # marca de vendedores.py, que se reemplaza más abajo por
    # `AND vc.vendedor IN (...)` — o se borra sola si `vendedor` es None. No
    # consume parámetros, así que la lista de params es siempre la misma.
    joins = _JOIN_CLIENTE
    where = (f"WHERE {_COMP} AND vc.FecMovim BETWEEN ? AND ?\n"
             + MARCA_VENDEDOR)
    params: tuple = dias_acum + dias_mes + dias_total
    sql = f"""
SELECT c.CodCliente, MAX(LTRIM(RTRIM(c.Cliente_Nombre))) AS Nombre,
       {_ventana(_MONTO)} AS MontoNeto,
       {_ventana(_MONTO)} AS MontoMes
{joins}{where}
  AND {COND_LINEA}
GROUP BY c.CodCliente
"""
    sql = recortar_vendedor(sql, vendedor)
    # El HAVING y el ORDER BY se resuelven en Python: con dos sub-empresas el
    # corte va sobre la SUMA de las dos y ningún ORDER BY de una consulta sola
    # ordena el ranking final.
    conn, cur = _conn()
    try:
        clientes = [
            {
                "numero": int(cod),
                "nombre": (str(nom).strip() if nom else None),
                "monto": round(float(_safe(monto) or 0), 2),
                "montoMes": round(float(_safe(monto_mes) or 0), 2),
            }
            for cod, nom, monto, monto_mes in unir(
                _filas_linea(cur, sql, params, lin, *dias_total),
                (0,), (2, 3))
            if cod is not None
        ]
        # Entra el que tuvo movimiento en CUALQUIERA de las dos ventanas: un
        # cliente que compró sólo este mes no puede quedar afuera del ranking
        # por tener el acumulado en cero. Con rango explícito, sólo acumulado.
        mes_cuenta = _mes_cuenta(desde, hasta)
        clientes = [
            c for c in clientes
            if c["monto"] > 0 or (mes_cuenta and c["montoMes"] > 0)
        ]
        clientes.sort(key=lambda c: (c["monto"], c["montoMes"]), reverse=True)
        return _guardar(key, {
            # En enero no hay acumulado y los dos viajan en null — el front
            # esconde esa columna. Ver _rango_ytd_y_mes (ventas.py).
            "desde": f"{desde_ym[0]:04d}-{desde_ym[1]:02d}" if desde_ym else None,
            "hasta": f"{hasta_ym[0]:04d}-{hasta_ym[1]:02d}" if hasta_ym else None,
            "mesActual": f"{mes_ym[0]:04d}-{mes_ym[1]:02d}",
            "linea": _linea_payload(lin),
            "totalClientes": len(clientes),
            "porMonto": clientes[:limit_i],
        })
    finally:
        conn.close()


def fetch_top_patrones(vendedor: int | None = None, limit: int = 1_000_000,
                       desde: str | None = None, hasta: str | None = None,
                       forzar: bool = False, linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Ranking de CÓDIGOS PATRÓN de bulonería en el rango. Reemplaza al
    ranking de líneas de /ventas/vendedor (acá la línea es una sola, así que
    el corte útil es el patrón). Devuelve las dos listas ya ordenadas
    (porUnidades / porMonto) para que el botón $ | Unidades del front no
    refetchee, mismo contrato que ventas.fetch_top_lineas.

    Cada ítem trae las CUATRO sumas — unidades/monto × acumulado/mes en
    curso — para que el botón $ | Unidades cambie las dos columnas sin
    volver a pedir nada."""
    desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total = _rango_ytd_y_mes(
        desde, hasta
    )
    limit_i = int(limit)
    lin = resolver_linea(linea, lineas)
    key = ("pat", _clave_linea(lin), vendedor, limit_i, desde_ym, hasta_ym, mes_ym)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    joins = """
FROM Ven_CompCabecera vc
JOIN Ven_CompRenglon r   ON r.NroMovVenta = vc.NroMovVenta
JOIN Ven_CodCom cc       ON vc.CompCodigo = cc.CompCodigo
"""
    where = (f"WHERE {_COMP} AND vc.FecMovim BETWEEN ? AND ?\n"
             + MARCA_VENDEDOR)
    # Orden = orden de los `?` en el texto: unidades acum, unidades mes,
    # monto acum, monto mes, y al final el BETWEEN del WHERE.
    params = dias_acum + dias_mes + dias_acum + dias_mes + dias_total

    sql = f"""
SELECT LTRIM(RTRIM(s.ArticuloPatron)) AS Patron,
       {_DETALLE_PATRON} AS Detalle,
       {_ventana(_CANT)} AS Unidades,
       {_ventana(_CANT)} AS UnidadesMes,
       {_ventana(_MONTO)} AS MontoNeto,
       {_ventana(_MONTO)} AS MontoMes
{joins}{_JOIN_ART}{where}
  AND {COND_LINEA}
GROUP BY s.ArticuloPatron
"""
    sql = recortar_vendedor(sql, vendedor)
    conn, cur = _conn()
    try:
        acum: dict[str, list] = {}
        for patron, detalle, unid, unid_mes, monto, monto_mes in _filas_linea(
            cur, sql, params, lin, *dias_total
        ):
            codigo = (str(patron or "").strip()) or SIN_PATRON
            a = acum.setdefault(codigo, [0.0, 0.0, 0.0, 0.0, None])
            a[0] += float(_safe(unid) or 0)
            a[1] += float(_safe(unid_mes) or 0)
            a[2] += float(_safe(monto) or 0)
            a[3] += float(_safe(monto_mes) or 0)
            if a[4] is None:
                a[4] = (str(detalle).strip() or None) if detalle else None
        items = {
            p: {
                "patron": p,
                "detalle": d,
                "unidades": round(u, 2),
                "unidadesMes": round(um, 2),
                "monto": round(m, 2),
                "montoMes": round(mm, 2),
            }
            for p, (u, um, m, mm, d) in acum.items()
        }
        # Una nota de crédito puede dejar unidades > 0 con monto <= 0 (o al
        # revés), así que cada lista filtra por SU métrica — igual que
        # fetch_top_lineas. El corte mira las DOS ventanas: un patrón que
        # sólo se vendió este mes tiene que entrar igual (salvo con rango
        # explícito, ver _mes_cuenta).
        mes_cuenta = _mes_cuenta(desde, hasta)
        por_u = sorted(
            (i for i in items.values()
             if i["unidades"] > 0 or (mes_cuenta and i["unidadesMes"] > 0)),
            key=lambda x: (x["unidades"], x["unidadesMes"]), reverse=True)
        por_m = sorted(
            (i for i in items.values()
             if i["monto"] > 0 or (mes_cuenta and i["montoMes"] > 0)),
            key=lambda x: (x["monto"], x["montoMes"]), reverse=True)
        return _guardar(key, {
            "desde": f"{desde_ym[0]:04d}-{desde_ym[1]:02d}" if desde_ym else None,
            "hasta": f"{hasta_ym[0]:04d}-{hasta_ym[1]:02d}" if hasta_ym else None,
            "mesActual": f"{mes_ym[0]:04d}-{mes_ym[1]:02d}",
            "linea": _linea_payload(lin),
            "totalPatrones": len(por_u),
            "totalPatronesMonto": len(por_m),
            "porUnidades": por_u[:limit_i],
            "porMonto": por_m[:limit_i],
        })
    finally:
        conn.close()


def fetch_top_vendedores(vendedor: int | None = None, limit: int = 1_000_000,
                         desde: str | None = None, hasta: str | None = None,
                         forzar: bool = False, linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Ranking de VENDEDORES por bulonería vendida (el agregado propio de
    esta vista). Un no-admin se ve a sí mismo y a sus antecesores.

    SUCESIÓN (2026-09-08): el GROUP BY es por código de comprobante, así que
    un vendedor que se fue sacaría fila propia. Las filas de los antecesores
    se colapsan en la del sucesor (vendedores.dueno_de) DESPUÉS de la
    consulta: una fila por persona que hoy vende, y la suma del ranking sigue
    siendo el total de la línea.

    El vendedor de cada venta sale del COMPROBANTE (Ven_CompCabecera.vendedor),
    no de la zona del cliente: refleja quién vendió y no deja afuera a los
    vendedores sin zona cargada.

    SIN filtro de estado ni de "seudo-vendedor" (2026-09-01): entra todo lo
    que figura en la base, incluidos los canales que no son personas
    (MOSTRADOR, ECOMMERCE, ZONA …) y los dados de baja que hayan facturado en
    el período. Así la suma del ranking cierra con el total de la línea, que
    es lo que se compara contra los otros dos rankings. El maestro Vendedores
    entra por LEFT JOIN y sólo aporta el nombre.

    Cada fila trae las CUATRO sumas — unidades/monto × acumulado/mes en
    curso — para que el botón $ | Unidades cambie las dos columnas sin
    volver a pedir nada."""
    desde_ym, hasta_ym, mes_ym, dias_acum, dias_mes, dias_total = _rango_ytd_y_mes(
        desde, hasta
    )
    limit_i = int(limit)
    lin = resolver_linea(linea, lineas)
    key = ("ven", _clave_linea(lin), vendedor, limit_i, desde_ym, hasta_ym, mes_ym)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    where = (f"WHERE {_COMP} "
             "AND vc.FecMovim BETWEEN ? AND ?\n"
             + MARCA_VENDEDOR)
    # Orden = orden de los `?` en el texto: unidades acum, unidades mes,
    # monto acum, monto mes, y al final el BETWEEN del WHERE.
    params: tuple = dias_acum + dias_mes + dias_acum + dias_mes + dias_total
    # Se agrupa por vc.vendedor (la columna del comprobante, entera y ya
    # indexada) y el nombre se trae con MAX: un código sin fila en el maestro
    # devuelve NULL y no parte el grupo, y sumar el texto al GROUP BY sería
    # más caro sin agregar nada — el maestro tiene un nombre por código.
    sql = f"""
SELECT vc.vendedor AS Codigo,
       MAX(LTRIM(RTRIM(v.VendedorNombre))) AS Nombre,
       {_ventana(_CANT)} AS Unidades,
       {_ventana(_CANT)} AS UnidadesMes,
       {_ventana(_MONTO)} AS MontoNeto,
       {_ventana(_MONTO)} AS MontoMes
{_JOIN_VENTA_VENDEDOR}{where}
  AND {COND_LINEA}
GROUP BY vc.vendedor
"""
    sql = recortar_vendedor(sql, vendedor)
    conn, cur = _conn()
    try:
        # SUCESIÓN (2026-09-08): el GROUP BY es por código de comprobante, así
        # que un vendedor que se fue saca fila propia. `dueno_de` la manda al
        # que heredó su cartera, y las dos se suman en un solo acumulador —
        # una fila por persona que hoy vende, sin perder un peso del total.
        # El nombre se toma del CÓDIGO DUEÑO (el del sucesor); el del
        # antecesor no se usa aunque llegue primero.
        acum: dict[int, list] = {}
        for cod, nom, unid, unid_mes, monto, monto_mes in unir(
            _filas_linea(cur, sql, params, lin, *dias_total),
            (0,), (2, 3, 4, 5)
        ):
            if cod is None:
                continue
            # Los canales (MOSTRADOR, ECOMMERCE, ZONA …) y los dados de baja
            # NO se descartan: son ventas de la línea y tienen que estar.
            crudo = int(cod)
            dueno = dueno_de(crudo)
            a = acum.setdefault(dueno, [0.0, 0.0, 0.0, 0.0, None])
            a[0] += float(_safe(unid) or 0)
            a[1] += float(_safe(unid_mes) or 0)
            a[2] += float(_safe(monto) or 0)
            a[3] += float(_safe(monto_mes) or 0)
            if crudo == dueno and nom:
                a[4] = nom
        # Un sucesor puede no tener venta propia en el período y quedarse sin
        # nombre (el LEFT JOIN sólo trae el de los códigos que facturaron).
        # Se resuelven TODOS de una, en la misma conexión: nada de un SELECT
        # por fila adentro del armado.
        faltantes = [c for c, (_u, _um, _m, _mm, nom) in acum.items() if not nom]
        if faltantes:
            cur.execute(
                "SELECT VendedorCodigo, LTRIM(RTRIM(VendedorNombre)) "
                "FROM MAGNUS_SITD.dbo.Vendedores WHERE VendedorCodigo IN (%s)"
                % ",".join(str(int(c)) for c in faltantes)
            )
            for cod_v, nom_v in cur.fetchall():
                if cod_v is not None and int(cod_v) in acum:
                    acum[int(cod_v)][4] = nom_v

        items = [
            {
                "codigo": codigo,
                "nombre": _nombre_vendedor(codigo, nom),
                "unidades": round(unid, 2),
                "unidadesMes": round(unid_mes, 2),
                "monto": round(monto, 2),
                "montoMes": round(monto_mes, 2),
            }
            for codigo, (unid, unid_mes, monto, monto_mes, nom) in acum.items()
        ]
        # PADRÓN ÚNICO para las dos listas (2026-08-31). A diferencia de
        # patrones/clientes, acá las filas son PERSONAS y el que las mira sabe
        # quiénes son: si alguien está en $ y no en Unidades, se lee como un
        # bug ("falta un vendedor"), no como un dato.
        #
        # Pasa de verdad: monto y unidades salen de la MISMA Cantidad
        # (_CANT / _MONTO), así que un vendedor no puede tener monto ≠ 0 con
        # cantidad 0. Lo que sí puede es quedar con unidades NETAS <= 0 y
        # monto NETO > 0 — una nota de crédito por muchas unidades baratas
        # contra ventas de pocas unidades caras (o una devolución con
        # cantidad negativa dentro del mismo comprobante). Filtrar cada lista
        # por SU métrica lo hacía desaparecer del ranking por unidades.
        #
        # Criterio: entra todo el que tuvo ACTIVIDAD neta en el período
        # (cualquiera de las dos métricas distinta de cero), y cada lista se
        # ordena por la suya — los <= 0 caen solos al final. El front muestra
        # el número real y les da 0% de participación (ver
        # app/ventas/presupuestos/page.tsx). Patrones y clientes siguen
        # filtrando por su métrica: ahí las listas son largas y anónimas, y un
        # patrón en cero no le falta a nadie.
        mes_cuenta = _mes_cuenta(desde, hasta)
        con_actividad = [
            i for i in items
            if i["unidades"] or i["monto"]
            or (mes_cuenta and (i["unidadesMes"] or i["montoMes"]))
        ]
        por_u = sorted(con_actividad,
                       key=lambda x: (x["unidades"], x["unidadesMes"]), reverse=True)
        por_m = sorted(con_actividad,
                       key=lambda x: (x["monto"], x["montoMes"]), reverse=True)
        return _guardar(key, {
            "desde": f"{desde_ym[0]:04d}-{desde_ym[1]:02d}" if desde_ym else None,
            "hasta": f"{hasta_ym[0]:04d}-{hasta_ym[1]:02d}" if hasta_ym else None,
            "mesActual": f"{mes_ym[0]:04d}-{mes_ym[1]:02d}",
            "linea": _linea_payload(lin),
            "totalVendedores": len(por_u),
            "totalVendedoresMonto": len(por_m),
            "porUnidades": por_u[:limit_i],
            "porMonto": por_m[:limit_i],
        })
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────
# Detalle del modal — SIEMPRE la misma matriz año anterior / año actual con
# desglose mensual y las dos métricas, para que el front use una sola tabla
# (idéntico contrato que fetch_clientes_por_linea de ventas.py). Cambia sólo
# qué identifica la fila.
#
# En esta vista el modal es de UN SOLO NIVEL (2026-08-26:
# "acá solo se abrirá un modal, no puede ir otro modal más"): las filas del
# modal NO son clickeables, así que cada una de estas funciones se llama
# desde el ranking del pie y nada más.
# ──────────────────────────────────────────────────────────────────────────
# Nombre por MAX() y fuera del GROUP BY: depende de Clave, así que agruparlo
# también sólo sumaba una columna de texto a la clave del hash.
_WRAP = """
SELECT Clave, MAX(Nombre) AS Nombre, AnioMes, SUM(Cant) AS Cant, SUM(Monto) AS Monto
FROM ({sub}) t
WHERE AnioMes IS NOT NULL
GROUP BY Clave, AnioMes
"""


def _matriz(sub: str, params: tuple, anio_anterior: int, anio_actual: int,
            lin: dict, d1: int, d2: int):
    """Corre la subconsulta (que devuelve Clave/Nombre/AnioMes/Cant/Monto) y
    la vuelca en {clave: {nombre, anioAnterior, anioActual}} + totales.
    `sub` lleva COND_LINEA al final: se corre en chunks de códigos de la
    línea (_filas_linea) y las filas de todos los chunks caen en el mismo
    acumulador de abajo."""
    conn, cur = _conn()
    try:
        filas: dict = {}
        tot_ant, tot_act = _anio_vacio(), _anio_vacio()
        for clave, nombre, anio_mes, cant, monto in _filas_linea(
            cur, _WRAP.format(sub=sub), params, lin, d1, d2
        ):
            if clave is None or anio_mes is None:
                continue
            anio, mes = divmod(int(anio_mes), 100)
            if anio not in (anio_actual, anio_anterior) or not 1 <= mes <= 12:
                continue
            cant = float(_safe(cant) or 0)
            monto = float(_safe(monto) or 0)
            b = filas.get(clave)
            if b is None:
                b = {
                    "clave": clave,
                    "nombre": (str(nombre).strip() if nombre else None),
                    "anioAnterior": _anio_vacio(),
                    "anioActual": _anio_vacio(),
                }
                filas[clave] = b
            for destino in (b["anioActual"] if anio == anio_actual else b["anioAnterior"],
                            tot_act if anio == anio_actual else tot_ant):
                destino["cantidad"] += cant
                destino["monto"] += monto
                destino["meses"][mes - 1]["cantidad"] += cant
                destino["meses"][mes - 1]["monto"] += monto
        out = []
        for b in filas.values():
            b["anioAnterior"] = _round_anio(b["anioAnterior"])
            b["anioActual"] = _round_anio(b["anioActual"])
            out.append(b)
        out.sort(key=lambda b: b["anioAnterior"]["monto"] + b["anioActual"]["monto"],
                 reverse=True)
        return out, {"anioAnterior": _round_anio(tot_ant), "anioActual": _round_anio(tot_act)}
    finally:
        conn.close()


def _anios_y_rango():
    hoy = date.today()
    a_act = hoy.year
    a_ant = a_act - 1
    return a_ant, a_act, (date(a_ant, 1, 1) - BASE_DATE).days, (date(a_act, 12, 31) - BASE_DATE).days


def fetch_clientes_por_patron(patron: str, vendedor: int | None = None,
                              limit: int = 1_000_000, forzar: bool = False,
                              linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Ranking de clientes que compraron UN código patrón de bulonería, con
    los 2 años y el desglose mensual completo (el filtro YTD/Meses lo hace
    el front sobre lo ya traído, sin refetch)."""
    patron_norm = (patron or "").strip()
    if not patron_norm:
        raise ValueError("Falta 'patron'")
    a_ant, a_act, d1, d2 = _anios_y_rango()
    lin = resolver_linea(linea, lineas)
    key = ("cxp", _clave_linea(lin), patron_norm, vendedor, int(limit), a_ant, a_act)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    # ArticuloPatron se compara SIN LTRIM/RTRIM para que el índice sirva:
    # en SQL Server la comparación de char/varchar ignora los espacios de
    # cola, así que 'ABC   ' = 'ABC'.
    joins = _JOIN_CLIENTE
    if patron_norm == SIN_PATRON:
        # La fila "(Sin código patrón)" del ranking: artículos sin patrón o
        # sin fila en StkFer_Articulos (el join es LEFT).
        cond_patron, params = ("(s.ArticuloPatron IS NULL "
                               "OR LTRIM(RTRIM(s.ArticuloPatron)) = '')"), (d1, d2)
    else:
        cond_patron, params = "s.ArticuloPatron = ?", (d1, d2, patron_norm)
    where = (f"WHERE {_COMP} "
             f"AND vc.FecMovim BETWEEN ? AND ? AND {cond_patron}\n"
             + MARCA_VENDEDOR)
    sub = f"""
SELECT c.CodCliente AS Clave, LTRIM(RTRIM(c.Cliente_Nombre)) AS Nombre,
       {_case_anio_mes((a_ant, a_act))} AS AnioMes,
       {_CANT} AS Cant, {_MONTO} AS Monto
{joins}{_JOIN_ART}{where}
  AND {COND_LINEA}
"""
    filas, totales = _matriz(recortar_vendedor(sub, vendedor), params, a_ant, a_act,
                             lin, d1, d2)
    clientes = [
        {"numero": int(f["clave"]), "nombre": f["nombre"],
         "anioAnterior": f["anioAnterior"], "anioActual": f["anioActual"]}
        for f in filas
    ]
    return _guardar(key, {
        "linea": _linea_payload(lin),
        "patron": patron_norm,
        "detalle": fetch_detalle_patron(patron_norm),
        "anioAnterior": a_ant,
        "anioActual": a_act,
        "tieneDatos": bool(clientes),
        "totalClientes": len(clientes),
        "clientes": clientes[: int(limit)],
        "totales": totales,
    })


def fetch_clientes_por_vendedor(cod_vendedor: int, limit: int = 1_000_000,
                                forzar: bool = False,
                                linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Ranking de clientes de UN vendedor, en bulonería — lo que abre el
    modal al clickear un vendedor del ranking.

    Corta por el vendedor del COMPROBANTE (vc.vendedor + los códigos de sus
    antecesores, ver vendedores.py), no por la cartera del vendedor
    (2026-09-01). Dos razones:
      · Es lo mismo que suma el ranking, así que el total del modal cierra con
        la fila que se clickeó. Con la cartera traía todas las compras de esos
        clientes, las hubiera facturado él u otro.
      · Los canales (MOSTRADOR, ECOMMERCE) no tienen cartera declarada; por
        cartera el modal les quedaba mezclado con las ventas de los vendedores
        de esos mismos clientes.
    De paso es más barata: se va el UNION sobre Clientes/Vendedor_Zona y queda
    un filtro sargable sobre una columna del comprobante."""
    a_ant, a_act, d1, d2 = _anios_y_rango()
    lin = resolver_linea(linea, lineas)
    key = ("cxv", _clave_linea(lin), int(cod_vendedor), int(limit), a_ant, a_act)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    sub = f"""
SELECT c.CodCliente AS Clave, LTRIM(RTRIM(c.Cliente_Nombre)) AS Nombre,
       {_case_anio_mes((a_ant, a_act))} AS AnioMes,
       {_CANT} AS Cant, {_MONTO} AS Monto
{_JOIN_CLIENTE}WHERE {_COMP}
  AND vc.FecMovim BETWEEN ? AND ?
{MARCA_VENDEDOR}
  AND {COND_LINEA}
"""
    # El modal se abre desde una fila del ranking, que ya viene colapsada al
    # sucesor: tiene que traer también lo emitido por sus antecesores o el
    # detalle no sumaría lo que muestra la fila.
    sub = recortar_vendedor(sub, int(cod_vendedor))
    filas, totales = _matriz(sub, (d1, d2), a_ant, a_act, lin, d1, d2)
    clientes = [
        {"numero": int(f["clave"]), "nombre": f["nombre"],
         "anioAnterior": f["anioAnterior"], "anioActual": f["anioActual"]}
        for f in filas
    ]
    return _guardar(key, {
        "linea": _linea_payload(lin),
        "vendedor": {"codigo": int(cod_vendedor), "nombre": fetch_vendedor_nombre(cod_vendedor)},
        "anioAnterior": a_ant,
        "anioActual": a_act,
        "tieneDatos": bool(clientes),
        "totalClientes": len(clientes),
        "clientes": clientes[: int(limit)],
        "totales": totales,
    })


def fetch_patrones_por_cliente(cod_cliente: int, vendedor: int | None = None,
                               limit: int = 1_000_000, forzar: bool = False,
                               linea: int | None = None,
                       lineas: list[int] | None = None) -> dict:
    """Ranking de códigos patrón de bulonería que compró UN cliente, más el
    VENDEDOR ASIGNADO a ese cliente (2026-08-26: "en la
    vista de clientes … arriba agregar el vendedor asignado a ese cliente").

    `vendedor`: si se pasa (no-admin) y el cliente no es de su cartera, se
    devuelve vacío — mismo criterio de acceso que ventas.py."""
    a_ant, a_act, d1, d2 = _anios_y_rango()
    nombre_cliente, asignado = fetch_cliente_y_vendedor(cod_cliente)
    if vendedor is not None and (asignado is None or asignado["codigo"] != int(vendedor)):
        return {
            "cliente": {"codigo": int(cod_cliente), "nombre": None},
            "vendedorAsignado": None,
            "anioAnterior": a_ant, "anioActual": a_act,
            "tieneDatos": False, "permitido": False,
            "totalPatrones": 0, "patrones": [],
            "totales": {"anioAnterior": _anio_vacio(), "anioActual": _anio_vacio()},
        }

    lin = resolver_linea(linea, lineas)
    key = ("pxc", _clave_linea(lin), int(cod_cliente), int(limit), a_ant, a_act)
    hit = _cacheado(key, forzar)
    if hit is not None:
        return hit

    # `Nombre` acá es el nombre del PATRÓN (DetallePatron), no el del cliente
    # —el cliente es uno solo y su nombre ya viene de fetch_cliente_y_vendedor—.
    # Es lo que se muestra en la primera columna del modal.
    sub = f"""
SELECT ISNULL(LTRIM(RTRIM(s.ArticuloPatron)), '') AS Clave,
       LTRIM(RTRIM(s.DetallePatron)) AS Nombre,
       {_case_anio_mes((a_ant, a_act))} AS AnioMes,
       {_CANT} AS Cant, {_MONTO} AS Monto
{_JOIN_CLIENTE}{_JOIN_ART}WHERE c.CodCliente = ?
  AND {_COMP}
  AND vc.FecMovim BETWEEN ? AND ?
  AND {COND_LINEA}
"""
    filas, totales = _matriz(sub, (int(cod_cliente), d1, d2), a_ant, a_act,
                             lin, d1, d2)
    patrones = [
        {"patron": (f["clave"] or SIN_PATRON),
         "detalle": f["nombre"],
         "anioAnterior": f["anioAnterior"], "anioActual": f["anioActual"]}
        for f in filas
    ]
    return _guardar(key, {
        "linea": _linea_payload(lin),
        "cliente": {"codigo": int(cod_cliente), "nombre": nombre_cliente},
        "vendedorAsignado": asignado,
        "anioAnterior": a_ant,
        "anioActual": a_act,
        "tieneDatos": bool(patrones),
        "permitido": True,
        "totalPatrones": len(patrones),
        "patrones": patrones[: int(limit)],
        "totales": totales,
    })


# ──────────────────────────────────────────────────────────────────────────
# Catálogo mínimo de vendedores
# ──────────────────────────────────────────────────────────────────────────
# Nombre del cliente + su Vendedor por Defecto en UNA sola consulta. Los
# JOIN son LEFT a propósito: un cliente de mostrador no tiene
# Clasif_VendZona y aun así hay que devolver su nombre.
SQL_CLIENTE_Y_VENDEDOR = """
SELECT LTRIM(RTRIM(c.Cliente_Nombre)) AS Cliente,
       v.VendedorCodigo,
       LTRIM(RTRIM(v.VendedorNombre)) AS Vendedor
FROM MAGNUS_SITD.dbo.Clientes c
LEFT JOIN MAGNUS_SITD.dbo.Vendedor_Zona vz ON vz.Clasif_VendZona = c.Clasif_VendZona
LEFT JOIN MAGNUS_SITD.dbo.Vendedores v ON LTRIM(RTRIM(v.VendedorNombre)) = LTRIM(RTRIM(vz.Vendedor))
WHERE c.CodCliente = ?
"""

# Nombre de un código patrón. TOP 1: DetallePatron es la misma descripción
# repetida en todos los artículos del patrón.
SQL_DETALLE_PATRON = """
SELECT TOP 1 LTRIM(RTRIM(DetallePatron))
FROM StkFer_Articulos
WHERE ArticuloPatron = ? AND DetallePatron IS NOT NULL
"""

SQL_VENDEDOR_NOMBRE = """
SELECT LTRIM(RTRIM(VendedorNombre))
FROM MAGNUS_SITD.dbo.Vendedores
WHERE VendedorCodigo = ?
"""


def fetch_cliente_y_vendedor(cod_cliente: int) -> tuple[str | None, dict | None]:
    """(nombre del cliente, {'codigo','nombre'} de su Vendedor por Defecto).

    El vendedor puede ser None (mostrador / sin Clasif_VendZona — ver
    clientes.fetch_vendedor_fijo_cliente, mismo join) y el nombre también si
    el cliente no existe. Las dos cosas salen de la misma consulta porque el
    modal de patrones-por-cliente necesita ambas y son un único acceso a la
    tabla de clientes."""
    conn, cur = _conn()
    try:
        cur.execute(SQL_CLIENTE_Y_VENDEDOR, (int(cod_cliente),))
        row = cur.fetchone()
        if not row:
            return None, None
        nombre_cli = str(row[0]).strip() if row[0] else None
        if row[1] is None:
            return nombre_cli, None
        return nombre_cli, {
            "codigo": int(row[1]),
            "nombre": (str(row[2]).strip() if row[2] else None),
        }
    finally:
        conn.close()


# Cache de nombres de patrón: son fijos y el modal los pide de a uno.
_CACHE_PATRON: dict[str, str | None] = {}


def fetch_detalle_patron(patron: str) -> str | None:
    """Nombre (DetallePatron) de un código patrón, o None si no se encuentra."""
    p = (patron or "").strip()
    if not p or p == SIN_PATRON:
        return None
    if p in _CACHE_PATRON:
        return _CACHE_PATRON[p]
    conn, cur = _conn()
    try:
        cur.execute(SQL_DETALLE_PATRON, (p,))
        row = cur.fetchone()
        nombre = (str(row[0]).strip() or None) if row and row[0] else None
        _CACHE_PATRON[p] = nombre
        return nombre
    finally:
        conn.close()


def fetch_vendedor_nombre(cod_vendedor: int) -> str | None:
    """Nombre del vendedor para el encabezado del modal. Si el código no está
    en el maestro devuelve la misma etiqueta que usa el ranking, para que el
    título del modal no quede vacío al abrir una fila sin nombre."""
    conn, cur = _conn()
    try:
        cur.execute(SQL_VENDEDOR_NOMBRE, (int(cod_vendedor),))
        row = cur.fetchone()
        return _nombre_vendedor(int(cod_vendedor), row[0] if row else None)
    finally:
        conn.close()
