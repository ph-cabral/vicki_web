"""
Consultas en vivo para la pagina /deposito de ever (reemplazan los Excel).

- WMS  -> Productividad de Operarios (lean: solo columnas que usa el parser TS).
          Base WMS, datetime nativo, filtra por OTFechaHoraEjecucion.
- TIEMPO -> EVERWEAR.dbo.TMP_TiempoDePedidos (la misma tabla que exportaba el xlsx).
- PEDIDOS_HORA -> EVERWEAR.dbo.VenFer_PedidoCabecera (Magnus), vista EN VIVO
          de HOY por hora (8-18h): ingresados / abiertos (backlog real) /
          cerrados. Ver fetch_pedidos_hora().

OJO compatibilidad con lib/deposito/parseDeposito.ts:
  * PROCESO se devuelve SIN acentos ('Reposicion','Re-Ubicacion','Libre','Picking')
    porque cleanProc() matchea 'Libre'/'Reposicion' exactos.
  * FECHA EJECUCION en dd/mm/yyyy (CONVERT 103) para que parseFecha() use el
    regex local y no haya corrimiento por timezone (ART = UTC-3).
"""
from datetime import datetime, date, timedelta
from decimal import Decimal
from db import get_connection
from db_pg import get_pg_connection

# ── Faltantes por OT (fuente NUEVA de /deposito/faltantes) ────────────────────
# Columna de la cabecera OT (base WMS) que guarda el N° de pedido de venta de
# Magnus = VenFer_PedidoCabecera.NroMovVenta. Es lo único que el código no puede
# confirmar solo: si el nombre real es otro, la consulta de faltantes-OT falla.
# CONFIRMAR contra el server con GET /deposito/faltantes-ot/diag (lista las
# columnas reales de OT) y, si hace falta, cambiar SOLO esta constante.
OT_COL_PEDIDO = "OTNroMovVenta"

# Solo cuentan como faltante los pedidos ya Cerrados o Facturados en Magnus
# (MAGNUS_SITD.dbo.Pedido_Estados.Ped_EstadoDescripcion). Whitelist en vez de
# blacklist: todo lo que no sea Cerrado/Facturado (Abierto, Cancelado, etc.)
# queda afuera. Confirmado 2026-07-10 por conteo real: los 4 estados presentes
# son Facturados/Abiertos/Cancelados/Cerrados. PATRONES_CANCELADO es un resguardo
# extra por si algún estado nuevo matchea el whitelist sin ser válido de verdad.
ESTADOS_VALIDOS: tuple[str, ...] = ("CERRADO", "FACTURADO")
PATRONES_CANCELADO: tuple[str, ...] = ("CANCEL",)

# Existencia física por ubicación = base WMS, dbo.UbicacionDetalle
# (artículo + ubicación + cantidad). Ubicacion# de Magnus NO trae cantidad.
UBIC_TABLA    = "UbicacionDetalle"
UBIC_COL_ART  = "UbicacionDetalleArticuloId"
UBIC_COL_UBI  = "UbicacionCodigo"
UBIC_COL_CANT = "UbicacionDetalleCantidad"


CODIGOS_COMPROBANTE_WMS = (10, 70, 75, 100, 210, 310)

# OJO: la base WMS esta en compatibility_level 100, asi que NO acepta TRY_CONVERT
# (EVERWEAR esta en 150 y si lo acepta). Por eso la fecha se recorta con
# LEFT(...,10) en vez de convertirla: FechaRegistracionPedido ya viene como
# 'dd/mm/yyyy' de largo 10 en las 10.100 filas, mismo formato que [FECHA EJECUCION],
# asi que el front las compara como string sin parsear nada raro. Ademas es mas
# barato que convertir.
#
# [FECHA PEDIDO] = fecha en que se REGISTRO el pedido en Magnus
# (TMP_TiempoDePedidos.FechaRegistracionPedido, misma fuente que /deposito/ingresados),
# para poder partir lo preparado en "del dia" vs "arrastre de dias anteriores".
# El LEFT JOIN es 1-a-1 (NroMovVenta es unico en TMP_TiempoDePedidos, ~10k filas:
# snapshot de ~90 dias), asi que NO multiplica filas ni cambia los conteos de OT.
# Si el pedido cae fuera del snapshot (o la OT no es de picking) no hay match y se
# usa OT.OTFechaHoraRegist como respaldo: coincide con la registracion del pedido en
# ~72% de los casos y es lo mas cercano disponible en la propia OT.

# /deposito (productividad cruda) -> TODA la actividad WMS, SIN filtrar por
# comprobante de Magnus (no debe verse afectada por ese filtro).
SQL_WMS_TODOS = """
SELECT
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 103) AS [FECHA EJECUCION],
    ISNULL(
        NULLIF(LEFT(LTRIM(RTRIM(t.FechaRegistracionPedido)), 10), ''),
        CONVERT(varchar(10), OT.OTFechaHoraRegist, 103)
    )                                AS [FECHA PEDIDO],
    CASE Codot.CodotProcesoNegocio
        WHEN 1 THEN 'Reposicion'
        WHEN 2 THEN 'Interdeposito'
        WHEN 3 THEN 'Re-Ubicacion'
        WHEN 4 THEN 'Picking'
        WHEN 5 THEN 'Libre'
    END                              AS [PROCESO],
    P_Repositor.PersonalNombre       AS [OPERARIO],
    ISNULL(i.[CANT. ITEM DE RECOLECCION], 0) AS [CANT. ITEM DE RECOLECCION],
    ISNULL(i.[CANT. ITEM RECOLECTADOS], 0)   AS [CANT. ITEM RECOLECTADOS]
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
LEFT JOIN (
    SELECT OTId,
        SUM(CASE WHEN OTItemTipo = 1 THEN 1 ELSE 0 END)                          AS [CANT. ITEM DE RECOLECCION],
        SUM(CASE WHEN OTItemTipo = 1 AND OTItemCantCumplida > 0 THEN 1 ELSE 0 END) AS [CANT. ITEM RECOLECTADOS]
    FROM OTItem GROUP BY OTId
) i ON OT.OTId = i.OTId
LEFT JOIN EVERWEAR.dbo.TMP_TiempoDePedidos t ON t.NroMovVenta = OT.{col_pedido}
WHERE OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
ORDER BY OT.OTId DESC
"""

# /deposito/pedidos (preparado vs ingresados) -> SOLO OT que matchean un pedido
# Magnus de los comprobantes válidos. NO agregar 410 acá.
SQL_WMS_PEDIDOS = """
SELECT
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 103) AS [FECHA EJECUCION],
    ISNULL(
        NULLIF(LEFT(LTRIM(RTRIM(t.FechaRegistracionPedido)), 10), ''),
        CONVERT(varchar(10), OT.OTFechaHoraRegist, 103)
    )                                AS [FECHA PEDIDO],
    CASE Codot.CodotProcesoNegocio
        WHEN 1 THEN 'Reposicion'
        WHEN 2 THEN 'Interdeposito'
        WHEN 3 THEN 'Re-Ubicacion'
        WHEN 4 THEN 'Picking'
        WHEN 5 THEN 'Libre'
    END                              AS [PROCESO],
    P_Repositor.PersonalNombre       AS [OPERARIO],
    ISNULL(i.[CANT. ITEM DE RECOLECCION], 0) AS [CANT. ITEM DE RECOLECCION],
    ISNULL(i.[CANT. ITEM RECOLECTADOS], 0)   AS [CANT. ITEM RECOLECTADOS]
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
LEFT JOIN (
    SELECT OTId,
        SUM(CASE WHEN OTItemTipo = 1 THEN 1 ELSE 0 END)                          AS [CANT. ITEM DE RECOLECCION],
        SUM(CASE WHEN OTItemTipo = 1 AND OTItemCantCumplida > 0 THEN 1 ELSE 0 END) AS [CANT. ITEM RECOLECTADOS]
    FROM OTItem GROUP BY OTId
) i ON OT.OTId = i.OTId
INNER JOIN EVERWEAR.dbo.TMP_TiempoDePedidos t ON t.NroMovVenta = OT.{col_pedido}
WHERE OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
  AND TRY_CAST(LEFT(t.CodComprobante, CHARINDEX(' ', t.CodComprobante + ' ') - 1) AS INT) IN ({codigos})
  AND LTRIM(RTRIM(t.Estado)) IN ('Abierto', 'Cerrado', 'Facturado')
  AND LTRIM(RTRIM(ISNULL(t.CodComprobante_Factura, 'SinCodigo'))) <> 'SinCodigo'
ORDER BY OT.OTId DESC
"""

def fetch_wms(desde: datetime, hasta: datetime, todos: bool = False):
    """todos=True -> /deposito: TODA la actividad WMS, sin filtro de comprobante.
    todos=False (default) -> /deposito/pedidos: solo comprobantes (10,70,100,210,310)."""
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        if todos:
            cur.execute(SQL_WMS_TODOS.format(col_pedido=OT_COL_PEDIDO), (desde, hasta))
        else:
            cur.execute(
                SQL_WMS_PEDIDOS.format(
                    col_pedido=OT_COL_PEDIDO,
                    codigos=",".join(map(str, CODIGOS_COMPROBANTE_WMS)),
                ),
                (desde, hasta),
            )
        return _rows(cur)
    finally:
        conn.close()
        
        
SQL_TIEMPO = """
SELECT * FROM dbo.TMP_TiempoDePedidos
WHERE TRY_CAST(LEFT(CodComprobante, CHARINDEX(' ', CodComprobante + ' ') - 1) AS INT) IN (10, 100, 210, 310)
  AND LTRIM(RTRIM(Estado)) IN ('Facturado', 'Cerrado')
ORDER BY NroMovVenta DESC
"""


def _safe(value, colname=""):
    """Convierte tipos SQL a JSON-safe."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        # La fecha del reporte de tiempos la queremos dd/mm/yyyy (lo que espera el parser)
        if "fecha" in colname.lower():
            return value.strftime("%d/%m/%Y")
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "ignore")
    return value


def _rows(cur):
    cols = [c[0] for c in cur.description]
    return [{c: _safe(v, c) for c, v in zip(cols, row)} for row in cur.fetchall()]


def fetch_tiempo():
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd;")
        cur.execute(SQL_TIEMPO)
        return _rows(cur)
    finally:
        conn.close()


# ── Pedidos ingresados (registrados) por día ──────────────────────────────────
_BASE_PEDIDO = date(1800, 12, 28)


# Comprobantes que cuentan como "pedido ingresado" al deposito (/deposito/pedidos):
# el universo tiene que ser el mismo que el que puede generar una OT de picking.
#  - FACTURABLES: ademas del comprobante se exige factura (CodComprobante_Factura),
#    que es lo que descarta pedidos que nunca se concretaron.
#  - SIN_FACTURA: 75 (acopio, Facturado = 0 por circuito) y 410 (PED.NF.CEN, pedido
#    no facturable de centro). Nunca tienen CodComprobante_Factura, asi que exigirla
#    los dejaba siempre afuera aunque si se preparan y suman OT.
CODIGOS_INGRESADOS_FACTURABLES = (10, 70, 100, 210, 310)
CODIGOS_INGRESADOS_SIN_FACTURA = (75, 410)

# CROSS APPLY (VALUES ...) calcula codigo y factura una sola vez por fila
# (la tabla es grande y estas expresiones no son sargables).
SQL_INGRESADOS = """
SELECT TRY_CONVERT(date, LTRIM(RTRIM(t.FechaRegistracionPedido)), 103) AS f,
       COUNT(*) AS pedidos
FROM dbo.TMP_TiempoDePedidos t
CROSS APPLY (VALUES (
    TRY_CAST(LEFT(t.CodComprobante, CHARINDEX(' ', t.CodComprobante + ' ') - 1) AS INT),
    LTRIM(RTRIM(ISNULL(t.CodComprobante_Factura, 'SinCodigo')))
)) c(cod, fac)
WHERE TRY_CONVERT(date, LTRIM(RTRIM(t.FechaRegistracionPedido)), 103) BETWEEN ? AND ?
  AND LTRIM(RTRIM(t.Estado)) IN ('Abierto', 'Cerrado', 'Facturado')
  AND (   (c.cod IN ({cod_fact}) AND c.fac <> 'SinCodigo')
       OR  c.cod IN ({cod_sin_fact}) )
GROUP BY TRY_CONVERT(date, LTRIM(RTRIM(t.FechaRegistracionPedido)), 103)
ORDER BY f
"""


def fetch_ingresados(desde, hasta):
    """desde/hasta = datetime. Pedidos mayoristas/día desde TMP_TiempoDePedidos."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd;")
        cur.execute(
            SQL_INGRESADOS.format(
                cod_fact=",".join(map(str, CODIGOS_INGRESADOS_FACTURABLES)),
                cod_sin_fact=",".join(map(str, CODIGOS_INGRESADOS_SIN_FACTURA)),
            ),
            (desde, hasta),
        )
        out = []
        for f, pedidos in cur.fetchall():
            if f is None:
                continue
            fecha = f.isoformat() if hasattr(f, "isoformat") else str(f)
            out.append({"fecha": fecha, "pedidos": int(pedidos)})
        return out
    finally:
        conn.close()


# ── Pedidos por hora (8 a 18h) — fuente Magnus, día = hoy (en vivo) o filtro ──
# Ingresados = pedidos registrados en el bucket (ts_Registro, del día pedido).
# Cerrados   = de los pedidos con actividad reciente (ventana de
#              PEDIDOS_HORA_VENTANA_DIAS), cuántos pasaron a Cerrado/Facturado
#              en ese bucket (ts_Cierre) — incluye pedidos abiertos en días
#              previos que recién ahí se cerraron.
# Si el día pedido es HOY, no se devuelven buckets futuros al momento actual
# (ver `tope_min` en fetch_pedidos_hora) — evita graficar como si ya hubiesen
# transcurrido.
#
# OJO 2026-07-23 (2 vueltas de fix): "Abiertos" reconstruido desde
# FechaPedido/FechaCierre de VenFer_PedidoCabecera (a) subcontaba (whitelist de
# comprobante muy angosta, después una ventana de 60 días muy corta para
# backorders con faltante) y (b) aun ensanchando ambas cosas, quedaba PLANO
# todo el día — un backlog reconstruido así es, en la práctica, casi el mismo
# número ("total abierto ahora") para cualquier hora salvo que entren/cierren
# pedidos justo en esa ventana, no una serie de tiempo real:
# en vez de reconstruir el pasado, "Abiertos" ahora sale de FOTOS reales
# tomadas cada PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN min (ver
# guardar_snapshot_abiertos + el loop en main.py) contra
# EVERWEAR.dbo.TMP_TiempoDePedidos.Estado = 'Abierto' — el mismo campo/tabla
# que ya usa la pestaña "Tiempo de Pedidos" (tabla confirmada y llena por
# SP_TiempoPedidos_Cargar, no hay que reconstruir nada). Las fotos se guardan
# en Postgres (deposito.pedidos_abiertos_snapshot, ver
# sql/deposito_pedidos_abiertos_snapshot.sql — falta correrlo). Ingresados/
# Cerrados siguen reconstruidos desde Cabecera (no reportado como roto), ahora
# en buckets de PEDIDOS_HORA_PASO_MIN para compartir el mismo eje que Abiertos.
#
# Mismo criterio de "cancelado" que el resto del archivo (PATRONES_CANCELADO).
# Fecha/hora nativas de Magnus: FechaXXX = días desde 1800-12-28, HoraXXX = HHMM
# (mismo esquema que EVERWEAR.dbo.VenFer_PedidoCabecera usado en
# indicadores-api/main.py::SQL_QUERY / cargar_df, ya probado en producción).
PEDIDOS_HORA_VENTANA_DIAS = 365
PEDIDOS_HORA_DESDE = 8
PEDIDOS_HORA_HASTA = 18  # el último bucket es 17:45→18:00
PEDIDOS_HORA_PASO_MIN = 15  # granularidad del gráfico (bucket + eje X)
PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN = 15  # cada cuánto se saca una foto real

# Mismo blacklist que main.py::SQL_QUERY (comprobantes no-pedido reales).
COMP_CODIGOS_EXCLUIDOS_HORA: tuple[int, ...] = (9, 49, 208, 410)

# ── "Movimiento de pedidos" (gráfico snapshot) ──────────────────────────────
# Ventana hacia atrás de la serie "Abiertos": SOLO pedidos con OT de Picking en
# WMS (los que pasan al depósito), abiertos en Magnus dentro de esta ventana y
# todavía no cumplidos en WMS. Evita arrastrar los pedidos de hace años que
# quedaron abiertos sin limpiar en Magnus.
MOV_ABIERTOS_VENTANA_DIAS = 30
# Operario ficticio del WMS donde se parkean los pedidos que esperan que llegue
# la mercadería (stock). Sus OT NO son trabajo "disponible": se muestran aparte
# como "En espera de mercadería" y se restan de Disponibles. Match por
# Personal.PersonalNombre (case-insensitive, sin acento; ver OPERARIO helper).
OPERARIO_ESPERA_MERCA = "Mercaderia X Llegar"

SQL_PEDIDOS_HORA = """
SELECT
    p.NroMovVenta,
    p.FechaPedido,  p.HoraRegistracion,
    p.FechaCierre,  p.HoraCierre,
    e.Ped_EstadoDescripcion AS Estado_Desc
FROM EVERWEAR.dbo.VenFer_PedidoCabecera p
LEFT JOIN MAGNUS_SITD.dbo.Pedido_Estados e ON p.EstadoPedido = e.Ped_Estado
WHERE p.CompCodigo NOT IN ({codigos})
  AND p.FechaPedido BETWEEN ? AND ?
"""

# "Abiertos ahora" — mismo campo/tabla que la pestaña Tiempo de Pedidos
# (TMP_TiempoDePedidos.Estado), NO se reconstruye desde Cabecera. Sin el
# filtro de CodComprobante_Factura <> SinCodigo (ese filtro es para "ya
# facturado", un pedido Abierto todavía no tiene factura asignada).
SQL_ABIERTOS_AHORA = """
SELECT COUNT(*) FROM dbo.TMP_TiempoDePedidos
WHERE TRY_CAST(LEFT(CodComprobante, CHARINDEX(' ', CodComprobante + ' ') - 1) AS INT)
      NOT IN ({codigos})
  AND LTRIM(RTRIM(Estado)) = 'Abierto'
"""


def _pedido_ts(fecha_dias, hora_hhmm):
    """FechaXXX (días desde 1800-12-28) + HoraXXX (HHMM) -> datetime, o None si
    la etapa todavía no ocurrió (fecha <= 0) — mismo criterio que utils.py."""
    try:
        f = int(fecha_dias) if fecha_dias is not None else 0
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    try:
        h = int(hora_hhmm) if hora_hhmm not in (None, "") else 0
    except (TypeError, ValueError):
        h = 0
    horas, minutos = divmod(h, 100)
    try:
        base = _BASE_PEDIDO + timedelta(days=f)
        return datetime(base.year, base.month, base.day) + timedelta(hours=horas, minutes=minutos)
    except (ValueError, OverflowError):
        return None


def _ahora_ar() -> datetime:
    """'Ahora' naive en hora de Argentina (UTC-3, sin horario de verano), sin
    depender de la base de datos IANA de zonas horarias (el contenedor slim de
    indicadores-api no la tiene instalada). Mismo criterio naive-ART que el
    resto del archivo (_pedido_ts)."""
    return datetime.utcnow() - timedelta(hours=3)


def fetch_abiertos_ahora() -> int:
    """Cuenta actual de pedidos Abiertos en Magnus (TMP_TiempoDePedidos.Estado).
    Usado por guardar_snapshot_abiertos (foto periódica, ver main.py)."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd;")
        cur.execute(SQL_ABIERTOS_AHORA.format(codigos=",".join(map(str, COMP_CODIGOS_EXCLUIDOS_HORA))))
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else 0
    finally:
        conn.close()


def guardar_snapshot_abiertos() -> int:
    """Saca una foto de 'Abiertos ahora' (Magnus) y la inserta en Postgres
    (deposito.pedidos_abiertos_snapshot). Llamado por el loop periódico en
    main.py cada PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN minutos."""
    abiertos = fetch_abiertos_ahora()
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO deposito.pedidos_abiertos_snapshot (ts, abiertos) VALUES (%s, %s)",
            (_ahora_ar(), abiertos),
        )
        conn.commit()
    finally:
        conn.close()
    return abiertos


def _fotos_abiertos_del_dia(dia: date) -> list[tuple[datetime, int]]:
    """Fotos ya guardadas ese día (Postgres), ordenadas. Lista vacía si el
    snapshotter todavía no corrió ese día (recién deployado)."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT ts, abiertos FROM deposito.pedidos_abiertos_snapshot "
            "WHERE ts::date = %s ORDER BY ts",
            (dia,),
        )
        return [(ts, int(ab)) for ts, ab in cur.fetchall()]
    finally:
        conn.close()


# ── Foto periódica de estados del WMS (gráfico "OT en cada estado por hora") ──
# El gráfico de estados EN el momento (espera / disponibles / cumplido acumulado)
# NO se puede reconstruir del pasado desde las marcas de la OT: la foto viva
# (fetch_wms_estados) incluye backlog de días previos y define "En proceso" por
# progreso a nivel ítem (OTEstado=5 con OTItemCantCumplida>0), no por PickIni.
# Igual que "Abiertos", se saca una FOTO real cada
# PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN minutos y se guarda en Postgres
# (deposito.wms_estados_snapshot, ver sql/deposito_wms_estados_snapshot.sql —
# falta correrlo antes del deploy). Guardamos los 3 valores del resumen para que
# el gráfico coincida exactamente con las tarjetas KPI.
def _es_operario_merca(nombre) -> bool:
    """True si el nombre de operario es el buzón 'Mercaderia X Llegar'
    (case-insensitive, tolerante a acentos/espacios)."""
    s = str(nombre or "").strip().lower()
    ref = OPERARIO_ESPERA_MERCA.strip().lower()
    return s == ref or s == ref.replace("mercaderia", "mercadería")


def guardar_snapshot_wms_estados() -> dict:
    """Foto de los KPI de estados (fetch_wms_estados, HOY) → Postgres. Guarda
    también espera_merca = OT vivas del operario 'Mercaderia X Llegar' (los
    pedidos esperando que llegue la mercadería), para poder restarlas de
    Disponibles y mostrarlas aparte en el gráfico de movimiento.

    2026-07-24: "terminadas" (Cumplido) sale de un COUNT en vivo contra
    WMS con READ UNCOMMITTED, tomado cada 15 min — NO es un acumulador. Cumplido
    es un estado terminal que en el negocio nunca vuelve para atrás, pero una
    foto que cruza una tanda grande de OT pasando a Cumplido a la vez puede leer
    sucio y devolver momentáneamente menos de lo real (caso real: 12:15=71 →
    12:30=39). Se clampea contra el máximo ya guardado hoy para que la serie
    guardada sea monótona no decreciente, como tiene que ser."""
    hoy = date.today()
    res = fetch_wms_estados(hoy.isoformat(), hoy.isoformat())
    r = res.get("resumen", {})
    en_espera = int(r.get("en_espera", 0))
    en_proceso = int(r.get("en_proceso", 0))
    terminadas = int(r.get("terminadas", 0))
    # Vivas (bucket espera/proceso) del operario Mercaderia X Llegar.
    vivos = {str(int(e)) for e in WMS_ESTADOS_VIVOS}
    espera_merca = 0
    for op in res.get("por_operario", []):
        if _es_operario_merca(op.get("operario")):
            espera_merca = sum(
                int(v) for k, v in (op.get("por_estado") or {}).items() if str(k) in vivos
            )
            break
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        # Cumplido no puede bajar dentro del día: si esta foto leyó menos que la
        # máxima ya guardada hoy (lectura sucia en una tanda de altas), nos
        # quedamos con la máxima previa en vez de guardar una baja espuria.
        cur.execute(
            "SELECT COALESCE(MAX(terminadas), 0) FROM deposito.wms_estados_snapshot "
            "WHERE ts::date = %s",
            (hoy,),
        )
        terminadas_prev = cur.fetchone()[0]
        if terminadas < terminadas_prev:
            terminadas = terminadas_prev
        cur.execute(
            "INSERT INTO deposito.wms_estados_snapshot "
            "(ts, en_espera, en_proceso, terminadas, espera_merca) "
            "VALUES (%s, %s, %s, %s, %s)",
            (_ahora_ar(), en_espera, en_proceso, terminadas, espera_merca),
        )
        conn.commit()
    finally:
        conn.close()
    return {"en_espera": en_espera, "en_proceso": en_proceso,
            "terminadas": terminadas, "espera_merca": espera_merca}


def _fotos_estados_del_dia(dia: date) -> list[tuple[datetime, int, int, int, int]]:
    """Fotos de estados ya guardadas ese día (ts, en_espera, en_proceso,
    terminadas, espera_merca), ordenadas. Vacío si el snapshotter todavía no
    corrió O si la tabla/columna todavía no se creó (así el gráfico cae a la
    reconstrucción sin romper)."""
    try:
        conn = get_pg_connection()
    except Exception as e:  # noqa: BLE001
        print(f"[estados-snap] Postgres no disponible: {e}")
        return []
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT ts, en_espera, en_proceso, terminadas, "
            "       COALESCE(espera_merca, 0) "
            "FROM deposito.wms_estados_snapshot WHERE ts::date = %s ORDER BY ts",
            (dia,),
        )
        return [(ts, int(a), int(b), int(c), int(d)) for ts, a, b, c, d in cur.fetchall()]
    except Exception as e:  # noqa: BLE001 — tabla/columna inexistente → sin fotos
        print(f"[estados-snap] sin fotos (¿tabla/columna creada?): {e}")
        return []
    finally:
        conn.close()


# Estados del WMS por hora (gráfico 1). En vez de una foto del backlog, se
# reconstruye el FLUJO: cuántas OT de Picking PASAN a cada etapa en cada bucket
# de 15 min, usando la marca de hora de la propia OT (igual criterio que
# Cumplido). Marcas: OTFechaHoraRegist (entra a espera/sin-asignar según tenga
# operario), OTFechaHoraPickIni (arranca picking = en proceso), OTFechaHoraEjecucion
# (terminada = cumplido, OTEstado=2). Así hay historia completa del día al toque,
# sin depender de la foto periódica.
SQL_WMS_TRANSICIONES = """
SELECT
    OT.OTFechaHoraRegist,
    OT.OTFechaHoraPickIni,
    OT.OTFechaHoraEjecucion,
    OT.OTEstado,
    CASE WHEN P.PersonalNombre IS NULL OR LTRIM(RTRIM(P.PersonalNombre)) = ''
         THEN 0 ELSE 1 END AS Asignado
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
WHERE Codot.CodotProcesoNegocio = 4
  AND ( (OT.OTFechaHoraRegist    >= ? AND OT.OTFechaHoraRegist    < ?)
     OR (OT.OTFechaHoraPickIni   >= ? AND OT.OTFechaHoraPickIni   < ?)
     OR (OT.OTFechaHoraEjecucion >= ? AND OT.OTFechaHoraEjecucion < ?) )
"""


def _wms_transiciones_del_dia(dia: date) -> dict:
    """Marca de hora en que cada OT de Picking pasa a cada etapa, para graficar
    el FLUJO por 15 min (cuántas entran a cada etapa en el bucket):
      · en_espera   = registrada (OTFechaHoraRegist) CON operario asignado
      · sin_asignar = registrada (OTFechaHoraRegist) SIN operario
      · en_proceso  = arrancó el picking (OTFechaHoraPickIni)
      · cumplido    = terminada (OTFechaHoraEjecucion, OTEstado=2)
    Devuelve dict de listas de timestamps. asignado se evalúa con el repositor
    actual de la OT. Vacío si el WMS no contesta (el gráfico no se rompe)."""
    ini = datetime(dia.year, dia.month, dia.day)
    fin = ini + timedelta(days=1)
    out = {"en_espera": [], "sin_asignar": [], "en_proceso": [], "cumplido": []}
    try:
        conn = get_connection("WMS")
    except Exception as e:  # noqa: BLE001 — WMS caído no debe tumbar el gráfico
        print(f"[estados-hora] WMS no disponible: {e}")
        return out
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_WMS_TRANSICIONES, (ini, fin, ini, fin, ini, fin))
        for reg, pini, ejec, estado, asignado in cur.fetchall():
            if reg is not None and ini <= reg < fin:
                (out["en_espera"] if int(asignado or 0) == 1 else out["sin_asignar"]).append(reg)
            if pini is not None and ini <= pini < fin:
                out["en_proceso"].append(pini)
            if ejec is not None and ini <= ejec < fin and int(estado or 0) == 2:
                out["cumplido"].append(ejec)
        return out
    finally:
        conn.close()


# Reconstrucción del SNAPSHOT de estados (gráfico "OT en cada estado por hora")
# para rellenar los buckets del día que todavía no tienen foto real. Usa el MISMO
# universo que fetch_wms_estados (fuente de las tarjetas KPI): OT de Picking
# VIVAS (OTEstado 0/1/5) sin importar la fecha (incluye backlog de días previos)
# + las terminales REGISTRADAS hoy. Con las marcas de hora de cada OT se
# reconstruye su estado a cada corte:
#   · cumplido = OTFechaHoraEjecucion <= corte
#   · proceso  = arrancó picking (PickIni <= corte) y realmente progresó
#                (OTEstado=2 cumplido, u OTEstado=5 con ítems recolectados) —
#                mismo criterio de reclasificación que SQL_WMS_ESTADOS
#   · espera   = registrada (Regist <= corte) y todavía sin lo anterior
# La foto real SIEMPRE tiene prioridad; esto es solo el relleno (igual patrón que
# la reconstrucción de "Abiertos"). El split espera/proceso puede diferir un
# poco de las tarjetas en instantes intermedios, pero Disponibles (espera+proceso)
# y Cumplidos cierran con el KPI.
SQL_WMS_ESTADOS_RECON = """
SELECT
    OT.OTFechaHoraRegist,
    OT.OTFechaHoraPickIni,
    OT.OTFechaHoraEjecucion,
    OT.OTEstado,
    ISNULL(it.Recolectados, 0) AS Recolectados
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN (
    SELECT OTId,
        SUM(CASE WHEN OTItemTipo = 1 AND OTItemCantCumplida > 0 THEN 1 ELSE 0 END) AS Recolectados
    FROM OTItem GROUP BY OTId
) it ON it.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio = 4
  AND ( OT.OTEstado IN ({vivos})
        OR (OT.OTFechaHoraRegist >= ? AND OT.OTFechaHoraRegist <= ?) )
"""


def _wms_estados_recon_del_dia(dia: date) -> list[tuple]:
    """(reg, pini, ejec, estado, recolectados) del universo KPI para reconstruir
    el snapshot de estados a cualquier corte del día. Vacío si el WMS no
    contesta (el gráfico no se rompe, solo no rellena)."""
    d = datetime(dia.year, dia.month, dia.day, 0, 0, 0)
    h = datetime(dia.year, dia.month, dia.day, 23, 59, 59)
    try:
        conn = get_connection("WMS")
    except Exception as e:  # noqa: BLE001
        print(f"[estados-snap-recon] WMS no disponible: {e}")
        return []
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(
            SQL_WMS_ESTADOS_RECON.format(vivos=",".join(str(e) for e in WMS_ESTADOS_VIVOS)),
            (d, h),
        )
        return [(reg, pini, ejec, int(estado or 0), int(recol or 0))
                for reg, pini, ejec, estado, recol in cur.fetchall()]
    finally:
        conn.close()


def _snap_recon(corte: datetime, ot_list: list[tuple]) -> tuple[int, int, int]:
    """(espera, proceso, cumplido) reconstruidos al `corte` desde las marcas."""
    espera = proceso = cumpl = 0
    for reg, pini, ejec, estado, recol in ot_list:
        if reg is None or reg >= corte:  # todavía no existía a esa hora
            continue
        if ejec is not None and ejec < corte:
            cumpl += 1
            continue
        entro_proceso = estado == 2 or (estado == 5 and recol > 0)
        if entro_proceso and pini is not None and pini < corte:
            proceso += 1
        else:
            espera += 1
    return espera, proceso, cumpl


# ── "Movimiento de pedidos" — Abiertos (Magnus) vinculado a Cumplido (WMS) ────
# Serie "Abiertos" del gráfico snapshot: universo = pedidos con OT de Picking
# (los que pasan al WMS). Por cada uno se toma la hora en que pasó a Abierto en
# Magnus (Cabecera, FechaPedido/HoraRegistracion) y la hora en que se dio
# Cumplido en el WMS (OTFechaHoraEjecucion con OTEstado=2). Vínculo por
# NroMovVenta. Es reconstruible (no hace falta foto): a cada corte del día,
# Abiertos = pedidos con abierto_ts < corte, dentro de la ventana de
# MOV_ABIERTOS_VENTANA_DIAS días, y todavía sin cumplir a esa hora.
SQL_MOV_WMS_OT = """
SELECT
    OT.{col_pedido}       AS NroMovVenta,
    OT.OTFechaHoraRegist,
    OT.OTFechaHoraEjecucion,
    OT.OTEstado
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4
  AND ( OT.OTEstado IN ({vivos})
        OR OT.OTFechaHoraRegist >= ? )
"""

SQL_MOV_MAGNUS_ABIERTO = """
SELECT NroMovVenta, FechaPedido, HoraRegistracion
FROM EVERWEAR.dbo.VenFer_PedidoCabecera
WHERE NroMovVenta IN ({ph})
"""


def _mov_abiertos_del_dia(dia: date) -> list[tuple[datetime, datetime | None]]:
    """[(abierto_ts, cumplido_ts)] por pedido con OT de Picking, para la serie
    'Abiertos' del movimiento. abierto_ts = pase a Abierto en Magnus (Cabecera),
    con fallback a la registración de la OT si Magnus no tiene el pedido;
    cumplido_ts = OTFechaHoraEjecucion (OTEstado=2) o None. Universo: OT vivas
    (cualquier fecha) + registradas en los últimos MOV_ABIERTOS_VENTANA_DIAS
    días. Vacío si el WMS no contesta (el gráfico no se rompe)."""
    corte_ventana = datetime(dia.year, dia.month, dia.day) - timedelta(days=MOV_ABIERTOS_VENTANA_DIAS)
    try:
        conn = get_connection("WMS")
    except Exception as e:  # noqa: BLE001 — WMS caído no debe tumbar el gráfico
        print(f"[mov-abiertos] WMS no disponible: {e}")
        return []
    wms: dict[int, tuple[datetime | None, datetime | None]] = {}
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(
            SQL_MOV_WMS_OT.format(
                col_pedido=OT_COL_PEDIDO,
                vivos=",".join(str(e) for e in WMS_ESTADOS_VIVOS),
            ),
            (corte_ventana,),
        )
        for nro, reg, ejec, estado in cur.fetchall():
            if nro is None:
                continue
            n = int(nro)
            cumplido = ejec if (ejec is not None and int(estado or 0) == 2) else None
            prev = wms.get(n)
            # Si un pedido tuviera >1 OT, quedarse con la que ya está cumplida.
            if prev is None or (cumplido is not None and prev[1] is None):
                wms[n] = (reg, cumplido)
    finally:
        conn.close()
    if not wms:
        return []

    # abierto_ts real desde Magnus (Cabecera), en chunks.
    abierto_mg: dict[int, datetime] = {}
    try:
        conn = get_connection("EVERWEAR")
    except Exception as e:  # noqa: BLE001
        print(f"[mov-abiertos] Magnus no disponible: {e}")
        conn = None
    if conn is not None:
        try:
            cur = conn.cursor()
            cur.execute("SET DATEFORMAT ymd;")
            pedidos = sorted(wms.keys())
            CH = 1000
            for i in range(0, len(pedidos), CH):
                chunk = pedidos[i:i + CH]
                ph = ",".join("?" for _ in chunk)
                cur.execute(SQL_MOV_MAGNUS_ABIERTO.format(ph=ph), chunk)
                for nro, f_ped, h_reg in cur.fetchall():
                    if nro is None:
                        continue
                    ts = _pedido_ts(f_ped, h_reg)
                    if ts:
                        abierto_mg[int(nro)] = ts
        finally:
            conn.close()

    out: list[tuple[datetime, datetime | None]] = []
    for n, (reg_ts, cumplido_ts) in wms.items():
        abierto_ts = abierto_mg.get(n) or reg_ts  # fallback: registración de la OT
        if abierto_ts is None or abierto_ts < corte_ventana:
            continue
        out.append((abierto_ts, cumplido_ts))
    return out


def fetch_pedidos_hora(fecha: date | None = None):
    """Vista de un día en buckets de PEDIDOS_HORA_PASO_MIN (8-18h). Campos por
    bucket:
      · Ingresados = pedidos registrados en el bucket (Magnus Cabecera).
      · Cerrados   = pedidos que pasaron a cerrado en el bucket (Magnus Cabecera).
      · Cumplidos  = OT de Picking marcadas Cumplido (WMS, OTEstado=2) por su
                     OTFechaHoraEjecucion — cuántos pedidos se cumplieron en el
                     bucket.
      · Abiertos   = ÚLTIMA foto real (Postgres) tomada hasta el cierre del
                     bucket (carry-forward); si todavía no hay foto se rellena
                     con el backlog reconstruido (registrados − cerrados a esa
                     hora), así la curva se ve completa desde las 8h.
      · est_espera / est_proceso / est_cumplido / est_sin_asignar = FLUJO de OT
                     de Picking que PASAN a cada etapa en el bucket (cuántas cada
                     15 min, no acumulado), reconstruido desde las marcas de hora
                     de la OT (Regist / PickIni / Ejecucion; espera vs sin-asignar
                     según tenga operario). Historia completa del día. Es el
                     gráfico 1.

    El eje 8-18h se devuelve SIEMPRE completo. Para el día de hoy los buckets que
    todavía no empezaron vienen en None (las líneas se van trazando hacia
    adelante a medida que pasa el tiempo). Con `fecha` de un día anterior → día
    ya cerrado, todos los buckets con dato."""
    dia = fecha or date.today()
    es_hoy = dia == date.today()
    dias_dia = (dia - _BASE_PEDIDO).days
    dias_desde = dias_dia - PEDIDOS_HORA_VENTANA_DIAS

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd;")
        cur.execute(
            SQL_PEDIDOS_HORA.format(codigos=",".join(map(str, COMP_CODIGOS_EXCLUIDOS_HORA))),
            (dias_desde, dias_dia),
        )
        filas = cur.fetchall()
    finally:
        conn.close()

    regs = []  # (ts_registro, ts_cierre) de pedidos vivos (no cancelados)
    for _nro, f_ped, h_reg, f_cie, h_cie, estado_desc in filas:
        if any(p in str(estado_desc or "").upper() for p in PATRONES_CANCELADO):
            continue
        ts_reg = _pedido_ts(f_ped, h_reg)
        if not ts_reg:
            continue
        ts_cie = _pedido_ts(f_cie, h_cie)
        regs.append((ts_reg, ts_cie))

    fotos = _fotos_abiertos_del_dia(dia)
    trans = _wms_transiciones_del_dia(dia)  # flujos por etapa (listas de timestamps)

    paso = PEDIDOS_HORA_PASO_MIN
    minuto_desde = PEDIDOS_HORA_DESDE * 60
    minuto_hasta = PEDIDOS_HORA_HASTA * 60
    # Eje 8-18h SIEMPRE completo. Para hoy, los buckets que todavía no arrancaron
    # van en None → las líneas se trazan hacia adelante a medida que pasa el
    # tiempo, sin dibujar 0 en el futuro.
    ahora = _ahora_ar() if es_hoy else None

    def _en(lst, ini_b, fin_b):
        return sum(1 for ts in lst if ini_b <= ts < fin_b)

    # Snapshot de estados (gráfico "OT en cada estado por hora"): fotos reales de
    # los KPI cada 15 min (Postgres). Se hace carry-forward de la última foto ≤
    # corte, igual que "Abiertos". Así el gráfico coincide con las tarjetas KPI.
    # Para los buckets SIN foto todavía se reconstruye desde las marcas de la OT
    # (mismo universo KPI) → el día se ve completo desde las 8h; la foto real
    # tiene prioridad cuando existe.
    fotos_est = _fotos_estados_del_dia(dia)
    recon_est = _wms_estados_recon_del_dia(dia)
    # "Movimiento": pedidos con OT de Picking (los que pasan al WMS), con su hora
    # de pase a Abierto en Magnus + hora de Cumplido en WMS. Reconstruible por
    # corte (no depende de foto).
    mov = _mov_abiertos_del_dia(dia)

    out = []
    idx_foto = 0
    abiertos_foto = None
    idx_est = 0
    est_foto = None  # (en_espera, en_proceso, terminadas) de la última foto
    for m in range(minuto_desde, minuto_hasta, paso):
        h, mi = divmod(m, 60)
        inicio = datetime(dia.year, dia.month, dia.day, h, mi, 0)
        corte = inicio + timedelta(minutes=paso)
        # Carry-forward de la última foto de abiertos (avanza el índice aunque el
        # bucket sea futuro; el valor solo se usa en buckets ya pasados).
        while idx_foto < len(fotos) and fotos[idx_foto][0] < corte:
            abiertos_foto = fotos[idx_foto][1]
            idx_foto += 1
        # Carry-forward de la última foto de estados (KPI) tomada hasta el corte.
        while idx_est < len(fotos_est) and fotos_est[idx_est][0] < corte:
            est_foto = fotos_est[idx_est][1:]  # (espera, proceso, terminadas, espera_merca)
            idx_est += 1
        if ahora is not None and inicio > ahora:
            # Bucket futuro (aún no arrancó): sin datos, las líneas cortan acá.
            out.append({
                "hora": f"{h:02d}:{mi:02d}",
                "ingresados": None, "cerrados": None, "cumplidos": None,
                "abiertos": None, "est_espera": None, "est_proceso": None,
                "est_cumplido": None, "est_sin_asignar": None,
                "snap_espera": None, "snap_disponibles": None, "snap_cumplido": None,
                "mov_abiertos": None, "mov_disponibles": None, "mov_espera_merca": None,
            })
            continue
        ingresados = sum(1 for ts_reg, _ in regs if ts_reg.date() == dia and inicio <= ts_reg < corte)
        cerrados = sum(1 for _, ts_cie in regs if ts_cie and ts_cie.date() == dia and inicio <= ts_cie < corte)
        # Flujo por etapa del WMS en el bucket (gráfico 1), reconstruido desde las
        # marcas de hora de cada OT — cuántas PASAN a cada etapa en estos 15 min.
        est_espera = _en(trans["en_espera"], inicio, corte)
        est_proceso = _en(trans["en_proceso"], inicio, corte)
        est_cumplido = _en(trans["cumplido"], inicio, corte)
        est_sin = _en(trans["sin_asignar"], inicio, corte)
        cumplidos = est_cumplido  # gráfico 2 usa el mismo flujo de cumplidos
        # Snapshot (gráfico nuevo): foto real de los KPI ≤ corte si existe; si no,
        # reconstrucción desde las marcas de la OT (relleno). La foto real manda.
        if est_foto is not None:
            snap_espera_v = est_foto[0]
            snap_disp_v = est_foto[0] + est_foto[1]  # espera + proceso = no cumplido
            snap_cumpl_v = est_foto[2]               # cumplido (acumulado del día)
            merca_v = est_foto[3] if len(est_foto) > 3 and est_foto[3] is not None else 0
            # Disponibles del movimiento = no cumplido EXCLUYENDO Mercaderia X Llegar.
            mov_disp_v = max(snap_disp_v - merca_v, 0)
            mov_merca_v = merca_v
        elif recon_est:
            r_esp, r_proc, r_cumpl = _snap_recon(corte, recon_est)
            snap_espera_v = r_esp
            snap_disp_v = r_esp + r_proc
            snap_cumpl_v = r_cumpl
            # Sin foto no se conoce el operario → no se puede separar Mercaderia.
            mov_disp_v = r_esp + r_proc
            mov_merca_v = None
        else:
            snap_espera_v = snap_disp_v = snap_cumpl_v = None
            mov_disp_v = mov_merca_v = None
        # Abiertos del movimiento: pedidos con OT abiertos (Magnus) antes del corte,
        # dentro de la ventana, y todavía sin cumplir a esa hora.
        mov_abiertos_v = sum(
            1 for ab_ts, cu_ts in mov
            if ab_ts < corte and (cu_ts is None or cu_ts >= corte)
        )
        # Backlog reconstruido: pedidos registrados antes del corte y todavía no
        # cerrados a esa hora. Relleno para buckets sin foto real. La foto real
        # (abiertos_foto) SIEMPRE tiene prioridad cuando existe.
        if abiertos_foto is not None:
            abiertos = abiertos_foto
        else:
            abiertos = sum(
                1 for ts_reg, ts_cie in regs
                if ts_reg < corte and (ts_cie is None or ts_cie >= corte)
            )
        out.append({
            "hora": f"{h:02d}:{mi:02d}",
            "ingresados": ingresados,
            "cerrados": cerrados,
            "cumplidos": cumplidos,
            "abiertos": abiertos,
            "est_espera": est_espera,
            "est_proceso": est_proceso,
            "est_cumplido": est_cumplido,
            "est_sin_asignar": est_sin,
            "snap_espera": snap_espera_v,
            "snap_disponibles": snap_disp_v,
            "snap_cumplido": snap_cumpl_v,
            "mov_abiertos": mov_abiertos_v,
            "mov_disponibles": mov_disp_v,
            "mov_espera_merca": mov_merca_v,
        })
    return out


# ── Estado del artículo (1 Habilitado / 2 Suspendido / 3 Baja) ────────────────
# El nombre de la columna en StkFer_Articulos no está documentado (no se usaba
# en ninguna vista hasta ahora), así que se DETECTA por INFORMATION_SCHEMA con
# la misma lista de candidatos que detalle_mes_extraccion.py y se cachea a
# nivel proceso: la detección corre UNA vez, no una por request.
# Si no aparece ninguno, las consultas devuelven NULL en EstadoArticulo y el
# consumidor no filtra nada (mejor de más que perder filas en silencio).
_CAND_ESTADO_ART = ("EstadoArticulo", "CodEstado", "Estado", "EstadoArt",
                    "SituacionArticulo", "Situacion", "Habilitado")
_ESTADO_ART_DESC = {1: "Habilitado", 2: "Suspendido", 3: "Baja"}
_SQL_COLS_ART = """
SELECT COLUMN_NAME
FROM EVERWEAR.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'StkFer_Articulos'
"""
_col_estado_art: str | None = None
_col_estado_art_resuelto = False


def _col_estado_articulo(cur) -> str | None:
    """Nombre real de la columna de estado en StkFer_Articulos, o None."""
    global _col_estado_art, _col_estado_art_resuelto
    if _col_estado_art_resuelto:
        return _col_estado_art
    try:
        cur.execute(_SQL_COLS_ART)
        cols = {str(r[0]).strip() for r in cur.fetchall()}
        _col_estado_art = next((c for c in _CAND_ESTADO_ART if c in cols), None)
    except Exception:  # noqa: BLE001 - si falla, se sigue sin la columna
        _col_estado_art = None
    _col_estado_art_resuelto = True
    return _col_estado_art


def _sql_con_estado_art(sql: str, col: str | None) -> str:
    """Reemplaza el placeholder --ESTADO_ART-- por la columna detectada."""
    return sql.replace("--ESTADO_ART--", f"s.[{col}]" if col else "NULL")


def _estado_art_desc(v):
    """1/2/3 (o el texto que traiga la columna) → 'Habilitado'/'Suspendido'/'Baja'."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return str(v).strip()
    return _ESTADO_ART_DESC.get(n, f"({n})")


# ── Faltantes (renglones pendientes del último día con registro < hoy) ────────
SQL_FALTANTES = """
SELECT
    p.NroPedOrigen, p.NroRengOrigen,
    CONVERT(date, DATEADD(day, p.FecRegistracion, '1800-12-28')) AS Fecha,
    u.ubicacion AS SecuenciaRutPicking,
    p.CodArticu,
    ap.Detalle      AS Patron,
    s.DetalleMedida AS Medida,
    s.UnidadMedida  AS Unidad,
    p.CantPendiente,
    p.CodCliente,
    cli.Cliente_Nombre AS ClienteNombre,
    p.PrecioVenta,
    LTRIM(RTRIM(n1.Detalle)) AS Linea,   -- nombre real (Stk_Nivel1), no el codigo
    t.Descripcion   AS TipoArticulo,
    --ESTADO_ART--   AS EstadoArticulo,   -- 1 Habilitado / 2 Suspendido / 3 Baja (columna detectada, ver _col_estado_articulo)
    pest.Ped_EstadoDescripcion AS EstadoPedido,
    gp.Nombre       AS Preparador,
    pr.RazonSocial  AS Proveedor,
    -- Maestro correcto de vendedores = MAGNUS_SITD.dbo.Vendedores (mismo que
    -- usa /ventas/bulones y cartera.py). Ped_Usu_Arma es OTRO maestro con el
    -- mismo rango de codigos y personas distintas: queda solo como respaldo y
    -- se descarta si lo que trae es un numero (codigo suelto, no un nombre).
    COALESCE(
        NULLIF(LTRIM(RTRIM(vend.VendedorNombre)), ''),
        NULLIF(CASE WHEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) LIKE '%[^0-9]%'
                    THEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) END, '')
    ) AS Vendedor
FROM EVERWEAR.dbo.[Ven_PedRenPendientes] p
OUTER APPLY (
    -- Ubicación asignada de picking = numérica con guión (rack). Excluye depósito
    -- (letras) y el carro de preparado (0002, sin guión). 1 sola por renglón.
    SELECT TOP 1 u2.ubicacion
    FROM EVERWEAR.dbo.[Ubicacion#] u2
    WHERE u2.codArticulo = p.CodArticu
      AND u2.ubicacion NOT LIKE '%[A-Za-z]%'
      AND u2.ubicacion LIKE '%-%'
    ORDER BY u2.ubicacion
) u
LEFT JOIN EVERWEAR.dbo.[StkFer_Articulos]      s  ON s.CodArticulo    = p.CodArticu
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet]     ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]            n1 ON n1.Nivel1         = ap.Nivel1
LEFT JOIN EVERWEAR.dbo.[Stk_TiposArticulos]    t  ON t.CodigoTipo     = s.NacionalImportado
LEFT JOIN EVERWEAR.dbo.[Com_Proveedores]       pr ON pr.CodProveed    = s.CodProveedHabitual
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoRengPreparacion] prep ON prep.NroMovVenta = p.NroPedOrigen AND prep.NroRenglon = p.NroRengOrigen
LEFT JOIN EVERWEAR.dbo.[Gen_Usuarios]          gp ON gp.Numero       = prep.CodPreparador
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoCabecera] cab ON cab.NroMovVenta = p.NroPedOrigen
LEFT JOIN MAGNUS_SITD.dbo.[Ped_Usu_Arma]       uv ON cab.Vendedor    = uv.Usu_Arma_Codigo
LEFT JOIN MAGNUS_SITD.dbo.[Vendedores]         vend ON vend.VendedorCodigo = cab.Vendedor
LEFT JOIN MAGNUS_SITD.dbo.[Pedido_Estados]     pest ON pest.Ped_Estado    = cab.EstadoPedido
LEFT JOIN MAGNUS_SITD.dbo.[Clientes]           cli ON cli.CodCliente = p.CodCliente
WHERE p.FecRegistracion = (
    SELECT MAX(FecRegistracion)
    FROM EVERWEAR.dbo.[Ven_PedRenPendientes]
    WHERE FecRegistracion < DATEDIFF(day, '1800-12-28', CAST(GETDATE() AS date))
)
ORDER BY u.ubicacion, p.NroPedOrigen, p.NroRengOrigen
"""

# Mismo universo, pero por RANGO de snapshots. Cada día de Ven_PedRenPendientes es
# una foto del backlog completo: la misma línea (ped, reng) se repite en la foto de
# cada día hasta que se entrega. Para NO doble contar al ampliar el rango:
#   · se deduplica por (ped, reng) quedándose con la fila más nueva (rn=1) para la
#     CantPendiente / datos actuales, y
#   · PrimerDia = MIN(FecRegistracion) en el rango = primer día que ese faltante
#     aparece. Así "el faltante de cada día" es lo que recién aparece ese día, y la
#     OC se puede restar por día (FIFO) sin contar dos veces lo que ya venía.
# Params: ? = desde_num, ? = hasta_num (días Magnus, ya capados a < hoy en Python).
SQL_FALTANTES_RANGO = """
WITH base AS (
    SELECT
        p.NroPedOrigen, p.NroRengOrigen, p.CodArticu,
        p.CantPendiente, p.CodCliente, p.PrecioVenta, p.FecRegistracion,
        ROW_NUMBER() OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
            ORDER BY p.FecRegistracion DESC
        ) AS rn,
        MIN(p.FecRegistracion) OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
        ) AS PrimerDiaNum,
        MAX(p.FecRegistracion) OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
        ) AS UltimoDiaNum
    FROM EVERWEAR.dbo.[Ven_PedRenPendientes] p
    WHERE p.FecRegistracion BETWEEN ? AND ?
)
SELECT
    b.NroPedOrigen, b.NroRengOrigen,
    CONVERT(date, DATEADD(day, b.FecRegistracion, '1800-12-28')) AS Fecha,
    CONVERT(date, DATEADD(day, b.PrimerDiaNum,   '1800-12-28')) AS PrimerDia,
    u.ubicacion AS SecuenciaRutPicking,
    b.CodArticu,
    ap.Detalle      AS Patron,
    s.DetalleMedida AS Medida,
    s.UnidadMedida  AS Unidad,
    b.CantPendiente,
    b.CodCliente,
    cli.Cliente_Nombre AS ClienteNombre,
    b.PrecioVenta,
    LTRIM(RTRIM(n1.Detalle)) AS Linea,   -- nombre real (Stk_Nivel1), no el codigo
    t.Descripcion   AS TipoArticulo,
    --ESTADO_ART--   AS EstadoArticulo,   -- 1 Habilitado / 2 Suspendido / 3 Baja (columna detectada, ver _col_estado_articulo)
    pest.Ped_EstadoDescripcion AS EstadoPedido,
    gp.Nombre       AS Preparador,
    pr.RazonSocial  AS Proveedor,
    -- Maestro correcto de vendedores = MAGNUS_SITD.dbo.Vendedores (mismo que
    -- usa /ventas/bulones y cartera.py). Ped_Usu_Arma es OTRO maestro con el
    -- mismo rango de codigos y personas distintas: queda solo como respaldo y
    -- se descarta si lo que trae es un numero (codigo suelto, no un nombre).
    COALESCE(
        NULLIF(LTRIM(RTRIM(vend.VendedorNombre)), ''),
        NULLIF(CASE WHEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) LIKE '%[^0-9]%'
                    THEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) END, '')
    ) AS Vendedor
FROM base b
OUTER APPLY (
    -- Ubicación asignada de picking = numérica con guión (rack). Excluye depósito
    -- (letras) y el carro de preparado (0002, sin guión). 1 sola por renglón.
    SELECT TOP 1 u2.ubicacion
    FROM EVERWEAR.dbo.[Ubicacion#] u2
    WHERE u2.codArticulo = b.CodArticu
      AND u2.ubicacion NOT LIKE '%[A-Za-z]%'
      AND u2.ubicacion LIKE '%-%'
    ORDER BY u2.ubicacion
) u
LEFT JOIN EVERWEAR.dbo.[StkFer_Articulos]      s  ON s.CodArticulo    = b.CodArticu
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet]     ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]            n1 ON n1.Nivel1         = ap.Nivel1
LEFT JOIN EVERWEAR.dbo.[Stk_TiposArticulos]    t  ON t.CodigoTipo     = s.NacionalImportado
LEFT JOIN EVERWEAR.dbo.[Com_Proveedores]       pr ON pr.CodProveed    = s.CodProveedHabitual
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoRengPreparacion] prep ON prep.NroMovVenta = b.NroPedOrigen AND prep.NroRenglon = b.NroRengOrigen
LEFT JOIN EVERWEAR.dbo.[Gen_Usuarios]          gp ON gp.Numero       = prep.CodPreparador
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoCabecera] cab ON cab.NroMovVenta = b.NroPedOrigen
LEFT JOIN MAGNUS_SITD.dbo.[Ped_Usu_Arma]       uv ON cab.Vendedor    = uv.Usu_Arma_Codigo
LEFT JOIN MAGNUS_SITD.dbo.[Vendedores]         vend ON vend.VendedorCodigo = cab.Vendedor
LEFT JOIN MAGNUS_SITD.dbo.[Pedido_Estados]     pest ON pest.Ped_Estado    = cab.EstadoPedido
LEFT JOIN MAGNUS_SITD.dbo.[Clientes]           cli ON cli.CodCliente = b.CodCliente
WHERE b.rn = 1
  -- Solo lo que sigue pendiente en la foto más nueva del rango: si un renglón se
  -- entregó a mitad del rango (no llega al último snapshot) NO es demanda viva.
  AND b.UltimoDiaNum = (
      SELECT MAX(FecRegistracion)
      FROM EVERWEAR.dbo.[Ven_PedRenPendientes]
      WHERE FecRegistracion BETWEEN ? AND ?
  )
ORDER BY PrimerDia, u.ubicacion, b.NroPedOrigen, b.NroRengOrigen
"""

# Igual que SQL_FALTANTES_RANGO pero HISTÓRICO: NO descarta lo que se entregó a
# mitad del rango. Trae todos los renglones que aparecieron en [desde, hasta] y
# agrega la columna Vivo:
#   · Vivo = 1 → el renglón sigue pendiente en la foto más nueva del rango
#               (demanda viva, igual que la vista normal).
#   · Vivo = 0 → ya se entregó/cubrió a mitad del rango (faltante histórico).
# CantPendiente sale de la fila más nueva del renglón (rn=1), o sea lo que
# faltaba justo antes de entregarse. Params: CTE (d,h) + CASE Vivo (d,h).
SQL_FALTANTES_RANGO_HIST = """
WITH base AS (
    SELECT
        p.NroPedOrigen, p.NroRengOrigen, p.CodArticu,
        p.CantPendiente, p.CodCliente, p.PrecioVenta, p.FecRegistracion,
        ROW_NUMBER() OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
            ORDER BY p.FecRegistracion DESC
        ) AS rn,
        MIN(p.FecRegistracion) OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
        ) AS PrimerDiaNum,
        MAX(p.FecRegistracion) OVER (
            PARTITION BY p.NroPedOrigen, p.NroRengOrigen
        ) AS UltimoDiaNum
    FROM EVERWEAR.dbo.[Ven_PedRenPendientes] p
    WHERE p.FecRegistracion BETWEEN ? AND ?
)
SELECT
    b.NroPedOrigen, b.NroRengOrigen,
    CONVERT(date, DATEADD(day, b.FecRegistracion, '1800-12-28')) AS Fecha,
    CONVERT(date, DATEADD(day, b.PrimerDiaNum,   '1800-12-28')) AS PrimerDia,
    CASE WHEN b.UltimoDiaNum = (
        SELECT MAX(FecRegistracion)
        FROM EVERWEAR.dbo.[Ven_PedRenPendientes]
        WHERE FecRegistracion BETWEEN ? AND ?
    ) THEN 1 ELSE 0 END AS Vivo,
    u.ubicacion AS SecuenciaRutPicking,
    b.CodArticu,
    ap.Detalle      AS Patron,
    s.DetalleMedida AS Medida,
    s.UnidadMedida  AS Unidad,
    b.CantPendiente,
    b.CodCliente,
    cli.Cliente_Nombre AS ClienteNombre,
    b.PrecioVenta,
    LTRIM(RTRIM(n1.Detalle)) AS Linea,   -- nombre real (Stk_Nivel1), no el codigo
    t.Descripcion   AS TipoArticulo,
    --ESTADO_ART--   AS EstadoArticulo,   -- 1 Habilitado / 2 Suspendido / 3 Baja (columna detectada, ver _col_estado_articulo)
    pest.Ped_EstadoDescripcion AS EstadoPedido,
    gp.Nombre       AS Preparador,
    pr.RazonSocial  AS Proveedor,
    -- Maestro correcto de vendedores = MAGNUS_SITD.dbo.Vendedores (mismo que
    -- usa /ventas/bulones y cartera.py). Ped_Usu_Arma es OTRO maestro con el
    -- mismo rango de codigos y personas distintas: queda solo como respaldo y
    -- se descarta si lo que trae es un numero (codigo suelto, no un nombre).
    COALESCE(
        NULLIF(LTRIM(RTRIM(vend.VendedorNombre)), ''),
        NULLIF(CASE WHEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) LIKE '%[^0-9]%'
                    THEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) END, '')
    ) AS Vendedor
FROM base b
OUTER APPLY (
    -- Ubicación asignada de picking = numérica con guión (rack). Excluye depósito
    -- (letras) y el carro de preparado (0002, sin guión). 1 sola por renglón.
    SELECT TOP 1 u2.ubicacion
    FROM EVERWEAR.dbo.[Ubicacion#] u2
    WHERE u2.codArticulo = b.CodArticu
      AND u2.ubicacion NOT LIKE '%[A-Za-z]%'
      AND u2.ubicacion LIKE '%-%'
    ORDER BY u2.ubicacion
) u
LEFT JOIN EVERWEAR.dbo.[StkFer_Articulos]      s  ON s.CodArticulo    = b.CodArticu
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet]     ap ON ap.ArticuloPatron = s.ArticuloPatron
LEFT JOIN EVERWEAR.dbo.[Stk_Nivel1]            n1 ON n1.Nivel1         = ap.Nivel1
LEFT JOIN EVERWEAR.dbo.[Stk_TiposArticulos]    t  ON t.CodigoTipo     = s.NacionalImportado
LEFT JOIN EVERWEAR.dbo.[Com_Proveedores]       pr ON pr.CodProveed    = s.CodProveedHabitual
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoRengPreparacion] prep ON prep.NroMovVenta = b.NroPedOrigen AND prep.NroRenglon = b.NroRengOrigen
LEFT JOIN EVERWEAR.dbo.[Gen_Usuarios]          gp ON gp.Numero       = prep.CodPreparador
LEFT JOIN EVERWEAR.dbo.[VenFer_PedidoCabecera] cab ON cab.NroMovVenta = b.NroPedOrigen
LEFT JOIN MAGNUS_SITD.dbo.[Ped_Usu_Arma]       uv ON cab.Vendedor    = uv.Usu_Arma_Codigo
LEFT JOIN MAGNUS_SITD.dbo.[Vendedores]         vend ON vend.VendedorCodigo = cab.Vendedor
LEFT JOIN MAGNUS_SITD.dbo.[Pedido_Estados]     pest ON pest.Ped_Estado    = cab.EstadoPedido
LEFT JOIN MAGNUS_SITD.dbo.[Clientes]           cli ON cli.CodCliente = b.CodCliente
WHERE b.rn = 1
ORDER BY PrimerDia, u.ubicacion, b.NroPedOrigen, b.NroRengOrigen
"""

# Snapshots disponibles (para el selector de fechas de la vista). Solo < hoy.
SQL_FALTANTES_FECHAS = """
SELECT DISTINCT TOP (180)
       CONVERT(date, DATEADD(day, FecRegistracion, '1800-12-28')) AS Fecha
FROM EVERWEAR.dbo.[Ven_PedRenPendientes]
WHERE FecRegistracion < DATEDIFF(day, '1800-12-28', CAST(GETDATE() AS date))
ORDER BY Fecha DESC
"""


def _rango_dias(desde, hasta):
    """desde/hasta = date | 'YYYY-MM-DD' | None → (desde_num, hasta_num) en días
    Magnus. hasta se capa a < hoy (igual que el default) y el span máx a 180 días."""
    today_num = (date.today() - _BASE_PEDIDO).days

    def _to_date(v, default):
        if v is None:
            return default
        if isinstance(v, date):
            return v
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()

    h_date = _to_date(hasta, date.today())
    h_num = min((h_date - _BASE_PEDIDO).days, today_num - 1)
    d_date = _to_date(desde, h_date)
    d_num = (d_date - _BASE_PEDIDO).days
    if d_num > h_num:
        d_num = h_num
    if d_num < h_num - 180:
        d_num = h_num - 180
    return d_num, h_num


def _txt(v):
    return str(v).strip() if v is not None else ""


def _int(v):
    v = _safe(v)
    return int(v) if v is not None else None


def _iso(v):
    """date/datetime/str → 'YYYY-MM-DD' o None."""
    if v is None:
        return None
    if isinstance(v, (date, datetime)):
        return v.isoformat()[:10]
    return str(v)[:10]


def fetch_faltantes(desde=None, hasta=None, historico=False):
    """Sin rango (desde/hasta None): último snapshot con registro < hoy
    (comportamiento original, sin cambios para /deposito/faltantes).

    Con rango: todos los snapshots de [desde, hasta] deduplicados por renglón.
    Cada fila trae además 'Fecha' (snapshot más nuevo del renglón en el rango) y
    'PrimerDia' (primera aparición del faltante en el rango).

    historico=True (solo con rango): NO descarta lo que se entregó a mitad del
    rango. Cada fila trae 'Vivo' (1 = sigue pendiente en la foto más nueva,
    0 = faltante histórico ya entregado/cubierto)."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        col_est = _col_estado_articulo(cur)  # cacheado: 1 sola vez por proceso
        if desde is None and hasta is None:
            cur.execute(_sql_con_estado_art(SQL_FALTANTES, col_est))
        else:
            d_num, h_num = _rango_dias(desde, hasta)
            # params: BETWEEN del CTE (d,h) + BETWEEN de la subconsulta (d,h)
            sql = SQL_FALTANTES_RANGO_HIST if historico else SQL_FALTANTES_RANGO
            cur.execute(_sql_con_estado_art(sql, col_est), (d_num, h_num, d_num, h_num))
        cols = [c[0] for c in cur.description]
        fecha, rows = None, []
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            fila_fecha = _iso(d.get("Fecha"))
            if fecha is None and fila_fecha is not None:
                fecha = fila_fecha
            primer = _iso(d.get("PrimerDia")) or fila_fecha
            nombre = " ".join(" ".join(_txt(d.get(c)) for c in ("Patron", "Medida", "Unidad")).split())
            cant   = float(_safe(d.get("CantPendiente")) or 0)
            precio = float(_safe(d.get("PrecioVenta")) or 0)
            rows.append({
                "NroPedOrigen":  _int(d.get("NroPedOrigen")),
                "NroRengOrigen": _int(d.get("NroRengOrigen")),
                "Ubicacion":     _safe(d.get("SecuenciaRutPicking")),
                "CodArticulo":   _txt(d.get("CodArticu")),
                "Nombre":        nombre,
                "CantPend":      cant,
                "Cliente":       _safe(d.get("CodCliente")),
                "ClienteNombre": _txt(d.get("ClienteNombre")) or None,
                "Importe":       round(precio * cant, 2),
                "TipoArticulo":  _txt(d.get("TipoArticulo")).replace("Fabril", "Fabrica"),
                # Estado del ARTÍCULO (Habilitado/Suspendido/Baja) y del PEDIDO
                # del renglón: /compras usa los dos para recortar el mes igual
                # que el reporte de Magnus (habilitados, sin pedidos cancelados).
                "EstadoArticulo": _estado_art_desc(d.get("EstadoArticulo")),
                "EstadoPedido":  _txt(d.get("EstadoPedido")) or None,
                "Preparador":    _txt(d.get("Preparador")),
                "Linea":         _safe(d.get("Linea")),
                "Proveedor":     _txt(d.get("Proveedor")),
                "Vendedor":      _txt(d.get("Vendedor")),
                "Fecha":         fila_fecha,
                "PrimerDia":     primer,
                "Vivo":          int(_safe(d.get("Vivo")) if d.get("Vivo") is not None else 1),
            })
        return {"fecha": fecha, "total": len(rows), "rows": rows}
    finally:
        conn.close()


def fetch_faltantes_fechas():
    """Lista de snapshots disponibles (fechas con registro < hoy), nuevo→viejo."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_FALTANTES_FECHAS)
        out = []
        for row in cur.fetchall():
            f = _iso(row[0])
            if f:
                out.append(f)
        return {"total": len(out), "fechas": out}
    finally:
        conn.close()


# ── Faltantes por OT (NUEVA fuente de /deposito/faltantes) ────────────────────
# En vez de leer el snapshot Ven_PedRenPendientes, se mira el armado real: por cada
# OT de Picking ejecutada se cuentan los renglones (OTItem tipo 1) que se
# RECOLECTARON (CantCumplida > 0 = "cumplido") y los que NO (CantCumplida = 0 =
# "faltante", el operario no encontró el artículo). Se agrupa por OT y se queda
# solo con las OT que tienen al menos un faltante.
#
# OJO "cumplido" es binario (se recolectó algo / nada), igual que la productividad
# (parseDeposito.ts). Un renglón parcial (pidió 10, recolectó 4) cuenta como
# cumplido; para tratar parciales como faltante haría falta la columna de cantidad
# PEDIDA del OTItem (confirmar nombre con el diagnóstico) y comparar contra
# CantCumplida.
#
# El filtro por ESTADO del pedido en Magnus se hace vía whitelist: se trae
# OT.{OT_COL_PEDIDO} = NroMovVenta, se cruza con VenFer_PedidoCabecera/
# Pedido_Estados (conexión EVERWEAR, como el resto) y solo quedan los pedidos
# cuyo estado matchee ESTADOS_VALIDOS (Cerrado/Facturado).
SQL_FALTANTES_OT = """
WITH it AS (
    SELECT OTId,
        SUM(CASE WHEN OTItemTipo = 1 THEN 1 ELSE 0 END)                              AS ItemsTotal,
        SUM(CASE WHEN OTItemTipo = 1 AND OTItemCantCumplida > 0 THEN 1 ELSE 0 END)   AS ItemsCumplidos,
        SUM(CASE WHEN OTItemTipo = 1 AND ISNULL(OTItemCantCumplida, 0) = 0 THEN 1 ELSE 0 END) AS ItemsFaltantes
    FROM OTItem
    GROUP BY OTId
)
SELECT
    OT.OTId,
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 23) AS Fecha,
    OT.{col_pedido}            AS NroMovVenta,
    P_Repositor.PersonalNombre AS Operario,
    it.ItemsTotal,
    it.ItemsCumplidos,
    it.ItemsFaltantes
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN it    ON it.OTId        = OT.OTId
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
WHERE Codot.CodotProcesoNegocio = 4            -- Picking
  AND OT.OTEstado IN (2, 3, 4)                 -- ejecutada / terminada
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
  AND it.ItemsFaltantes > 0                    -- solo OT con faltante
ORDER BY it.ItemsFaltantes DESC, OT.OTId DESC
"""

# Último día con Picking ejecutado (< mañana). Default de la vista cuando no se
# pasa rango: muestra el armado del día más reciente.
SQL_OT_ULTIMO_DIA = """
SELECT MAX(CONVERT(date, OT.OTFechaHoraEjecucion)) AS f
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4
  AND OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion < DATEADD(day, 1, CAST(GETDATE() AS date))
"""

# Estado/cliente/vendedor del pedido (Magnus) para enriquecer y excluir descartados.
# ClienteNombre sale del mismo LEFT JOIN a MAGNUS_SITD.Clientes que ya usan las
# queries de faltantes (SQL_FALTANTES*): la fuente WMS (OT) solo tiene el codigo
# de cliente, asi que sin esto /deposito/faltantes propaga un numero y las vistas
# que se alimentan de ahi (preparado.faltante_wms -> /ventas/faltantes "En
# stock") muestran el codigo en lugar del nombre. Es una columna mas en la misma
# consulta chunkeada: no agrega roundtrips.
SQL_PEDIDOS_INFO = """
SELECT cab.NroMovVenta, cab.CodCliente,
       est.Ped_EstadoDescripcion AS Estado,
       COALESCE(
           NULLIF(LTRIM(RTRIM(vend.VendedorNombre)), ''),
           NULLIF(CASE WHEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) LIKE '%[^0-9]%'
                       THEN LTRIM(RTRIM(uv.Usu_Arma_Nombre)) END, '')
       )                         AS Vendedor,
       cab.CompCodigo            AS CompCodigo,
       LTRIM(RTRIM(cli.Cliente_Nombre)) AS ClienteNombre
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
LEFT JOIN MAGNUS_SITD.dbo.Pedido_Estados est ON cab.EstadoPedido = est.Ped_Estado
LEFT JOIN MAGNUS_SITD.dbo.Ped_Usu_Arma   uv  ON cab.Vendedor     = uv.Usu_Arma_Codigo
LEFT JOIN MAGNUS_SITD.dbo.Vendedores    vend ON vend.VendedorCodigo = cab.Vendedor
LEFT JOIN MAGNUS_SITD.dbo.Clientes       cli ON cli.CodCliente   = cab.CodCliente
WHERE cab.NroMovVenta IN ({ph})
"""


def _rango_ot(desde, hasta):
    """desde/hasta = 'YYYY-MM-DD' | None → (datetime inicio, datetime fin).
    Si falta uno, se usa el otro (rango de un día). Default ambos = None lo maneja
    fetch_faltantes_ot con el último día con armado."""
    hoy = date.today()
    h_d = datetime.strptime(hasta, "%Y-%m-%d").date() if hasta else (
          datetime.strptime(desde, "%Y-%m-%d").date() if desde else hoy)
    d_d = datetime.strptime(desde, "%Y-%m-%d").date() if desde else h_d
    if d_d > h_d:
        d_d = h_d
    d = datetime(d_d.year, d_d.month, d_d.day, 0, 0, 0)
    h = datetime(h_d.year, h_d.month, h_d.day, 23, 59, 59)
    return d, h


def _es_valido(estado_desc) -> bool:
    s = str(estado_desc or "").upper()
    if any(p in s for p in PATRONES_CANCELADO):
        return False
    return any(p in s for p in ESTADOS_VALIDOS)


def _info_pedidos(pedidos):
    """Mapa NroMovVenta -> Cliente / Estado / Vendedor para la lista dada (chunked)."""
    out: dict[int, dict] = {}
    if not pedidos:
        return out
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        CH = 1000
        for i in range(0, len(pedidos), CH):
            chunk = pedidos[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            cur.execute(SQL_PEDIDOS_INFO.format(ph=ph), chunk)
            for r in cur.fetchall():
                out[int(r[0])] = {
                    "Cliente": _safe(r[1]),
                    "Estado":  _txt(r[2]),
                    "Vendedor": _txt(r[3]),
                    "CompCodigo": _int(r[4]),
                    "ClienteNombre": _txt(r[5]) or None,
                }
        return out
    finally:
        conn.close()


def fetch_faltantes_ot(desde=None, hasta=None):
    """Faltantes agrupados por OT de Picking. Cumplido = renglón recolectado,
    faltante = renglón sin recolectar. Excluye pedidos descartados (estado Magnus).

    Sin params → último día con armado. Con desde/hasta (YYYY-MM-DD) → ese rango
    por OTFechaHoraEjecucion."""
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        if desde is None and hasta is None:
            cur.execute(SQL_OT_ULTIMO_DIA)
            row = cur.fetchone()
            dia = row[0] if row else None
            if dia is None:
                return {"fecha": None, "desde": None, "hasta": None,
                        "total": 0, "rows": [],
                        "resumen": {"ot": 0, "itemsTotal": 0, "itemsCumplidos": 0,
                                    "itemsFaltantes": 0, "otDescartadas": 0}}
            d = datetime(dia.year, dia.month, dia.day, 0, 0, 0)
            h = datetime(dia.year, dia.month, dia.day, 23, 59, 59)
        else:
            d, h = _rango_ot(desde, hasta)
        cur.execute(SQL_FALTANTES_OT.format(col_pedido=OT_COL_PEDIDO), (d, h))
        cols = [c[0] for c in cur.description]
        ots = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    pedidos = sorted({int(o["NroMovVenta"]) for o in ots if o.get("NroMovVenta") is not None})
    info = _info_pedidos(pedidos)

    rows, excluidas = [], 0
    for o in ots:
        nro = int(o["NroMovVenta"]) if o.get("NroMovVenta") is not None else None
        meta = info.get(nro, {})
        estado = meta.get("Estado")
        if not _es_valido(estado):
            excluidas += 1
            continue
        rows.append({
            "OTId":           _int(o.get("OTId")),
            "NroMovVenta":    nro,
            "Fecha":          _iso(o.get("Fecha")),
            "Operario":       _txt(o.get("Operario")),
            "Cliente":        meta.get("Cliente"),
            "ClienteNombre":  meta.get("ClienteNombre"),
            "Vendedor":       _txt(meta.get("Vendedor")),
            "EstadoPedido":   _txt(estado),
            "ItemsTotal":     _int(o.get("ItemsTotal")) or 0,
            "ItemsCumplidos": _int(o.get("ItemsCumplidos")) or 0,
            "ItemsFaltantes": _int(o.get("ItemsFaltantes")) or 0,
        })

    resumen = {
        "ot":             len(rows),
        "itemsTotal":     sum(r["ItemsTotal"] for r in rows),
        "itemsCumplidos": sum(r["ItemsCumplidos"] for r in rows),
        "itemsFaltantes": sum(r["ItemsFaltantes"] for r in rows),
        "otDescartadas":  excluidas,
    }
    return {
        "fecha": _iso(d),
        "desde": _iso(d),
        "hasta": _iso(h),
        "total": len(rows),
        "rows":  rows,
        "resumen": resumen,
    }


# ── Renglones OT Cumplidas con diferencia pedida≠cumplida (/deposito/ot-diferencias)
# Picking, OT.OTEstado=2 (Cumplido), OTItemTipo=1 (Recolectar). Por rango de fecha
# de ejecución. Si 'hasta' no se pasa o cae hoy/futuro, se resuelve al último día
# con OT Cumplida ANTES de hoy (salta findes/feriados sin registro). Fuente NUEVA
# de /deposito/faltantes (reemplaza el snapshot Ven_PedRenPendientes de Magnus).
SQL_OT_ULTIMO_DIA_CUMPLIDO = """
SELECT MAX(CONVERT(date, OT.OTFechaHoraEjecucion)) AS f
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4
  AND OT.OTEstado = 2
  AND OT.OTFechaHoraEjecucion < CAST(GETDATE() AS date)
"""

SQL_OT_DIFERENCIAS = """
SELECT
    OT.OTId,
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 23) AS Fecha,
    OT.{col_pedido}              AS NroMovVenta,
    P_Repositor.PersonalNombre   AS Operario,
    i.OTItemNroRenglon           AS Renglon,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS Ubicacion,
    LTRIM(RTRIM(i.OTItemArticuloId))      AS CodArticulo,
    i.OTItemCantPedida           AS CantPedida,
    i.OTItemCantCumplida         AS CantCumplida
FROM OT
INNER JOIN Codot   ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
WHERE Codot.CodotProcesoNegocio = 4                    -- Picking
  AND OT.OTEstado = 2                                  -- Cumplido
  AND i.OTItemTipo = 1                                 -- Recolectar
  AND i.OTItemCantPedida > i.OTItemCantCumplida         -- solo faltante real (pedida > cumplida, excluye negativas de sobreenvíos previos)
  AND LTRIM(RTRIM(i.OTItemUbicacionCodigo)) <> 'PLAYA_PEDIDOS'
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
ORDER BY OT.OTId DESC, i.OTItemNroRenglon
"""


def _rango_ot_diferencias(desde=None, hasta=None):
    hoy = date.today()
    h_d = datetime.strptime(hasta, "%Y-%m-%d").date() if hasta else None
    if h_d is None or h_d >= hoy:
        conn = get_connection("WMS")
        try:
            cur = conn.cursor()
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            cur.execute(SQL_OT_ULTIMO_DIA_CUMPLIDO)
            row = cur.fetchone()
            h_d = row[0] if row and row[0] else hoy - timedelta(days=1)
        finally:
            conn.close()
    d_d = datetime.strptime(desde, "%Y-%m-%d").date() if desde else h_d
    if d_d > h_d:
        d_d = h_d
    d = datetime(d_d.year, d_d.month, d_d.day, 0, 0, 0)
    h = datetime(h_d.year, h_d.month, h_d.day, 23, 59, 59)
    return d, h


def fetch_ot_diferencias(desde=None, hasta=None):
    """Renglones de OT Picking Cumplidas con CantPedida > CantCumplida (faltante
    real; se excluyen las diferencias negativas, que corresponden a sobreenvíos
    de un faltante anterior, no a faltante actual). Excluye Ubicacion
    PLAYA_PEDIDOS.
    Sin params → último día Cumplido antes de hoy. Con desde/hasta → ese rango
    ('hasta' hoy/futuro se resuelve al último día Cumplido < hoy).
    Excluye pedidos descartados/anulados (Magnus)."""
    d, h = _rango_ot_diferencias(desde, hasta)
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_OT_DIFERENCIAS.format(col_pedido=OT_COL_PEDIDO), (d, h))
        cols = [c[0] for c in cur.description]
        filas = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    pedidos = sorted({int(f["NroMovVenta"]) for f in filas if f.get("NroMovVenta") is not None})
    info = _info_pedidos(pedidos)

    codigos = sorted({_txt(f.get("CodArticulo")) for f in filas if f.get("CodArticulo")})
    nombres: dict[str, str] = {}
    if codigos:
        ph = ",".join("?" for _ in codigos)
        sql_nombres = f"""
            SELECT LTRIM(RTRIM(s.CodArticulo)) AS Cod,
                   ap.Detalle      AS Patron,
                   s.DetalleMedida AS Medida,
                   s.UnidadMedida  AS Unidad
            FROM EVERWEAR.dbo.[StkFer_Articulos]  s
            LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
            WHERE LTRIM(RTRIM(s.CodArticulo)) IN ({ph})
        """
        conn_ew = get_connection("EVERWEAR")
        try:
            cur_ew = conn_ew.cursor()
            cur_ew.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            cur_ew.execute(sql_nombres, codigos)
            for cod, patron, medida, unidad in cur_ew.fetchall():
                nombres[_txt(cod)] = " ".join(" ".join(_txt(x) for x in (patron, medida, unidad)).split())
        finally:
            conn_ew.close()

    # Precio aproximado: no hay tabla de lista de precios en el proyecto — se
    # toma el ÚLTIMO PrecioVenta visto para ese CodArticulo en CUALQUIER pedido
    # de Ven_PedRenPendientes (no necesariamente el pedido de esta OT, que acá
    # puede ya no estar pendiente en Magnus). Aproximado a propósito (pedido del
    # usuario 2026-07-11): puede no reflejar la lista vigente si cambió.
    precios: dict[str, float] = {}
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
        conn_prec = get_connection("EVERWEAR")
        try:
            cur_prec = conn_prec.cursor()
            cur_prec.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            cur_prec.execute(sql_precios, codigos)
            for cod, precio in cur_prec.fetchall():
                precios[_txt(cod)] = float(_safe(precio) or 0)
        finally:
            conn_prec.close()

    rows, excluidas_ot = [], set()
    for f in filas:
        nro = int(f["NroMovVenta"]) if f.get("NroMovVenta") is not None else None
        meta = info.get(nro, {})
        if not _es_valido(meta.get("Estado")):
            excluidas_ot.add(_int(f.get("OTId")))
            continue
        pedida = float(_safe(f.get("CantPedida")) or 0)
        cumplida = float(_safe(f.get("CantCumplida")) or 0)
        precio = precios.get(_txt(f.get("CodArticulo")), 0.0)
        rows.append({
            "OTId":         _int(f.get("OTId")),
            "NroMovVenta":  nro,
            "Fecha":        _iso(f.get("Fecha")),
            "Operario":     _txt(f.get("Operario")),
            "Cliente":      meta.get("Cliente"),
            "ClienteNombre": meta.get("ClienteNombre"),
            "Vendedor":     _txt(meta.get("Vendedor")),
            "Renglon":      _int(f.get("Renglon")),
            "Ubicacion":    _txt(f.get("Ubicacion")),
            "CodArticulo":  _txt(f.get("CodArticulo")),
            "Nombre":       nombres.get(_txt(f.get("CodArticulo")), ""),
            "CantPedida":   pedida,
            "CantCumplida": cumplida,
            "Diferencia":   round(pedida - cumplida, 3),
            "PrecioVenta":  precio,
            "Importe":      round(precio * pedida, 2),
            # Comprobante Magnus del pedido (cab.CompCodigo) — campo agregado
            # 2026-07-31 para que el export de /deposito/faltantes/historico
            # pueda excluir códigos puntuales (70/75) sin
            # tocar el filtrado de _es_valido de acá arriba.
            "CompCodigo":   meta.get("CompCodigo"),
        })

    resumen = {"renglones": len(rows), "ot": len({r["OTId"] for r in rows}),
               "otDescartadas": len(excluidas_ot)}
    return {"desde": _iso(d), "hasta": _iso(h), "total": len(rows), "rows": rows, "resumen": resumen}


# Diagnóstico: confirmar el nombre real de la columna pedido en OT y qué estados
# de Magnus aparecen (para ajustar OT_COL_PEDIDO y ESTADOS_VALIDOS).
SQL_COLS_TABLA = """
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
"""


def fetch_faltantes_ot_diag():
    """Lista columnas de OT y OTItem (WMS) y, si se puede, los estados de pedido
    presentes en el último día de armado (EVERWEAR). Para confirmar el mapeo."""
    out: dict = {"ot_col_pedido_actual": OT_COL_PEDIDO,
                 "estados_validos": list(ESTADOS_VALIDOS),
                 "patrones_cancelado": list(PATRONES_CANCELADO)}
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_COLS_TABLA, ("OT",))
        ot_cols = [{"col": r[0], "tipo": r[1]} for r in cur.fetchall()]
        cur.execute(SQL_COLS_TABLA, ("OTItem",))
        oti_cols = [{"col": r[0], "tipo": r[1]} for r in cur.fetchall()]
        out["OT_columnas"] = ot_cols
        out["OTItem_columnas"] = oti_cols
        # candidatos a "columna del pedido" en OT
        out["OT_candidatos_pedido"] = [
            c["col"] for c in ot_cols
            if any(k in c["col"].upper() for k in ("MOVVENTA", "PEDIDO", "COMPROB", "NROMOV"))
        ]
        # candidatos a "cantidad PEDIDA" en OTItem (columnas de cantidad que NO son la
        # cumplida): una de estas es la que hay que comparar contra OTItemCantCumplida
        # para medir el faltante por unidades (pedida − cumplida).
        out["OTItem_candidatos_cantidad"] = [
            c["col"] for c in oti_cols
            if "CANT" in c["col"].upper() and "CUMPL" not in c["col"].upper()
        ]
        # muestra de renglones de Picking (tipo 1): mirando los valores se ve cuál
        # columna trae lo PEDIDO (debería ser >= OTItemCantCumplida).
        cur.execute("SELECT TOP 5 * FROM OTItem WHERE OTItemTipo = 1 ORDER BY OTId DESC")
        scols = [c[0] for c in cur.description]
        out["OTItem_muestra"] = [
            {c: _safe(v) for c, v in zip(scols, row)} for row in cur.fetchall()
        ]
    finally:
        conn.close()
    return out


# ── Tablero EN VIVO del depósito (/deposito/vivo) ─────────────────────────────
# Cuántos pedidos (OT) hay EN ESPERA, cuántos EN PROCESO y la carga por operario
# AHORA mismo. Se lee en vivo del WMS (READ UNCOMMITTED, igual que la productividad),
# nunca se escribe. No se filtra por fecha: una OT "viva" es la que todavía no está
# terminada, sin importar cuándo entró.
#
# Lógica del estado (OT.OTEstado). ESTADO_LABELS es la ÚNICA fuente de verdad para
# nombrar y clasificar cada OTEstado. Cada estado cae en un "bucket":
#   espera | proceso | fin | otro
#   · "En espera"  = estado en bucket 'espera'  (generada/pendiente, sin arrancar)
#   · "En proceso" = estado en bucket 'proceso' (arrancada, sin cerrar)
#   · "vivas"      = bucket espera o proceso (lo que sigue en juego)
#   · fin / otro   = terminada/cerrada/anulada u otros (se muestran, no suman a los KPI)
#
# IMPORTANTE: los códigos de abajo son la mejor inferencia. Para confirmarlos contra
# la realidad usá GET /deposito/vivo/estados (lista TODOS los OTEstado existentes con
# su conteo). Si algún código no cuadra, ajustá SOLO este diccionario.
PROCESOS_VIVO: tuple[int, ...] = (4,)  # 4 = Picking ("pedidos"). Ampliar si hace falta.

ESTADO_LABELS: dict[int, dict] = {
    0: {"label": "Generada",   "bucket": "espera"},
    1: {"label": "Pendiente",  "bucket": "espera"},
    2: {"label": "En proceso", "bucket": "proceso"},
    3: {"label": "Terminada",  "bucket": "fin"},
    4: {"label": "Cerrada",    "bucket": "fin"},
}

# Días hacia atrás que mira el descubrimiento de estados (/deposito/vivo/estados).
VIVO_ESTADOS_VENTANA_DIAS = 365


def _estado_meta(estado) -> dict:
    """{estado, label, bucket} de un OTEstado, con fallback para códigos no mapeados."""
    try:
        e = int(estado)
    except (TypeError, ValueError):
        return {"estado": None, "label": "Sin estado", "bucket": "otro"}
    m = ESTADO_LABELS.get(e)
    if m:
        return {"estado": e, "label": m["label"], "bucket": m["bucket"]}
    return {"estado": e, "label": f"Estado {e}", "bucket": "otro"}


def _estados_de_bucket(*buckets: str) -> tuple[int, ...]:
    return tuple(e for e, m in ESTADO_LABELS.items() if m["bucket"] in buckets)


ESTADOS_EN_ESPERA: tuple[int, ...] = _estados_de_bucket("espera")
ESTADOS_EN_PROCESO: tuple[int, ...] = _estados_de_bucket("proceso")
ESTADOS_VIVOS: tuple[int, ...] = _estados_de_bucket("espera", "proceso")

# Matriz operario × estado. Universo = "hoy + vivas":
#   · vivas = OT con estado en bucket espera/proceso (sin filtrar por fecha), y
#   · hoy   = OT con OTFechaHoraEjecucion >= hoy 00:00 (incluye terminadas hoy).
# Param: ? = hoy 00:00 (datetime).
SQL_VIVO = """
SELECT
    OT.OTEstado      AS Estado,
    P.PersonalNombre AS Operario,
    COUNT(*)         AS Cantidad
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
WHERE Codot.CodotProcesoNegocio IN ({procesos})
  AND ( OT.OTEstado IN ({vivos})
        OR OT.OTFechaHoraEjecucion >= ? )
GROUP BY OT.OTEstado, P.PersonalNombre
"""

# Descubrimiento: TODOS los OTEstado existentes (cualquier proceso) en la ventana,
# con su conteo y cuántas no tienen ejecución. Responde "qué estados puede tener
# una OT". Param vía .format(dias=...).
SQL_VIVO_TODOS_ESTADOS = """
SELECT
    OT.OTEstado AS Estado,
    COUNT(*)    AS Cantidad,
    SUM(CASE WHEN OT.OTFechaHoraEjecucion IS NULL THEN 1 ELSE 0 END) AS SinEjecucion,
    CONVERT(varchar(19), MAX(OT.OTFechaHoraEjecucion), 120)          AS UltimaEjecucion
FROM OT
WHERE OT.OTFechaHoraEjecucion IS NULL
   OR OT.OTFechaHoraEjecucion >= DATEADD(day, -{dias}, CAST(GETDATE() AS date))
GROUP BY OT.OTEstado
ORDER BY OT.OTEstado
"""


# ── Tablero por RANGO: OT por estado + carga por preparador (/deposito/wms) ───
# A diferencia de /deposito/vivo (foto de AHORA, sin fecha), acá se mira un RANGO
# por FECHA DE REGISTRACIÓN de la OT (= la columna "Registración" de la app WMS) y
# se cuenta cada OT por su OTEstado, además de la carga por operario (preparador)
# desglosada por estado. Solo lectura (READ UNCOMMITTED).
#
# IMPORTANTE: se filtra por OTFechaHoraRegist (= "Registración" de la app WMS, no por
# ejecución) para NO perder las OT que todavía no se ejecutaron (Pendiente / En proceso):
# esas no tienen fecha de ejecución pero sí de registración. Así coincide con la grilla.
# (confirmado vía /deposito/wms-estados/diag: las columnas de fecha de OT son
#  OTFechaHoraRegist, OTFechaHoraEjecucion, OTFechaHoraPickIni, OTFechaHoraPickFin)
WMS_COL_FECHA = "OTFechaHoraRegist"

# Etiquetas de OTEstado para ESTA vista. CONFIRMADO vía /deposito/wms-estados/diag:
# el orden del desplegable de la app (Pendiente, Cumplido, En Despacho, En Tránsito,
# En Proceso) = códigos 1..5, y los conteos lo respaldan (2=Cumplido es la mayoría;
# 5=En Proceso pocos y recientes; 1=Pendiente backlog). 3/4 no aparecen en Picking.
# bucket: solo para el color en la vista. Si algún día aparece un código nuevo, cae en
# "Estado N" (bucket otro) y se agrega acá.
#
# OJO 2026-07-23: el WMS pasa una OT a OTEstado=5 apenas queda ASIGNADA/despachada a
# un operario, no cuando arranca a picking de verdad — con lo cual "En proceso" venía
# mezclando OT recién asignadas (sin tocar) con OT realmente en curso, y por eso las
# cartas de /deposito/wms mostraban en "En proceso" lo que el usuario sabía que era
# en realidad Pendiente. Se reclasifica estado=5 en SQL usando progreso a nivel ítem
# (OTItemCantCumplida > 0, mismo criterio que ya usa fetch_wms/SQL_RESUMEN vía
# "CANT. ITEM RECOLECTADOS"): si ninguna línea tiene progreso, se cuenta como 1
# (Pendiente); si al menos una tiene progreso, se cuenta como 5 (En proceso, real).
WMS_ESTADO_LABELS: dict[int, dict] = {
    0: {"label": "Pendiente",   "bucket": "espera"},
    1: {"label": "Pendiente",   "bucket": "espera"},
    2: {"label": "Cumplido",    "bucket": "fin"},
    3: {"label": "En despacho", "bucket": "despacho"},
    4: {"label": "En tránsito", "bucket": "transito"},
    5: {"label": "En proceso",  "bucket": "proceso"},
}

# OJO 2026-07-23 (fix #2, encontrado): el usuario reportó que Pendiente+En
# proceso por operario seguía por debajo de la realidad (ej. Boscacci Vladimir
# real ~7 entre las dos, la vista daba 1; Maidana real ~8, daba 4) — DESPUÉS
# del fix de arriba (reclasificar estado=5). Causa: SQL_WMS_ESTADOS filtraba
# TODO por rango de fecha (WMS_COL_FECHA = OTFechaHoraRegist del día/rango
# consultado), así que una OT todavía Pendiente/En proceso pero REGISTRADA
# unos días antes del rango quedaba afuera — se "perdía" backlog viejo sin
# terminar, igual que le pasaba a /deposito/pedidos-hora con Magnus. Fix:
# mismo patrón que /deposito/vivo (SQL_VIVO, ver más arriba, "sin filtrar por
# fecha: una OT viva es la que todavía no está terminada, sin importar cuándo
# entró") — los estados "vivos" (bucket espera/proceso) se traen SIEMPRE,
# el filtro de fecha solo aplica a los terminales (Cumplido/despacho/tránsito),
# si no el "Cumplido" del día crecería sin límite.
WMS_ESTADOS_VIVOS: tuple[int, ...] = tuple(
    e for e, m in WMS_ESTADO_LABELS.items() if m["bucket"] in ("espera", "proceso")
)


def _wms_estado_meta(estado) -> dict:
    """{estado, label, bucket} de un OTEstado para la vista WMS, con fallback."""
    try:
        e = int(estado)
    except (TypeError, ValueError):
        return {"estado": None, "label": "Sin estado", "bucket": "otro"}
    m = WMS_ESTADO_LABELS.get(e)
    if m:
        return {"estado": e, "label": m["label"], "bucket": m["bucket"]}
    return {"estado": e, "label": f"Estado {e}", "bucket": "otro"}


SQL_WMS_ESTADOS = """
SELECT
    CASE WHEN OT.OTEstado = 5 AND ISNULL(it.Recolectados, 0) = 0
         THEN 1 ELSE OT.OTEstado END AS Estado,
    P.PersonalNombre AS Operario,
    COUNT(*)              AS Cantidad,
    ISNULL(SUM(it.Items), 0) AS Items
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
LEFT JOIN (
    SELECT OTId,
        SUM(CASE WHEN OTItemTipo = 1 THEN 1 ELSE 0 END)                          AS Items,
        SUM(CASE WHEN OTItemTipo = 1 AND OTItemCantCumplida > 0 THEN 1 ELSE 0 END) AS Recolectados
    FROM OTItem GROUP BY OTId
) it ON it.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio IN ({procesos})
  AND ( OT.OTEstado IN ({vivos})
        OR (OT.{col_fecha} >= ? AND OT.{col_fecha} <= ?) )
GROUP BY CASE WHEN OT.OTEstado = 5 AND ISNULL(it.Recolectados, 0) = 0
              THEN 1 ELSE OT.OTEstado END, P.PersonalNombre
"""

# Último día con OT registrada (para el default del tablero). Parametrizado por proceso.
SQL_WMS_ULTIMO_DIA = """
SELECT MAX(CONVERT(date, OT.{col_fecha})) AS f
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio IN ({procesos})
  AND OT.{col_fecha} < DATEADD(day, 1, CAST(GETDATE() AS date))
"""


def fetch_wms_estados(desde=None, hasta=None, procesos: tuple[int, ...] = PROCESOS_VIVO):
    """OT por estado y carga por preparador. Universo = "vivas + rango":
      · vivas (Pendiente/En proceso) → SIEMPRE, sin importar cuándo se
        registraron (mismo criterio que fetch_vivo/SQL_VIVO).
      · terminales (Cumplido/despacho/tránsito) → solo dentro del rango
        (OTFechaHoraRegist), si no "Cumplido" crecería sin límite.

    Sin desde/hasta → rango = último día con OT registrada (solo afecta a los
    terminales; las vivas se muestran igual). Devuelve:
      · estados      = [{estado, label, bucket, cantidad, items}] (todos los presentes)
      · por_operario = [{operario, total, total_items, por_estado: {<cod>: n},
                         items_por_estado: {<cod>: items}}] con ≥1 OT
      · resumen      = {total_ot, total_items, operarios, en_proceso, terminadas, ...}
    items = renglones de recolección (OTItem tipo 1) sumados sobre las OT."""
    proc_in = ",".join(str(int(p)) for p in procesos)
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        if desde is None and hasta is None:
            cur.execute(SQL_WMS_ULTIMO_DIA.format(procesos=proc_in, col_fecha=WMS_COL_FECHA))
            row = cur.fetchone()
            dia = row[0] if row else None
            if dia is None:
                return {"fecha": None, "desde": None, "hasta": None,
                        "procesos": list(procesos), "estados": [],
                        "por_operario": [],
                        "resumen": {"total_ot": 0, "total_items": 0, "operarios": 0,
                                    "en_espera": 0, "en_proceso": 0, "terminadas": 0}}
            d = datetime(dia.year, dia.month, dia.day, 0, 0, 0)
            h = datetime(dia.year, dia.month, dia.day, 23, 59, 59)
        else:
            d, h = _rango_ot(desde, hasta)
        cur.execute(
            SQL_WMS_ESTADOS.format(
                procesos=proc_in, col_fecha=WMS_COL_FECHA,
                vivos=",".join(str(e) for e in WMS_ESTADOS_VIVOS),
            ),
            (d, h),
        )
        filas = cur.fetchall()
    finally:
        conn.close()

    por_estado: dict[int, int] = {}
    items_estado: dict[int, int] = {}
    por_op: dict[str, dict] = {}

    def _nuevo(nombre):
        return {"operario": nombre, "total": 0, "total_items": 0,
                "por_estado": {}, "items_por_estado": {}}

    sin_asignar = _nuevo("— Sin asignar")
    for estado, operario, cant, items in filas:
        cant = int(cant or 0)
        items = int(items or 0)
        ecode = _wms_estado_meta(estado)["estado"]
        por_estado[ecode] = por_estado.get(ecode, 0) + cant
        items_estado[ecode] = items_estado.get(ecode, 0) + items
        nombre = str(operario).strip() if operario is not None else ""
        dst = sin_asignar if not nombre else por_op.setdefault(nombre, _nuevo(nombre))
        dst["total"] += cant
        dst["total_items"] += items
        k = str(ecode)
        dst["por_estado"][k] = dst["por_estado"].get(k, 0) + cant
        dst["items_por_estado"][k] = dst["items_por_estado"].get(k, 0) + items

    estados = [
        {**_wms_estado_meta(e), "cantidad": c, "items": items_estado.get(e, 0)}
        for e, c in sorted(por_estado.items(), key=lambda kv: (kv[0] is None, kv[0]))
    ]
    operarios = sorted(por_op.values(), key=lambda x: (-x["total"], x["operario"]))
    if sin_asignar["total"] > 0:
        operarios.append(sin_asignar)

    buckets = {e: _wms_estado_meta(e)["bucket"] for e in por_estado}
    def _suma(bucket):
        return sum(c for e, c in por_estado.items() if buckets.get(e) == bucket)

    return {
        "fecha": _iso(d),
        "desde": _iso(d),
        "hasta": _iso(h),
        "procesos": list(procesos),
        "estados": estados,
        "por_operario": operarios,
        "resumen": {
            "total_ot":    sum(por_estado.values()),
            "total_items": sum(items_estado.values()),
            "operarios":   len(por_op),
            "en_espera":   _suma("espera"),
            "en_proceso":  _suma("proceso"),
            "terminadas":  _suma("fin"),
        },
    }


# Diagnóstico para clavar el mapeo de la vista /deposito/wms:
#   · OTEstado reales (con conteo) en los últimos N días → confirma qué código es cada
#     estado de la app (Pendiente / En Proceso / Cumplido / En Despacho / En Tránsito).
#   · Si el WMS tiene una tabla de descripciones de estado, la lista (candidatas) con
#     sus columnas → para reemplazar el mapeo hardcodeado por un JOIN si conviene.
#   · Columnas de OT con "Fecha"/"Registr" → confirma WMS_COL_FECHA (Registración).
SQL_WMS_DIAG_ESTADOS = """
SELECT OT.OTEstado AS Estado,
       COUNT(*)    AS Cantidad,
       CONVERT(varchar(19), MIN(OT.{col_fecha}), 120) AS PrimeraReg,
       CONVERT(varchar(19), MAX(OT.{col_fecha}), 120) AS UltimaReg
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4
  AND OT.{col_fecha} >= DATEADD(day, -{dias}, CAST(GETDATE() AS date))
GROUP BY OT.OTEstado
ORDER BY OT.OTEstado
"""

SQL_WMS_DIAG_TABLAS_ESTADO = """
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME LIKE '%Estado%' OR COLUMN_NAME LIKE '%EstadoDescrip%'
ORDER BY TABLE_NAME, ORDINAL_POSITION
"""


def fetch_wms_estados_diag(dias: int = 120):
    """Diagnóstico de la vista WMS: OTEstado reales + posibles tablas de descripción
    de estado + columnas de fecha de OT. Para confirmar WMS_ESTADO_LABELS y WMS_COL_FECHA."""
    out: dict = {"col_fecha_actual": WMS_COL_FECHA,
                 "labels_actuales": WMS_ESTADO_LABELS}
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        # OTEstado reales (Picking) con conteo
        try:
            cur.execute(SQL_WMS_DIAG_ESTADOS.format(col_fecha=WMS_COL_FECHA, dias=int(dias)))
            out["ot_estados"] = [
                {"estado": int(e), "cantidad": int(c or 0),
                 "primera_reg": pr, "ultima_reg": ur}
                for e, c, pr, ur in cur.fetchall()
            ]
        except Exception as ex:
            out["ot_estados_error"] = str(ex)
        # Columnas de OT (para confirmar la columna de Registración)
        cur.execute(SQL_COLS_TABLA, ("OT",))
        ot_cols = [{"col": r[0], "tipo": r[1]} for r in cur.fetchall()]
        out["OT_columnas_fecha"] = [c for c in ot_cols if "FECHA" in c["col"].upper()]
        out["OT_candidatos_registracion"] = [
            c["col"] for c in ot_cols
            if any(k in c["col"].upper() for k in ("REGISTR", "ALTA", "CREAC", "GENER"))
        ]
        out["OT_columnas_estado"] = [c for c in ot_cols if "ESTADO" in c["col"].upper()]
        # Tablas/columnas candidatas a "descripción de estado"
        try:
            cur.execute(SQL_WMS_DIAG_TABLAS_ESTADO)
            out["tablas_estado_candidatas"] = [
                {"tabla": r[0], "col": r[1], "tipo": r[2]} for r in cur.fetchall()
            ]
        except Exception as ex:
            out["tablas_estado_error"] = str(ex)
    finally:
        conn.close()
    return out


def fetch_vivo(procesos: tuple[int, ...] = PROCESOS_VIVO):
    """Estado del depósito EN VIVO: pedidos (OT) en espera / en proceso y por operario."""
    proc_in = ",".join(str(int(p)) for p in procesos)
    est_in = ",".join(str(int(e)) for e in (ESTADOS_EN_ESPERA + ESTADOS_EN_PROCESO))

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute(SQL_VIVO.format(procesos=proc_in, estados=est_in))
        en_espera = 0
        en_proceso = 0
        por_op: dict[str, dict] = {}
        sin_asignar = {"en_espera": 0, "en_proceso": 0}
        for estado, operario, cant in cur.fetchall():
            cant = int(cant or 0)
            bucket = "en_espera" if int(estado) in ESTADOS_EN_ESPERA else "en_proceso"
            if bucket == "en_espera":
                en_espera += cant
            else:
                en_proceso += cant
            nombre = (str(operario).strip() if operario is not None else "")
            if not nombre:
                sin_asignar[bucket] += cant
            else:
                o = por_op.setdefault(nombre, {"en_espera": 0, "en_proceso": 0})
                o[bucket] += cant

        operarios = [
            {
                "operario": k,
                "en_espera": v["en_espera"],
                "en_proceso": v["en_proceso"],
                "total": v["en_espera"] + v["en_proceso"],
            }
            for k, v in por_op.items()
        ]
        operarios.sort(key=lambda x: (-x["en_proceso"], -x["total"], x["operario"]))

        cur.execute(SQL_VIVO_TODOS_ESTADOS.format(dias=VIVO_ESTADOS_VENTANA_DIAS))
        diag = [
            {"estado": int(e), "cantidad": int(c or 0), "sin_ejecucion": int(se or 0)}
            for e, c, se, _ult in cur.fetchall()
        ]
# ]
#         diag = [
#             {"estado": int(e), "sin_ejecucion": int(se or 0), "cantidad": int(c or 0)}
#             for e, se, c in cur.fetchall()

        return {
            "generado_en": datetime.now().astimezone().isoformat(timespec="seconds"),
            "en_espera": en_espera,
            "en_proceso": en_proceso,
            "operarios_activos": sum(1 for o in operarios if o["en_proceso"] > 0),
            "sin_asignar": sin_asignar,
            "por_operario": operarios,
            "config": {
                "procesos": list(procesos),
                "estados_en_espera": list(ESTADOS_EN_ESPERA),
                "estados_en_proceso": list(ESTADOS_EN_PROCESO),
            },
            "diagnostico": {"por_estado": diag},
        }
    finally:
        conn.close()


# ── Resumen OT + faltantes agrupados por artículo (/deposito/vivo, resumen-ot) ─
# A diferencia de fetch_faltantes_ot (binario: recolectó algo / nada), acá se
# compara CANTIDAD pedida vs cumplida a nivel renglón Magnus (VenFer_PedidoReng,
# que ya trae CodArticu/Ubicacion/PrecioVenta), agrupado por artículo y SUMADO
# en todo el rango (no por OT individual). El precio NO se suma (MAX, 1 fila x art).

SQL_RESUMEN_OT_LIST = """
SELECT OT.OTId, OT.{col_pedido} AS NroMovVenta
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4   -- Picking
  AND OT.OTEstado IN (2, 3, 4)        -- ejecutada/terminada
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
"""

SQL_RESUMEN_ITEMS = """
SELECT
    r.CodArticu,
    MIN(LTRIM(RTRIM(r.Ubicacion)))   AS Ubicacion,
    SUM(r.CantidadPedida)            AS CantPedida,
    SUM(r.CantidadCumplida)          AS CantCumplida,
    MAX(r.PrecioVenta)               AS PrecioVenta
FROM EVERWEAR.dbo.VenFer_PedidoReng r
WHERE r.NroMovVenta IN ({ph})
GROUP BY r.CodArticu
"""


def fetch_resumen_ot(desde=None, hasta=None):
    """Resumen de OT (Picking) en rango: total OT, items pedidos/cumplidos, % y
    faltantes agrupados por artículo (sumado, no por OT), ordenado por ubicación.
    Excluye OT cuyo pedido Magnus está descartado/anulado."""
    d, h = _rango_ot(desde, hasta)

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_RESUMEN_OT_LIST.format(col_pedido=OT_COL_PEDIDO), (d, h))
        ots = [{"OTId": r[0], "NroMovVenta": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()

    pedidos_todos = sorted({int(o["NroMovVenta"]) for o in ots if o["NroMovVenta"] is not None})
    info = _info_pedidos_resumen(pedidos_todos)

    pedidos_validos, ot_total, ot_descartadas = [], 0, 0
    for o in ots:
        nro = int(o["NroMovVenta"]) if o["NroMovVenta"] is not None else None
        meta = info.get(nro, {})
        if not _es_valido(meta.get("Estado")) or meta.get("CompCodigo") in COMP_CODIGOS_EXCLUIDOS_RESUMEN:
            ot_descartadas += 1
            continue
        ot_total += 1
        if nro is not None:
            pedidos_validos.append(nro)
    pedidos_validos = sorted(set(pedidos_validos))

    items, items_pedidos, items_cumplidos = [], 0.0, 0.0
    if pedidos_validos:
        conn = get_connection("EVERWEAR")
        try:
            cur = conn.cursor()
            cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            CH = 1000
            for i in range(0, len(pedidos_validos), CH):
                chunk = pedidos_validos[i:i + CH]
                ph = ",".join("?" for _ in chunk)
                cur.execute(SQL_RESUMEN_ITEMS.format(ph=ph), chunk)
                for cod, ubic, pedida, cumplida, precio in cur.fetchall():
                    pedida = float(_safe(pedida) or 0)
                    cumplida = float(_safe(cumplida) or 0)
                    items_pedidos += pedida
                    items_cumplidos += cumplida
                    items.append({
                        "CodArticulo": _txt(cod),
                        "Ubicacion": _txt(ubic),
                        "CantPedida": pedida,
                        "CantCumplida": cumplida,
                        "Faltante": round(pedida - cumplida, 3),
                        "PrecioVenta": float(_safe(precio) or 0),
                    })
        finally:
            conn.close()

    items_faltantes = sorted(
        (it for it in items if it["Faltante"] >= 1),
        key=lambda x: x["Ubicacion"],
    )

    pct = round(items_cumplidos / items_pedidos * 100, 2) if items_pedidos else 0.0

    return {
        "desde": _iso(d), "hasta": _iso(h),
        "ot_total": ot_total,
        "ot_descartadas": ot_descartadas,
        "items_pedidos": round(items_pedidos, 3),
        "items_cumplidos": round(items_cumplidos, 3),
        "pct_cumplido": pct,
        "items_faltantes": items_faltantes,
    }
    
    
    # Comprobantes a excluir SOLO en resumen-ot (no tocar SQL_PEDIDOS_INFO de faltantes_ot)
COMP_CODIGOS_EXCLUIDOS_RESUMEN: tuple[int, ...] = (9, 49, 208)

SQL_PEDIDOS_INFO_RESUMEN = """
SELECT cab.NroMovVenta, cab.CompCodigo,
       est.Ped_EstadoDescripcion AS Estado
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
LEFT JOIN MAGNUS_SITD.dbo.Pedido_Estados est ON cab.EstadoPedido = est.Ped_Estado
WHERE cab.NroMovVenta IN ({ph})
"""


def _info_pedidos_resumen(pedidos):
    out: dict[int, dict] = {}
    if not pedidos:
        return out
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        CH = 1000
        for i in range(0, len(pedidos), CH):
            chunk = pedidos[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            cur.execute(SQL_PEDIDOS_INFO_RESUMEN.format(ph=ph), chunk)
            for nro, comp, estado in cur.fetchall():
                out[int(nro)] = {"CompCodigo": _int(comp), "Estado": _txt(estado)}
        return out
    finally:
        conn.close()


# ── Ubicaciones de un artículo (modal de /deposito/faltantes) ─────────────────
# Todas las ubicaciones (SIN el filtro numérico) con > 1 unidad. Sirve para ver
# si el faltante está físicamente en otro rack antes de marcar "sin existencia".
def fetch_articulo_ubicaciones(articulo: str):
    # Suma por ubicación (puede haber varias filas por lote/contenedor). El match
    # del artículo es por código trim (Magnus deja espacios a derecha).
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        sql = f"""
            SELECT LTRIM(RTRIM(u.{UBIC_COL_UBI}))  AS Ubicacion,
                   SUM(u.{UBIC_COL_CANT})          AS Cantidad
            FROM dbo.{UBIC_TABLA} u
            WHERE LTRIM(RTRIM(u.{UBIC_COL_ART})) = LTRIM(RTRIM(?))
            GROUP BY LTRIM(RTRIM(u.{UBIC_COL_UBI}))
            HAVING SUM(u.{UBIC_COL_CANT}) > 1
            ORDER BY SUM(u.{UBIC_COL_CANT}) DESC
        """
        cur.execute(sql, (articulo,))
        rows = [{"Ubicacion": _txt(u), "Cantidad": float(_safe(c) or 0)}
                for u, c in cur.fetchall()]
        return {"articulo": articulo, "total": len(rows), "rows": rows}
    finally:
        conn.close()


# ── Stock por depósito (1/2/3) + total, paginado (/deposito/stock) ────────────
# Suma UbicacionDetalleCantidad por artículo, pivotado por UbicacionDepositoId.
# Confirmado por diag /deposito/ubicacion-columnas/diag (2026-07-02): UbicacionDetalle
# SÍ trae columna de depósito (no estaba entre las 3 UBIC_COL_* originales).
# IDs de depósito fijos, confirmados por el usuario (2026-07-15): 1, 2, 3.
ARSU_TABLA   = "Stk_ArticSucursalDeposito"
ARSU_COL_ART = "CodArticulo"
ARSU_COL_DEP = "Deposito"
ARSU_COL_STK = "StkReal"
DEPOSITO_CENTRAL = 1
DEPOSITOS        = (1, 2, 3)


def _sql_pivot_stock(filtro_q: str = "") -> str:
    cols = ",\n               ".join(
        f"SUM(CASE WHEN a.{ARSU_COL_DEP} = {d} THEN a.{ARSU_COL_STK} ELSE 0 END) AS Stock{d}"
        for d in DEPOSITOS
    )
    deps = ",".join(str(d) for d in DEPOSITOS)
    return f"""
        SELECT LTRIM(RTRIM(a.{ARSU_COL_ART})) AS Cod,
               {cols},
               SUM(a.{ARSU_COL_STK}) AS StockTotal
        FROM dbo.{ARSU_TABLA} a
        WHERE a.{ARSU_COL_DEP} IN ({deps}) {filtro_q}
        GROUP BY LTRIM(RTRIM(a.{ARSU_COL_ART}))
        HAVING SUM(a.{ARSU_COL_STK}) > 0
        ORDER BY Cod
    """


def _run_pivot_query(sql: str, params: list) -> dict[str, dict]:
    """Ejecuta el pivot de stock y devuelve {Cod: {Stock1: x, Stock2: y, ..., StockTotal: z}}."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        if params:
            cur.execute(sql, params)
        else:
            cur.execute(sql)
        stock: dict[str, dict] = {}
        for row in cur.fetchall():
            cod = _txt(row[0])
            vals = {f"Stock{d}": float(_safe(row[1 + i]) or 0) for i, d in enumerate(DEPOSITOS)}
            vals["StockTotal"] = float(_safe(row[-1]) or 0)
            stock[cod] = vals
        return stock
    finally:
        conn.close()


def _info_articulos(codigos: list[str]) -> dict[str, dict]:
    """Nombre/Proveedor desde EVERWEAR para una lista de códigos (chunked de a 1000,
    igual criterio que fetch_stock_por_articulos)."""
    info: dict[str, dict] = {}
    if not codigos:
        return info
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        CH = 1000
        for i in range(0, len(codigos), CH):
            chunk = codigos[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            sql_info = f"""
                SELECT LTRIM(RTRIM(s.CodArticulo)) AS Cod,
                       ap.Detalle      AS Patron,
                       s.DetalleMedida AS Medida,
                       s.UnidadMedida  AS Unidad,
                       pr.RazonSocial  AS Proveedor
                FROM EVERWEAR.dbo.[StkFer_Articulos]  s
                LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
                LEFT JOIN EVERWEAR.dbo.[Com_Proveedores]   pr ON pr.CodProveed     = s.CodProveedHabitual
                WHERE LTRIM(RTRIM(s.CodArticulo)) IN ({ph})
            """
            cur.execute(sql_info, chunk)
            for cod, patron, medida, unidad, prov in cur.fetchall():
                cod = _txt(cod)
                nombre = " ".join(" ".join(_txt(x) for x in (patron, medida, unidad)).split())
                info[cod] = {"Nombre": nombre, "Proveedor": _txt(prov)}
    finally:
        conn.close()
    return info


def _build_stock_rows(stock: dict[str, dict]) -> list[dict]:
    """Junta el pivot de WMS con nombre/proveedor de EVERWEAR → filas ordenadas por código."""
    info = _info_articulos(list(stock.keys()))
    rows: list[dict] = []
    for cod, vals in stock.items():
        meta = info.get(cod, {})
        row = {"CodArticulo": cod, "Nombre": meta.get("Nombre", "")}
        row.update(vals)
        row["Proveedor"] = meta.get("Proveedor", "")
        rows.append(row)
    rows.sort(key=lambda r: r["CodArticulo"])
    return rows


def fetch_stock_deposito1(page: int = 1, page_size: int = 50, q: str | None = None):
    """Stock paginado por depósito (1/2/3) + total: código, nombre, stock de cada
    depósito, proveedor. No trae los 4mil+ artículos de un tiro:
    Paso 1 (WMS)      -> agrupa por artículo (pivot por depósito) y pagina con OFFSET/FETCH.
    Paso 2 (EVERWEAR) -> enriquece SOLO los códigos de esa página (nombre/proveedor)."""
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    offset = (page - 1) * page_size

    # BUG encontrado 2026-07-20 (mismo commit "fix stock" del 16/07 que dejó
    # fetch_stock_por_articulos rota, ver [[ever-compras-faltantes-stock-bug]]):
    # este filtro seguía armado con el alias/columna viejos (u.UBIC_COL_ART, de
    # WMS.UbicacionDetalle) pero _sql_pivot_stock ya solo tiene alias "a" sobre
    # EVERWEAR.Stk_ArticSucursalDeposito → con q vacío no se nota (no arma el
    # filtro), pero al buscar algo el SQL queda inválido (alias "u" no existe
    # en la query) → 503 "Error en API de stock".
    filtro_q = f"AND LTRIM(RTRIM(a.{ARSU_COL_ART})) LIKE ?" if q else ""
    sql_stock = _sql_pivot_stock(filtro_q) + " OFFSET ? ROWS FETCH NEXT ? ROWS ONLY"
    params: list = ([f"%{q}%"] if q else []) + [offset, page_size]

    stock = _run_pivot_query(sql_stock, params)
    return {"page": page, "page_size": page_size, "rows": _build_stock_rows(stock)}


# ── Stock COMPLETO por depósito (1/2/3) + total, sin paginar ──────────────────
# Usado por /deposito/stock/export (botón "Exportar Excel"): a diferencia de
# fetch_stock_deposito1 (paginado, para la vista web), trae el 100% del stock
# de un tiro. Mismo criterio: WMS.UbicacionDetalle, pivot por depósito.
def fetch_stock_export():
    stock = _run_pivot_query(_sql_pivot_stock(), [])
    rows = _build_stock_rows(stock)
    return {"total": len(rows), "rows": rows}


# ── Stock del depósito 1 para una lista puntual de artículos ──────────────────
# Usado por /compras/faltantes (columna "Stock"): a diferencia de fetch_stock_
# deposito1 (paginado, para la vista /deposito/stock), acá se pide el stock
# EXACTO de los códigos que ya están en pantalla (los que tienen faltante),
# sin paginar. Mismo criterio que fetch_stock_deposito1/fetch_stock_export desde
# el commit "fix stock" (2026-07-16): EVERWEAR.Stk_ArticSucursalDeposito, no
# WMS.UbicacionDetalle. BUG encontrado 2026-07-20: esa migración borró la
# constante UBIC_COL_DEP (quedó reemplazada por ARSU_COL_DEP para la tabla
# nueva) pero esta función seguía usando UBIC_COL_DEP/UBIC_TABLA/conn "WMS" →
# NameError en cada llamada → /deposito/stock-por-articulos devolvía 503 →
# el front lo tragaba silenciosamente (stockWarn, sin mostrarse) y mostraba
# Stock=0 para TODO artículo en /compras/faltantes aunque hubiera stock real
# en Magnus (ver caso E730020 TRAX GEAR 8 75W80: Magnus mostraba 12 en CENTRAL
# y la vista seguía marcando falta).
def fetch_stock_por_articulos(codigos: list[str]):
    codigos = [c.strip() for c in codigos if c and c.strip()]
    if not codigos:
        return {"rows": []}

    stock: dict[str, float] = {}
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        CH = 1000  # OFFSET/parámetros: por las dudas, en tandas (igual que _info_pedidos_resumen)
        for i in range(0, len(codigos), CH):
            chunk = codigos[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            sql = f"""
                SELECT LTRIM(RTRIM(a.{ARSU_COL_ART})) AS Cod,
                       SUM(a.{ARSU_COL_STK})          AS Stock
                FROM dbo.{ARSU_TABLA} a
                WHERE a.{ARSU_COL_DEP} = ?
                  AND LTRIM(RTRIM(a.{ARSU_COL_ART})) IN ({ph})
                GROUP BY LTRIM(RTRIM(a.{ARSU_COL_ART}))
            """
            cur.execute(sql, [DEPOSITO_CENTRAL] + chunk)
            for cod, cant in cur.fetchall():
                stock[_txt(cod)] = float(_safe(cant) or 0)
    finally:
        conn.close()

    rows = [{"CodArticulo": cod, "Stock": stock.get(cod, 0.0)} for cod in codigos]
    return {"rows": rows}


# ── Artículos con MÁS DE UNA ubicación asignada (para depurar el maestro) ──────
# Ubicación asignada = numérica con guión (rack); excluye depósito (letras) y
# carro (0002, sin guión). El que tenga >1 hay que dejarle una sola.
SQL_MULTI_UBIC = """
WITH asign AS (
    SELECT LTRIM(RTRIM(codArticulo)) AS Cod, LTRIM(RTRIM(ubicacion)) AS Ubic
    FROM EVERWEAR.dbo.[Ubicacion#]
    WHERE ubicacion NOT LIKE '%[A-Za-z]%' AND ubicacion LIKE '%-%'
),
multi AS (
    SELECT Cod FROM asign GROUP BY Cod HAVING COUNT(DISTINCT Ubic) > 1
)
SELECT a.Cod, a.Ubic,
       ap.Detalle AS Patron, s.DetalleMedida AS Medida, s.UnidadMedida AS Unidad
FROM asign a
JOIN multi m ON m.Cod = a.Cod
LEFT JOIN EVERWEAR.dbo.[StkFer_Articulos]  s  ON LTRIM(RTRIM(s.CodArticulo)) = a.Cod
LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
GROUP BY a.Cod, a.Ubic, ap.Detalle, s.DetalleMedida, s.UnidadMedida
ORDER BY a.Cod, a.Ubic
"""


def fetch_articulos_multi_ubicacion():
    """Artículos con >1 ubicación asignada (rack). Agrupados: cod, nombre, lista."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_MULTI_UBIC)
        agg: dict = {}
        for cod, ubic, patron, medida, unidad in cur.fetchall():
            cod = _txt(cod)
            if cod not in agg:
                nombre = " ".join(" ".join(_txt(x) for x in (patron, medida, unidad)).split())
                agg[cod] = {"CodArticulo": cod, "Nombre": nombre, "Ubicaciones": []}
            agg[cod]["Ubicaciones"].append(_txt(ubic))
        rows = sorted(agg.values(), key=lambda r: -len(r["Ubicaciones"]))
        for r in rows:
            r["Cantidad"] = len(r["Ubicaciones"])
        return {"total": len(rows), "rows": rows}
    finally:
        conn.close()


# ── Contenedor por TAG (/deposito/contenedor) ──────────────────────────────
# Caso NACHO (2026-07-14): un contenedor activo puede no tener NINGUNA fila en
# KmovContenedor (nunca completó un movimiento con historial), así que buscar
# solo ahí lo deja invisible. Fuentes reales:
#   - Contenedor      -> maestro (TAG, estado, ubicación, vencimiento, desarme)
#   - ContenedorItem  -> contenido actual (artículo + cantidad)
#   - KmovContenedor  -> historial de movimientos (puede estar vacío)
# Kmov.KmovUsuarioGUID_Regist suele ser una cuenta generica del sistema
# ('User Anonymous', GUID 81cccf51-2228-45d0-9ab9-1bc33eacfb84 -> se repite en
# miles de movimientos de anios distintos). El operario real que ubico/movio el
# contenedor queda en KmovContenedor.KmovContenedorUsuarioGUID (y en
# KmovReng.KmovRengUsuarioGUID para el mismo renglon), que si mapea a un
# Personal real via PersonalUserGUID. Caso resuelto 2026-07-13: Kmov 1811457 /
# TAG AGUA_08 y AGUA_09 -> Carballo Agustin (login acarballo).
def fetch_contenedor(tag: str):
    tag = (tag or "").strip()
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute("""
            SELECT TOP 1
                   LTRIM(RTRIM(c.ContenedorTAG))         AS TAG,
                   c.ContenedorFechaRegist                AS Registracion,
                   c.ContenedorFechaVto                   AS Vencimiento,
                   c.ContenedorEstado                     AS Estado,
                   LTRIM(RTRIM(c.ContenedorUbicacionCod)) AS Ubicacion,
                   c.ContenedorUbicacionDep               AS Deposito,
                   c.ContenedorOrdenRecepcionNro          AS OrdenRecepcion,
                   c.ContenedorFechaDesarme                AS FechaDesarme,
                   LTRIM(RTRIM(desUser.PersonalNombre))   AS Desarmo,
                   c.ContenedorControlCalidad              AS ControlCalidad
            FROM Contenedor c
            LEFT JOIN Personal desUser ON LTRIM(RTRIM(desUser.PersonalUserGUID)) = LTRIM(RTRIM(c.ContenedorUsuarioGUIDDesarme))
            WHERE LTRIM(RTRIM(c.ContenedorTAG)) = LTRIM(RTRIM(?))
        """, (tag,))
        info_rows = _rows(cur)
        info = info_rows[0] if info_rows else None

        cur.execute("""
            SELECT LTRIM(RTRIM(i.ContenedorItemArticuloId)) AS Articulo,
                   i.ContenedorItemCantidad                  AS Cantidad
            FROM ContenedorItem i
            WHERE LTRIM(RTRIM(i.ContenedorTAG)) = LTRIM(RTRIM(?))
        """, (tag,))
        items = _rows(cur)

        cur.execute("""
            SELECT TOP 50
                   k.KmovId                                       AS KmovId,
                   k.KmovFechaHora                                 AS Momento,
                   LTRIM(RTRIM(k.KmovKcodmovCodigo))               AS Codigo,
                   k.KmovOrdenRecepcion                            AS NroRef,
                   k.KmovEstado                                    AS Estado,
                   LTRIM(RTRIM(c.KmovContenedorUbicacionCodigo))   AS Ubicacion,
                   c.KmovContenedorFechaHoraRegistr                AS MomentoContenedor,
                   LTRIM(RTRIM(regUser.PersonalNombre))            AS UsuarioRegistroNombre,
                   LTRIM(RTRIM(regUser.PersonalLoguin))            AS UsuarioRegistroLogin,
                   LTRIM(RTRIM(realUser.PersonalNombre))           AS UsuarioRealNombre,
                   LTRIM(RTRIM(realUser.PersonalLoguin))           AS UsuarioRealLogin,
                   LTRIM(RTRIM(r.KmovRengArticuloId))              AS Articulo,
                   r.KmovRengCantidad                              AS Cantidad
            FROM KmovContenedor c
            JOIN Kmov k               ON k.KmovId = c.KmovId
            LEFT JOIN Personal regUser  ON LTRIM(RTRIM(regUser.PersonalUserGUID))  = LTRIM(RTRIM(k.KmovUsuarioGUID_Regist))
            LEFT JOIN Personal realUser ON LTRIM(RTRIM(realUser.PersonalUserGUID)) = LTRIM(RTRIM(c.KmovContenedorUsuarioGUID))
            LEFT JOIN KmovReng r
                   ON r.KmovId = c.KmovId
                  AND LTRIM(RTRIM(r.KmovRengContenedorAsociado)) = LTRIM(RTRIM(c.KmovContenedorContenedorTAG))
            WHERE LTRIM(RTRIM(c.KmovContenedorContenedorTAG)) = LTRIM(RTRIM(?))
            ORDER BY k.KmovFechaHora DESC
        """, (tag,))
        historial = _rows(cur)
        for row in historial:
            row["UsuarioRegistroEsAnonimo"] = row.get("UsuarioRegistroNombre") == "User Anonymous"

        encontrado = info is not None or len(items) > 0 or len(historial) > 0
        return {
            "tag": tag,
            "encontrado": encontrado,
            "info": info,
            "items": items,
            "historial": historial,
        }
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════
# Tiempos de picking (tab "Tiempos de Picking" de /deposito)
# ═══════════════════════════════════════════════════════════════════════════
# Fuente: WMS.dbo.OTItem, que guarda PickIni/PickFin POR RENGLON. La hora del
# heatmap sale de PickFin del ITEM (no de la OT): es el momento real en que se
# levanto el articulo. Si el renglon no tiene tiempos (no paso por handheld:
# ~7% de los items, quedan en 1753-01-01, default de SQL Server) se cae a
# OTFechaHoraEjecucion de la cabecera, asi el conteo de items del heatmap cierra
# con el tab Picking.
#
# Los tiempos se parten en dos para que un outlier no ensucie el promedio:
# CRONOMETRADOS/SEG_TOTAL solo suman renglones de duracion <= PICK_SEG_MAX, y
# los que se pasan se cuentan aparte en LARGOS. Medicion sobre agosto 2026:
# 99,6% de los renglones cronometrados estan por debajo de 5 min y solo 52 de
# 15.496 pasan los 10 min (tipico: la pantalla quedo abierta entre pedidos).
# El promedio se calcula en el front como SEG_TOTAL / CRONOMETRADOS.
PICK_SEG_MAX = 600

# PersonalNombre es char(25) con padding: se devuelve con LTRIM(RTRIM) para que
# coincida con el nombre del selector de operario del header (que viene trimeado
# de parseDeposito). Sin el trim, elegir un operario dejaba el tab vacio.
#
# El operario NO se filtra en SQL: se devuelve el nombre y el front recorta con
# esFilaProductiva() de lib/deposito/parseDeposito.ts, que es donde vive la regla
# de gerentes/no-operativos. Una sola fuente de verdad para todas las pantallas.

# Grano: fecha x operario x hora. Un mes tipico da ~1.500 filas (30 dias x 8
# operarios x 10 horas utiles), asi que el front arma los tres ejes del heatmap
# (operario, dia de semana, dia del mes) sobre estas mismas filas, sin volver a
# consultar al cambiar de eje.
SQL_PICK_HEATMAP = f"""
SELECT
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 103)  AS [FECHA],
    LTRIM(RTRIM(P.PersonalNombre))                      AS [OPERARIO],
    DATEPART(HOUR, c.momento)                           AS [HORA],
    COUNT(*)                                            AS [ITEMS],
    SUM(CASE WHEN it.OTItemCantCumplida > 0 THEN 1 ELSE 0 END)          AS [RECOLECTADOS],
    SUM(CASE WHEN c.seg <= {PICK_SEG_MAX} THEN c.seg ELSE 0 END)        AS [SEG_TOTAL],
    SUM(CASE WHEN c.seg <= {PICK_SEG_MAX} THEN 1 ELSE 0 END)            AS [CRONOMETRADOS],
    SUM(CASE WHEN c.seg > {PICK_SEG_MAX} THEN 1 ELSE 0 END)             AS [LARGOS]
FROM OT
INNER JOIN Codot  ON OT.CodotCodigo = Codot.CodotCodigo AND Codot.CodotProcesoNegocio = 4
INNER JOIN OTItem it ON it.OTId = OT.OTId AND it.OTItemTipo = 1
LEFT  JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
CROSS APPLY (VALUES (
    CASE WHEN it.OTItemFechaHoraPickFin > '1900-01-01'
         THEN it.OTItemFechaHoraPickFin ELSE OT.OTFechaHoraEjecucion END,
    CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01'
          AND it.OTItemFechaHoraPickFin >= it.OTItemFechaHoraPickIni
         THEN DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) END
)) c(momento, seg)
WHERE OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
GROUP BY CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 103),
         P.PersonalNombre, DATEPART(HOUR, c.momento)
"""

# Cabeceras de OT con hora de inicio y fin reales. Los agregados de renglones van
# por CROSS APPLY correlacionado (seek por la PK de OTItem, una vez por OT) y no
# por un GROUP BY de toda OTItem, que obligaria a recorrer la tabla entera.
# INICIO/FIN salen de los renglones (MIN PickIni / MAX PickFin); si ninguno tiene
# tiempos se cae a los de la cabecera. SEG_SPAN es el reloj de punta a punta e
# incluye las esperas entre renglones; SEG_ITEMS es la suma de los renglones
# cronometrados. La diferencia entre los dos es el tiempo muerto de la OT.
SQL_PICK_OTS = f"""
SELECT
    OT.OTId                                              AS [OT],
    CONVERT(varchar(10), OT.OTFechaHoraEjecucion, 103)   AS [FECHA],
    LTRIM(RTRIM(P.PersonalNombre))                       AS [OPERARIO],
    CONVERT(varchar(8), COALESCE(i.ini, NULLIF(OT.OTFechaHoraPickIni, '1753-01-01')), 108) AS [INICIO],
    CONVERT(varchar(8), COALESCE(i.fin, NULLIF(OT.OTFechaHoraPickFin, '1753-01-01')), 108) AS [FIN],
    DATEDIFF(SECOND,
        COALESCE(i.ini, NULLIF(OT.OTFechaHoraPickIni, '1753-01-01')),
        COALESCE(i.fin, NULLIF(OT.OTFechaHoraPickFin, '1753-01-01')))  AS [SEG_SPAN],
    i.items                                              AS [ITEMS],
    i.recol                                              AS [RECOLECTADOS],
    i.seg_items                                          AS [SEG_ITEMS],
    i.cron                                               AS [CRONOMETRADOS],
    i.largos                                             AS [LARGOS],
    LTRIM(RTRIM(ISNULL(OT.OTClienteNombre, '')))         AS [CLIENTE],
    OT.{{col_pedido}}                                      AS [PEDIDO]
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo AND Codot.CodotProcesoNegocio = 4
LEFT  JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
CROSS APPLY (
    SELECT
        MIN(CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01' THEN it.OTItemFechaHoraPickIni END) AS ini,
        MAX(CASE WHEN it.OTItemFechaHoraPickFin > '1900-01-01' THEN it.OTItemFechaHoraPickFin END) AS fin,
        COUNT(*)                                                            AS items,
        SUM(CASE WHEN it.OTItemCantCumplida > 0 THEN 1 ELSE 0 END)          AS recol,
        SUM(CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01'
                  AND it.OTItemFechaHoraPickFin >= it.OTItemFechaHoraPickIni
                  AND DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) <= {PICK_SEG_MAX}
                 THEN DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) ELSE 0 END) AS seg_items,
        SUM(CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01'
                  AND it.OTItemFechaHoraPickFin >= it.OTItemFechaHoraPickIni
                  AND DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) <= {PICK_SEG_MAX}
                 THEN 1 ELSE 0 END)                                         AS cron,
        SUM(CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01'
                  AND DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) > {PICK_SEG_MAX}
                 THEN 1 ELSE 0 END)                                         AS largos
    FROM OTItem it
    WHERE it.OTId = OT.OTId AND it.OTItemTipo = 1
) i
WHERE OT.OTEstado IN (2, 3, 4)
  AND OT.OTFechaHoraEjecucion >= ?
  AND OT.OTFechaHoraEjecucion <= ?
  AND i.items > 0
ORDER BY OT.OTId DESC
"""

# Renglones de UNA OT (se pide al abrir la fila, no se traen todos de entrada).
# El nombre del articulo sale de WMS.dbo.Articulo, que es la copia local del
# maestro: evita cruzar bases contra EVERWEAR para un detalle de 10 renglones.
SQL_PICK_OT_ITEMS = """
SELECT
    it.OTItemNroRenglon                              AS [RENGLON],
    LTRIM(RTRIM(it.OTItemArticuloId))                AS [ARTICULO],
    LTRIM(RTRIM(ISNULL(a.ArticuloNombre, '')))       AS [DESCRIPCION],
    LTRIM(RTRIM(it.OTItemUbicacionCodigo))           AS [UBICACION],
    it.OTItemCantPedida                              AS [PEDIDA],
    it.OTItemCantCumplida                            AS [CUMPLIDA],
    CONVERT(varchar(8), NULLIF(it.OTItemFechaHoraPickIni, '1753-01-01'), 108) AS [INICIO],
    CONVERT(varchar(8), NULLIF(it.OTItemFechaHoraPickFin, '1753-01-01'), 108) AS [FIN],
    CASE WHEN it.OTItemFechaHoraPickIni > '1900-01-01'
          AND it.OTItemFechaHoraPickFin >= it.OTItemFechaHoraPickIni
         THEN DATEDIFF(SECOND, it.OTItemFechaHoraPickIni, it.OTItemFechaHoraPickFin) END AS [SEG]
FROM OTItem it
LEFT JOIN Articulo a ON a.ArticuloId = it.OTItemArticuloId
WHERE it.OTId = ? AND it.OTItemTipo = 1
ORDER BY it.OTItemNroRenglon
"""


def fetch_pick_heatmap(desde: datetime, hasta: datetime):
    """Pickeos por fecha x operario x hora (grano del heatmap de /deposito)."""
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute(SQL_PICK_HEATMAP, (desde, hasta))
        return _rows(cur)
    finally:
        conn.close()


def fetch_pick_ots(desde: datetime, hasta: datetime):
    """Una fila por OT de picking con hora de inicio, fin y tiempos."""
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute(SQL_PICK_OTS.format(col_pedido=OT_COL_PEDIDO), (desde, hasta))
        return _rows(cur)
    finally:
        conn.close()


def fetch_pick_ot_items(ot_id: int):
    """Renglones de una OT: articulo, ubicacion, hora de inicio/fin y segundos."""
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute(SQL_PICK_OT_ITEMS, (ot_id,))
        return _rows(cur)
    finally:
        conn.close()
