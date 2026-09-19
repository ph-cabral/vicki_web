"""
Registro de Errores — Mesa de Control (widget de escritorio). Insert en
Postgres (schema `deposito`, tabla `errores_mesa`; ver
ever/sql/deposito_errores_mesa.sql). El lookup por Nro Pedido es SOLO LECTURA:

  · Fecha + Tipo Pedido  ← EVERWEAR.dbo.VenFer_PedidoCabecera + MAGNUS_SITD.
    "Tipo Pedido" = nombre del comprobante (Ven_CodComprobante.DetalleCorto
    por CompCodigo, NO el código numérico) — mismo join que Comprobante_Desc
    en main.py/SQL_QUERY. Ajustado 2026-07-15: antes era
    el origen de venta (Web/Móvil/Acopio, Vta/Ped_OrigenRegistracion).
  · OT + N° Armador/Nombre ← WMS OT + Personal, mismo patrón que
    deposito.py (OT_COL_PEDIDO, P_Repositor / OTUsuarioGUID_Repositor).
  · Ubicación ← campo "Observaciones" de la pantalla de OT en WMS (confirmado
    con captura de pantalla: ahí anotan cosas como "Est 2 10" / "01-16-10-I").
    La columna real de OT se detecta sola por nombre (LIKE '%OBSERV%', ver
    _col_observaciones_ot) — mismo patrón "candidatos" que ya usa deposito.py
    (OT_candidatos_pedido) para no hardcodear un nombre sin confirmar.

REDISEÑO 2026-07-15: se sacó el select de Mesa/Reclamos.
Ahora, al abrir el widget se pide un N° de operario (el controlador que está
parado en la mesa) y se resuelve su NOMBRE contra WMS.Personal — mismo origen
que "nombreArmador" (fetch_operario_nombre abajo) — UNA sola vez por sesión
del widget. Ese nombre va en la columna que antes era "aviso", ahora
"controlador". El widget ya no manda un texto de mesa: manda `nroOperario`
y el server resuelve el nombre (no confía en lo que mande el cliente).
"Detalle Error" sigue siendo un select manual — ver DETALLE_ERROR_OPCIONES.

CAMBIO 2026-07-21: la vista /deposito separa "Registrada"
(quién cargó el error) de "Controlador" (el controlador real del pedido,
Magnus Ven_PedImpresoCP.CodControlador1/2, vía fetch_controlador_pedido).
Este dato SOLO se resuelve para origen='calidad' (ver insert_error_calidad) —
ver "3ra vuelta, REVERTIDA" abajo para por qué Mesa de Control no lo usa.

CAMBIO 2026-07-21, 2da vuelta: la columna `controlador`
en sí dejó de guardar a quien carga el registro — eso ahora va en
`registradoPor` para los 2 orígenes (antes era así solo en Calidad). Los
registros insertados ANTES de este cambio quedan con el registrante en
`controlador` y `registradoPor` NULL — no rompen nada porque el dato sigue
ahí; el fallback para mostrarlos vive en getRegistrador (erroresMesa.tsx).

CAMBIO 2026-07-21, 3ra vuelta, REVERTIDA: se había hecho
que `insert_error_mesa` TAMBIÉN resolviera el Controlador real (Magnus) igual
que Calidad, guardándolo en `controlador` (duplicado de nombreControladorReal).
Se revirtió: para Mesa de Control, quien carga el widget YA ES el controlador
parado en la mesa (ver REDISEÑO 2026-07-15 arriba) — resolver el "Controlador
real" por separado es redundante y en la práctica puede traer un controlador
DISTINTO del que cargó (Magnus con un control previo del mismo pedido),
mostrando 2 nombres distintos para lo mismo y confundiendo. Ver docstring de
insert_error_mesa para el caso real que disparó la reversión. Calidad sigue
resolviendo y bloqueando por Controlador real (ahí sí aporta, porque quien
carga Calidad NO es el controlador del pedido) — ver
indicadores-api/backfill_controlador_real.py para el backfill de esa columna
en filas viejas (que sigue vigente, no afectado por esta reversión) y
ever/sql/deposito_errores_mesa_revertir_controlador_mesa.sql para limpiar
las filas de Mesa de Control que quedaron con este dato de más durante la
3ra vuelta.
"""
from datetime import date, timedelta

import pyodbc

from db import get_connection
from db_pg import get_pg_connection
from deposito import OT_COL_PEDIDO

BASE_DATE = date(1800, 12, 28)

# ── Opciones fijas de los selects ─────────────────────────────────────────────
# Lista de arranque — AJUSTAR/COMPLETAR a gusto (sin tocar el widget).
DETALLE_ERROR_OPCIONES = [
    "Error en cantidad",
    "Error en producto",
    "Error en cantidad y producto",
    "Pedido incompleto",
    "Producto no conforme",
    "Producto sin identificación",
]

# Lista PROPIA de Calidad (REDISEÑO 2026-08-20): antes el
# widget de Calidad usaba esta MISMA lista que Mesa de Control (vía
# DETALLE_ERROR_OPCIONES/opciones() arriba) — no había forma de tener errores
# distintos para cada origen. Ahora Calidad tiene la suya, servida por
# opciones_calidad() (endpoint separado, ver GET
# /deposito/errores-mesa/calidad/opciones en main.py) y usada por
# widgets/errores-calidad-widget/errores_calidad.py. Igual que la de arriba:
# agregar/sacar ítems acá, sin tocar el widget.
DETALLE_ERROR_OPCIONES_CALIDAD = [
    "Producto no conforme",
    "Faltantes",
    "Error en cantidad y producto",
    "Error en cantidad",
    "Error en producto",
    "Sin identificación",
    "Error en embalaje",
]

# ── Lookup (solo lectura) ─────────────────────────────────────────────────────
# "TipoPedido" = nombre del comprobante (ej. "Factura A"), no el código
# numérico — mismo join (CompCodigo -> Ven_CodComprobante.DetalleCorto) que
# Comprobante_Desc en main.py/SQL_QUERY.
# `Cliente`/`CodCliente` agregados 2026-08-20 (el widget
# de Calidad muestra el nombre del cliente en vez de "Pedido N" arriba) —
# mismo join (CodCliente -> MAGNUS_SITD.dbo.Clientes.Cliente_Nombre) que ya
# usa SQL_MAGNUS_ABIERTOS_TODOS en control_asignacion.py.
SQL_PEDIDO_FECHA_TIPO = """
SELECT
    p.FechaPedido,
    cc.DetalleCorto AS TipoPedido,
    cli.Cliente_Nombre AS Cliente,
    p.CodCliente AS CodCliente
FROM EVERWEAR.dbo.VenFer_PedidoCabecera p
LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante cc ON p.CompCodigo = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Clientes cli ON p.CodCliente = cli.CodCliente
WHERE p.NroMovVenta = ?
"""

# Columna real de OT con la "Observaciones" (ubicación) — se detecta una sola
# vez por proceso (ver _col_observaciones_ot) y se cachea acá.
_ot_observ_col_cache: dict = {"col": None, "resolved": False}


def _col_observaciones_ot(conn) -> str | None:
    """Nombre real de la columna de OT que trae 'Observaciones' (ubicación
    tipo 'Est 2 10' / '01-16-10-I', ver captura de pantalla). Detección por
    nombre (LIKE '%OBSERV%'), no hardcodeada — mismo patrón que
    OT_candidatos_pedido en deposito.py. Cacheado en memoria del proceso."""
    if _ot_observ_col_cache["resolved"]:
        return _ot_observ_col_cache["col"]
    cur = conn.cursor()
    cur.execute(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_NAME = 'OT' AND COLUMN_NAME LIKE '%OBSERV%' "
        "ORDER BY COLUMN_NAME"
    )
    row = cur.fetchone()
    _ot_observ_col_cache["col"] = row[0] if row else None
    _ot_observ_col_cache["resolved"] = True
    return _ot_observ_col_cache["col"]


SQL_PEDIDO_OT_ARMADOR_BASE = f"""
SELECT TOP 1
    OT.OTId,
    OT.OTFechaHoraEjecucion    AS FechaArmado,
    P_Repositor.PersonalId     AS NroArmador,
    P_Repositor.PersonalNombre AS NombreArmador{{observ_select}}
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
WHERE Codot.CodotProcesoNegocio = 4          -- Picking
  AND OT.{OT_COL_PEDIDO} = ?
ORDER BY OT.OTFechaHoraEjecucion DESC
"""


def fetch_pedido_lookup(nro_pedido: int) -> dict | None:
    """Fecha + Tipo Pedido (Magnus) + OT + N° Armador/Nombre + Ubicación (WMS),
    por Nro Pedido (NroMovVenta). None si el pedido no existe en Magnus.

    CAMBIO 2026-08-14: el pedido en Magnus tiene varias
    fechas vinculadas, no solo la de registración — se agregan al lookup
    (todas opcionales, `None` si esa etapa todavía no pasó):
      · `fecha`         — FechaPedido (registración), como ya estaba.
      · `fechaArmado`   — OT.OTFechaHoraEjecucion (WMS), la misma OT de
        Picking que ya resuelve `ot`/`nroArmador`/`nombreArmador` — no es
        una consulta nueva, se agrega al SELECT que ya se hacía
        (SQL_PEDIDO_OT_ARMADOR_BASE).
      · `fechaControl`  — Magnus Ven_PedImpresoCP.FechaControl, mismo
        criterio (tabla/filtro/orden) que usa `fetch_controlador_pedido`
        para el controlador real (más reciente CON CodControlador1/2 > 0),
        PERO con su propia query (`fetch_fecha_control_pedido`) en vez de
        reusar esa función — ver docstring de esa función para el por qué
        (dbo.FECHA_Cla2SQL puede reventar con datos viejos/corruptos, y no
        queremos que eso afecte la resolución del controlador real que sí
        bloquea el alta de Calidad)."""
    conn = get_connection()  # default EVERWEAR
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_PEDIDO_FECHA_TIPO, (nro_pedido,))
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None
    fecha_int, tipo_pedido, cliente, cod_cliente = row
    fecha = (BASE_DATE + timedelta(days=int(fecha_int))).isoformat() if fecha_int else None

    ot, fecha_armado, nro_armador, nombre_armador, ubicacion = (None, None, None, None, None)
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        observ_col = _col_observaciones_ot(conn)
        observ_select = f", OT.{observ_col} AS Ubicacion" if observ_col else ""
        cur.execute(SQL_PEDIDO_OT_ARMADOR_BASE.format(observ_select=observ_select), (nro_pedido,))
        cols = [c[0] for c in cur.description]
        ot_row = cur.fetchone()
        if ot_row:
            d = dict(zip(cols, ot_row))
            ot = d.get("OTId")
            fecha_armado = d.get("FechaArmado")
            nro_armador = d.get("NroArmador")
            nombre_armador = (d.get("NombreArmador") or "").strip() or None
            ubicacion = d.get("Ubicacion")
            if ubicacion is not None:
                ubicacion = str(ubicacion).strip() or None
    finally:
        conn.close()

    # Fecha de control (Mesa de Control), mismo criterio que el controlador
    # real — ver docstring arriba. None si el pedido todavía no paso control
    # (o si el unico candidato tiene un FechaControl corrupto, ver docstring
    # de fetch_fecha_control_pedido).
    fecha_control = fetch_fecha_control_pedido(nro_pedido)

    return {
        "nroPedido": nro_pedido,
        "fecha": fecha,
        "fechaArmado": fecha_armado.isoformat() if fecha_armado is not None else None,
        "fechaControl": fecha_control.isoformat() if fecha_control is not None else None,
        "tipoPedido": (tipo_pedido or "").strip() or None,
        "cliente": (cliente or "").strip() or None,
        "codCliente": int(cod_cliente) if cod_cliente is not None else None,
        "ot": int(ot) if ot is not None else None,
        "nroArmador": int(nro_armador) if nro_armador is not None else None,
        "nombreArmador": nombre_armador,
        "ubicacion": ubicacion,
    }


# ── Artículos del pedido (para el selector multiple-choice de los widgets) ────
# (2026-07-21): en vez de tipear el pedido a mano, ambos
# widgets (Mesa de Control y Calidad) deben poder elegir 1 o más artículos
# ENTRE LOS QUE ESTÁN EN ESE PEDIDO, para asociarlos al error cargado.
# Fuente: renglones de la MISMA OT de Picking que ya resuelve
# fetch_pedido_lookup (WMS OTItem, OTItemTipo=1 "Recolectar" — mismo filtro
# que SQL_OT_DIFERENCIAS en deposito.py), no Magnus directo: refleja lo que
# el preparador efectivamente tuvo que recolectar para este pedido. Nombre
# del artículo (Patron + Medida + Unidad) vía StkFer_Articulos/StkFer_ArtParamet,
# mismo patrón CONFIRMADO que ya usa deposito.py (fetch_ot_diferencias, sección
# "sql_nombres"). Sin verificar en vivo (no hay acceso a Magnus/WMS desde acá).
SQL_OT_ITEMS = """
SELECT
    i.OTItemNroRenglon                    AS Renglon,
    LTRIM(RTRIM(i.OTItemArticuloId))      AS CodArticulo,
    i.OTItemCantPedida                    AS CantPedida,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS Ubicacion
FROM OTItem i
WHERE i.OTId = ?
  AND i.OTItemTipo = 1          -- Recolectar (mismo filtro que SQL_OT_DIFERENCIAS)
ORDER BY i.OTItemNroRenglon
"""


def fetch_articulos_pedido(nro_pedido: int) -> list[dict]:
    """Artículos de la OT de Picking del pedido — para poblar el selector
    multiple-choice de los widgets. [] (no error) si el pedido no tiene OT
    de Picking todavía (ej. no llegó a WMS) — los widgets no deben bloquear
    el alta por esto, es un dato adicional, no obligatorio."""
    info = fetch_pedido_lookup(nro_pedido)
    ot = info.get("ot") if info else None
    if not ot:
        return []

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_OT_ITEMS, (ot,))
        cols = [c[0] for c in cur.description]
        items = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    codigos = sorted({(it.get("CodArticulo") or "").strip() for it in items if it.get("CodArticulo")})
    nombres: dict[str, str] = {}
    if codigos:
        conn_ew = get_connection("EVERWEAR")
        try:
            cur_ew = conn_ew.cursor()
            cur_ew.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            ph = ",".join("?" for _ in codigos)
            cur_ew.execute(
                f"""
                SELECT LTRIM(RTRIM(s.CodArticulo)) AS Cod,
                       ap.Detalle      AS Patron,
                       s.DetalleMedida AS Medida,
                       s.UnidadMedida  AS Unidad
                FROM EVERWEAR.dbo.[StkFer_Articulos]  s
                LEFT JOIN EVERWEAR.dbo.[StkFer_ArtParamet] ap ON ap.ArticuloPatron = s.ArticuloPatron
                WHERE s.CodArticulo IN ({ph})
                """,
                codigos,
            )
            for cod, patron, medida, unidad in cur_ew.fetchall():
                nombre = " ".join(" ".join(str(x or "").strip() for x in (patron, medida, unidad)).split())
                nombres[(cod or "").strip()] = nombre
        finally:
            conn_ew.close()

    out = []
    vistos = set()
    for it in items:
        cod = (it.get("CodArticulo") or "").strip()
        if not cod or cod in vistos:
            continue
        vistos.add(cod)
        out.append({
            "codArticulo": cod,
            "descripcion": nombres.get(cod) or cod,
            "ubicacion": it.get("Ubicacion"),
            "cantidadPedida": it.get("CantPedida"),
        })
    return out


# def fetch_operario_nombre(nro_operario: int) -> str | None:
#     """Nombre del operario/controlador por N° de Personal (WMS.Personal.
#     PersonalId) — mismo origen que nombreArmador arriba. Se resuelve UNA vez
#     al abrir el widget (pantalla de N° Operario), no por pedido. None si no
#     existe."""
#     conn = get_connection("WMS")
#     try:
#         cur = conn.cursor()
#         cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
#         cur.execute(
#             "SELECT PersonalNombre FROM Personal WHERE PersonalId = ?",
#             (str(nro_operario),),
#         )
#         row = cur.fetchone()
#     finally:
#         conn.close()
#     if not row:
#         return None
#     nombre = (row[0] or "").strip()
#     return nombre or None

def fetch_operario_nombre(nro_operario: int) -> str | None:
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(
            "SELECT PersonalNombre FROM Personal WHERE PersonalId = ?",
            (str(nro_operario),),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if row:
        nombre = (row[0] or "").strip()
        if nombre:
            return nombre

    # fallback: usuarios de Magnus (controladores/mesa), no siempre están en WMS.Personal
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute("SELECT Nombre FROM dbo.Gen_Usuarios WHERE Numero = ?", (nro_operario,))
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return None
    nombre = (row[0] or "").strip()
    return nombre or None


def _normalizar_articulos(articulos: list[str] | None) -> list[str] | None:
    """Limpia la lista de artículos elegidos en el selector multiple-choice
    del widget (trim, descarta vacíos, sin duplicados, preserva el orden de
    selección). None si queda vacía — Postgres guarda NULL, no un array
    vacío; es un dato opcional, no bloquea el alta en ningún widget."""
    if not articulos:
        return None
    vistos: set[str] = set()
    out: list[str] = []
    for a in articulos:
        a = (a or "").strip()
        if a and a not in vistos:
            vistos.add(a)
            out.append(a)
    return out or None


def fetch_ubicacion_diag(nro_pedido: int | None = None) -> dict:
    """Diagnóstico: qué columna de OT se detectó para 'Observaciones'/ubicación
    y, si se pasa nro_pedido, el valor real que trae para ese pedido. Para
    confirmar contra la pantalla de OT en WMS (ver captura de pantalla)."""
    conn = get_connection("WMS")
    try:
        col = _col_observaciones_ot(conn)
    finally:
        conn.close()
    out = {"columna_detectada": col}
    if nro_pedido is not None:
        out["lookup"] = fetch_pedido_lookup(nro_pedido)
    return out


# Re-resuelve y valida los códigos de artículo que mandó el widget contra
# fetch_articulos_pedido (mismo criterio "no confiar en el cliente" que el
# resto del archivo): descarta códigos que no estén en el pedido, arma el
# string final "código - descripción" del lado del server. Compartido por
# insert_error_mesa e insert_error_calidad.
def _resolver_articulos(nro_pedido: int, codigos: list[str] | None) -> list[str] | None:
    codigos = _normalizar_articulos(codigos)
    if not codigos:
        return None
    disponibles = {a["codArticulo"]: a["descripcion"] for a in fetch_articulos_pedido(nro_pedido)}
    out = [f"{c} - {disponibles[c]}" for c in codigos if c in disponibles]
    return out or None


# ── Insert (Postgres) ─────────────────────────────────────────────────────────
def insert_error_mesa(
    nro_pedido: int, nro_operario: int, detalle_error: str, articulos: list[str] | None = None
) -> dict:
    """Re-resuelve fecha/tipo/OT/armador del pedido + nombre de quien carga
    (por nro_operario, WMS.Personal) del lado del server (no confía en lo que
    mande el cliente) e inserta 1 fila en deposito.errores_mesa.

    `articulos` (opcional, 2026-07-21): códigos de
    artículo elegidos en el selector multiple-choice del widget (ver
    fetch_articulos_pedido) — se re-validan acá contra el pedido (mismo
    criterio de no confiar en el cliente que el resto del archivo) y se
    guardan ya formateados como "código - descripción". No bloquea el alta
    si viene vacío/ausente, ni si algún código no matchea (se descarta
    silenciosamente).

    CAMBIO 2026-07-21 (2da vuelta): `controlador` dejó de
    guardar a quien carga el registro — ese dato ahora va en `registradoPor`,
    mismo criterio que ya usaba `insert_error_calidad`.

    CAMBIO 2026-07-21, 3ra vuelta, REVERTIDA: se había
    resuelto acá también el "Controlador real" (Magnus, fetch_controlador_pedido)
    igual que en Calidad — pero para Mesa de Control eso es redundante y
    confuso: quien carga ESTE widget YA ES el controlador que está parado en
    la mesa (ver REDISEÑO 2026-07-15 arriba), así que "Registrada" y
    "Controlador real" deberían coincidir siempre; en la práctica no coinciden
    (Magnus puede tener un control previo/distinto para el mismo pedido,
    ej. caso real: Registrada=Pablo Cabral, Controlador real=Mollina Facundo
    para el mismo pedido) y confunde más de lo que aclara. Se sacó la
    resolución: `controlador`, "nroControladorReal", "nombreControladorReal"
    quedan NULL para este origen — la columna "Controlador" de la vista
    /deposito debe mostrar "—" para Mesa de Control. Esto SOLO aplica a
    insert_error_mesa; insert_error_calidad sigue resolviendo y bloqueando
    por Controlador real (ahí sí tiene sentido: quien carga Calidad NO es el
    controlador del pedido)."""
    detalle_error = (detalle_error or "").strip()
    if not nro_operario:
        raise ValueError("Falta 'nroOperario'")
    if not detalle_error:
        raise ValueError("Falta 'detalleError'")

    registrado_por = fetch_operario_nombre(nro_operario)
    if not registrado_por:
        raise ValueError(f"Operario {nro_operario} no encontrado")

    info = fetch_pedido_lookup(nro_pedido) or {
        "fecha": None, "tipoPedido": None, "ot": None,
        "nroArmador": None, "nombreArmador": None, "ubicacion": None,
    }
    articulos_resueltos = _resolver_articulos(nro_pedido, articulos)

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO deposito.errores_mesa
                ("nroPedido", fecha, "tipoPedido", ot, "nroArmador", "nombreArmador",
                 ubicacion, "detalleError", "registradoPor", articulos)
            VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, "createdAt"
            """,
            (
                nro_pedido, info["tipoPedido"], info["ot"],
                info["nroArmador"], info["nombreArmador"], info["ubicacion"], detalle_error,
                registrado_por, articulos_resueltos,
            ),
        )
        new_id, created_at = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {
        **info,
        "id": new_id,
        "controlador": None,
        "detalleError": detalle_error,
        "registradoPor": registrado_por,
        "articulos": articulos_resueltos,
        "nroControladorReal": None,
        "nombreControladorReal": None,
        "createdAt": created_at.isoformat(),
    }


# ── Alta en lote, 1 fila por artículo (REDISEÑO 2026-08-04) ─
# Antes el widget de Mesa de Control cargaba 1 solo detalleError para TODO el
# pedido (con `articulos` como simple etiqueta/lista adjunta, ver
# insert_error_mesa arriba). Ahora cada artículo puede tener SU PROPIO error:
# el widget arma la lista {codArticulo, detalleError} eligiendo el error
# artículo por artículo y la manda entera al presionar "Finalizar". Se guarda
# 1 fila de deposito.errores_mesa POR ARTÍCULO (mismo esquema de tabla que ya
# existía — `articulos` ya era text[], acá cada fila lleva un array de 1 solo
# elemento — no hace falta migración). A diferencia de llamar a
# insert_error_mesa en loop desde el widget (que repetiría fetch_operario_nombre
# + fetch_pedido_lookup + fetch_articulos_pedido en CADA request), acá se
# resuelven una sola vez y se insertan todas las filas en una sola conexión/
# transacción.
def insert_error_mesa_items(
    nro_pedido: int, nro_operario: int, items: list[dict]
) -> dict:
    """`items`: [{"codArticulo": "...", "detalleError": "..."}, ...] — ya
    validado por Pydantic (ErrorMesaItemsIn) en main.py, acá se re-limpia y
    se descartan silenciosamente los que vengan sin código o sin error (mismo
    criterio "no confiar en el cliente" del resto del archivo). Devuelve un
    resumen (cantidad + detalle de cada fila insertada) para que el widget
    pueda loguear/mostrar el resultado."""
    if not nro_operario:
        raise ValueError("Falta 'nroOperario'")
    if not items:
        raise ValueError("Falta 'items' (al menos 1 artículo con error)")

    registrado_por = fetch_operario_nombre(nro_operario)
    if not registrado_por:
        raise ValueError(f"Operario {nro_operario} no encontrado")

    info = fetch_pedido_lookup(nro_pedido) or {
        "fecha": None, "tipoPedido": None, "ot": None,
        "nroArmador": None, "nombreArmador": None, "ubicacion": None,
    }
    disponibles = {a["codArticulo"]: a["descripcion"] for a in fetch_articulos_pedido(nro_pedido)}

    filas: list[tuple[str, list[str]]] = []
    for it in items:
        cod = (it.get("codArticulo") or "").strip()
        detalle_error = (it.get("detalleError") or "").strip()
        if not cod or not detalle_error:
            continue
        desc = disponibles.get(cod)
        articulo_str = f"{cod} - {desc}" if desc else cod
        filas.append((detalle_error, [articulo_str]))

    if not filas:
        raise ValueError("Ningún artículo válido con error para guardar")

    conn = get_pg_connection()
    resultados = []
    try:
        cur = conn.cursor()
        for detalle_error, articulos_resueltos in filas:
            cur.execute(
                """
                INSERT INTO deposito.errores_mesa
                    ("nroPedido", fecha, "tipoPedido", ot, "nroArmador", "nombreArmador",
                     ubicacion, "detalleError", "registradoPor", articulos)
                VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, "createdAt"
                """,
                (
                    nro_pedido, info["tipoPedido"], info["ot"],
                    info["nroArmador"], info["nombreArmador"], info["ubicacion"], detalle_error,
                    registrado_por, articulos_resueltos,
                ),
            )
            new_id, created_at = cur.fetchone()
            resultados.append({
                "id": new_id, "detalleError": detalle_error,
                "articulos": articulos_resueltos, "createdAt": created_at.isoformat(),
            })
        conn.commit()
    finally:
        conn.close()

    return {
        **info,
        "nroPedido": nro_pedido,
        "registradoPor": registrado_por,
        "cantidad": len(resultados),
        "items": resultados,
    }


# ── Widget Calidad (controla preparado + control) ─────────────────────────────
# A diferencia del widget de Mesa de Control (arriba), acá el controlador NO
# se tipea (no hay pantalla de N° Operario): se resuelve solo por Nro Pedido
# contra Magnus (Ven_PedImpresoCP.CodControlador1/2, mismo origen que
# mesa_control.py — cod1==cod2 confirmado ahí). (2026-07-16):
# esta alta NO guarda preparador (nroArmador/nombreArmador quedan NULL).
SQL_CONTROLADOR_PEDIDO = """
SELECT TOP 1 CodControlador1, CodControlador2
FROM dbo.Ven_PedImpresoCP
WHERE NroMovVenta = ?
  AND (CodControlador1 > 0 OR CodControlador2 > 0)
ORDER BY FechaControl DESC
"""


def fetch_controlador_pedido(nro_pedido: int) -> dict | None:
    """Controlador real del pedido (Magnus, atado a NroMovVenta). None si el
    pedido no tiene control registrado.

    FIX 2026-07-21 (bug reportado: pedido con control confirmado en
    Magnus igual daba "sin controlador registrado"): Ven_PedImpresoCP puede
    tener MÁS DE UNA fila por NroMovVenta (recontrol/reimpresión — mismo caso
    ya confirmado y filtrado en mesa_control.py, ver SQL_RENGLONES_CONTROLADOS
    y fetch_mesa_control_recontroles_diag). Sin el filtro `(CodControlador1 > 0
    OR CodControlador2 > 0)`, un `TOP 1 ORDER BY FechaControl DESC` puede traer
    una fila de recontrol/reimpresión con los 2 códigos en 0 (control todavía
    no asignado en esa fila puntual) en vez de la fila anterior que sí tiene
    el controlador real — sobre todo si ambas filas comparten la misma fecha
    (FechaControl es date, no datetime, no desempata entre filas del mismo
    día). Con el filtro, se ignoran las filas sin controlador y se toma la
    más reciente ENTRE LAS QUE SÍ lo tienen."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_CONTROLADOR_PEDIDO, (nro_pedido,))
        row = cur.fetchone()
        if not row:
            return None
        cod1, cod2 = row
        codigo = int(cod1) if cod1 and cod1 > 0 else (int(cod2) if cod2 and cod2 > 0 else None)
        if not codigo:
            return None
        cur.execute("SELECT Nombre FROM dbo.Gen_Usuarios WHERE Numero = ?", (codigo,))
        nrow = cur.fetchone()
        nombre = (nrow[0] or "").strip() if nrow else None
        return {"nroControlador": codigo, "nombreControlador": nombre or f"Controlador {codigo}"}
    finally:
        conn.close()


# Fecha de control, en query APARTE de fetch_controlador_pedido (a proposito
# — ver CAMBIO 2026-08-14 abajo).
SQL_FECHA_CONTROL_PEDIDO = """
SELECT TOP 1 dbo.FECHA_Cla2SQL(FechaControl) AS FechaControl
FROM dbo.Ven_PedImpresoCP
WHERE NroMovVenta = ?
  AND (CodControlador1 > 0 OR CodControlador2 > 0)
  AND FechaControl BETWEEN 1 AND 200000
ORDER BY FechaControl DESC
"""


def fetch_fecha_control_pedido(nro_pedido: int):
    """Fecha del control real (Mesa de Control), mismo criterio de fila que
    fetch_controlador_pedido (mas reciente CON CodControlador1/2 > 0) — para
    `fechaControl` en fetch_pedido_lookup. `datetime.date` o `None`.

    CAMBIO 2026-08-14 (encontrado corriendo en bulk sobre
    36 pedidos de acopio): dbo.FECHA_Cla2SQL(FechaControl) revienta (SQL
    error 242, varchar->datetime fuera de rango) si el INT de FechaControl
    no es un dia valido — pasa para datos viejos/corruptos en alguna fila
    puntual de Ven_PedImpresoCP. Se probo un CASE adentro del SELECT primero
    (no evito el error) y despues mover el filtro de rango al WHERE (`?
    BETWEEN 1 AND 200000`, tampoco lo evito de forma confiable en la misma
    sesion de pruebas) — asi que el `BETWEEN` queda igual (no esta de mas) PERO
    ademas todo el bloque esta en try/except: si dbo.FECHA_Cla2SQL revienta
    igual para este pedido puntual, se devuelve None (fecha desconocida) en
    vez de que fetch_pedido_lookup completo tire 503 en el widget por un dato
    de fecha corrupto que no tiene nada que ver con el resto del lookup.

    Query SEPARADA de SQL_CONTROLADOR_PEDIDO (no comparten funcion) a
    proposito: ese filtro de rango, si estuviera en la query que resuelve el
    CONTROLADOR REAL (la que usa insert_error_calidad para bloquear el alta),
    podria hacer que un pedido con controlador legitimo pero FechaControl
    corrupta deje de resolver controlador — cambiando esa logica de bloqueo
    por un problema que es solo del dato de fecha. Con la query separada,
    fetch_controlador_pedido queda exactamente como estaba antes de este
    cambio."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        try:
            cur.execute(SQL_FECHA_CONTROL_PEDIDO, (nro_pedido,))
            row = cur.fetchone()
        except pyodbc.Error:
            return None
        return row[0] if row else None
    finally:
        conn.close()


SQL_CONTROLADOR_PEDIDO_DIAG = """
SELECT CodControlador1, CodControlador2, CodCentroPrep, FechaControl
FROM dbo.Ven_PedImpresoCP
WHERE NroMovVenta = ?
ORDER BY FechaControl DESC
"""


def fetch_controlador_diag(nro_pedido: int) -> dict:
    """Diagnóstico: TODAS las filas de Ven_PedImpresoCP para este pedido, SIN
    el filtro de fetch_controlador_pedido (para confirmar/descartar el caso
    de recontrol con códigos en 0, o directamente que no haya ninguna fila —
    dos causas distintas de "sin controlador registrado" en insert_error_calidad).
    Devuelve también lo que resuelve fetch_controlador_pedido() con el filtro
    actual, para comparar. Usar cuando un pedido con control confirmado en
    Magnus igual da error en el widget de Calidad."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_CONTROLADOR_PEDIDO_DIAG, (nro_pedido,))
        cols = [c[0] for c in cur.description]
        filas = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()
    return {
        "nroPedido": nro_pedido,
        "filas_Ven_PedImpresoCP": filas,
        "resuelto_por_fetch_controlador_pedido": fetch_controlador_pedido(nro_pedido),
    }


def insert_error_calidad(
    nro_pedido: int,
    nro_operario: int,
    detalle_error: str,
    observacion: str | None = None,
    articulos: list[str] | None = None,
) -> dict:
    """Alta desde el widget de Calidad. `nro_operario` identifica a QUIEN CARGA
    el registro (pantalla de inicio del widget, igual que Mesa de Control) —
    se resuelve del lado del server (WMS.Personal, mismo origen que
    fetch_operario_nombre) y va en `registradoPor`, separado de `controlador`
    (que acá sale solo de Magnus, no lo tipea nadie). origen='calidad'.

    CAMBIO 2026-07-21: esta alta ahora SÍ guarda el
    preparador (nroArmador/nombreArmador, mismo lookup WMS que usa
    insert_error_mesa — antes se descartaba a propósito, ver docstring vieja
    "Tampoco guarda preparador"). Es el mismo dato que la vista /deposito
    muestra como "Operario" para Mesa de Control; unifica el criterio entre
    los 2 orígenes (ver getOperario en erroresMesa.tsx). También acepta
    `observacion` opcional (antes solo se podía cargar desde la vista web,
    ver update_observacion) y `articulos` opcional (códigos elegidos en el
    selector multiple-choice del widget, re-validados acá contra el pedido —
    ver _resolver_articulos) para que el widget los mande directo al alta."""
    detalle_error = (detalle_error or "").strip()
    observacion = (observacion or "").strip() or None
    if not nro_operario:
        raise ValueError("Falta 'nroOperario'")
    if not detalle_error:
        raise ValueError("Falta 'detalleError'")

    registrado_por = fetch_operario_nombre(nro_operario)
    if not registrado_por:
        raise ValueError(f"Operario {nro_operario} no encontrado")

    ctrl = fetch_controlador_pedido(nro_pedido)
    if not ctrl:
        raise ValueError(f"Pedido {nro_pedido} sin controlador registrado en Magnus")

    info = fetch_pedido_lookup(nro_pedido) or {
        "tipoPedido": None, "ot": None, "nroArmador": None, "nombreArmador": None, "ubicacion": None,
    }
    articulos_resueltos = _resolver_articulos(nro_pedido, articulos)

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO deposito.errores_mesa
                ("nroPedido", fecha, "tipoPedido", ot, controlador, "nroArmador", "nombreArmador",
                 ubicacion, "detalleError", origen, "registradoPor",
                 "nroControladorReal", "nombreControladorReal", observacion, articulos)
            VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, 'calidad', %s, %s, %s, %s, %s)
            RETURNING id, "createdAt"
            """,
            (
                nro_pedido, info["tipoPedido"], info["ot"], ctrl["nombreControlador"],
                info.get("nroArmador"), info.get("nombreArmador"),
                info["ubicacion"], detalle_error, registrado_por,
                ctrl["nroControlador"], ctrl["nombreControlador"], observacion, articulos_resueltos,
            ),
        )
        new_id, created_at = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {
        "id": new_id, "nroPedido": nro_pedido, "tipoPedido": info["tipoPedido"],
        "ot": info["ot"], "ubicacion": info["ubicacion"], "controlador": ctrl["nombreControlador"],
        "nroArmador": info.get("nroArmador"), "nombreArmador": info.get("nombreArmador"),
        "detalleError": detalle_error, "origen": "calidad", "registradoPor": registrado_por,
        "nroControladorReal": ctrl["nroControlador"], "nombreControladorReal": ctrl["nombreControlador"],
        "observacion": observacion, "articulos": articulos_resueltos,
        "createdAt": created_at.isoformat(),
    }


# ── Alta en lote, 1 fila por artículo — Calidad (REDISEÑO 2026-08-20, a
# "que tenga la misma opción de seleccionar ítems [que Mesa],
# limitado a lista de 10, y que al hacer click se despliegen los errores").
# Mismo patrón que insert_error_mesa_items (REDISEÑO 2026-08-04) pero para
# Calidad: cada artículo puede tener SU PROPIO error (self.articulos_errores
# = {codArticulo: detalleError} en el widget) en vez de 1 solo detalleError
# para todo el pedido (insert_error_calidad, arriba, sigue viva para el
# endpoint viejo — no se tocó). Mantiene el mismo bloqueo por Controlador
# real que insert_error_calidad (fetch_controlador_pedido): si el pedido no
# tiene control registrado en Magnus, no se guarda nada.
#
# CAMBIO 2026-08-20, 2da vuelta ("eliminar el input de
# Observaciones [único, para todo el pedido] y que aparezca un input para
# rellenar por ítem luego de seleccionar el error"): `observacion` dejó de
# ser un parámetro compartido para TODO el lote — ahora viaje DENTRO de cada
# ítem (`items: [{"codArticulo", "detalleError", "observacion"}, ...]`), una
# nota distinta por artículo, tipeada en el widget justo después de elegir
# el error de ESE artículo (ver open_detalle_popup en errores_calidad.py).
# Cada fila de deposito.errores_mesa (ya era 1 por artículo) guarda SU PROPIA
# observación en vez de repetir la misma para todo el pedido.
def insert_error_calidad_items(
    nro_pedido: int, nro_operario: int, items: list[dict]
) -> dict:
    """`items`: [{"codArticulo": "...", "detalleError": "...", "observacion":
    "..."}, ...] — ya validado por Pydantic (ErrorCalidadItemsIn) en main.py,
    acá se re-limpia y se descartan silenciosamente los que vengan sin código
    o sin error (mismo criterio "no confiar en el cliente" del resto del
    archivo). `observacion` es opcional por ítem (nota libre para ESE
    artículo, puede venir vacía/ausente)."""
    if not nro_operario:
        raise ValueError("Falta 'nroOperario'")
    if not items:
        raise ValueError("Falta 'items' (al menos 1 artículo con error)")

    registrado_por = fetch_operario_nombre(nro_operario)
    if not registrado_por:
        raise ValueError(f"Operario {nro_operario} no encontrado")

    ctrl = fetch_controlador_pedido(nro_pedido)
    if not ctrl:
        raise ValueError(f"Pedido {nro_pedido} sin controlador registrado en Magnus")

    info = fetch_pedido_lookup(nro_pedido) or {
        "tipoPedido": None, "ot": None, "nroArmador": None, "nombreArmador": None, "ubicacion": None,
    }
    disponibles = {a["codArticulo"]: a["descripcion"] for a in fetch_articulos_pedido(nro_pedido)}

    filas: list[tuple[str, str | None, list[str]]] = []
    for it in items:
        cod = (it.get("codArticulo") or "").strip()
        detalle_error = (it.get("detalleError") or "").strip()
        if not cod or not detalle_error:
            continue
        observacion_item = (it.get("observacion") or "").strip() or None
        desc = disponibles.get(cod)
        articulo_str = f"{cod} - {desc}" if desc else cod
        filas.append((detalle_error, observacion_item, [articulo_str]))

    if not filas:
        raise ValueError("Ningún artículo válido con error para guardar")

    conn = get_pg_connection()
    resultados = []
    try:
        cur = conn.cursor()
        for detalle_error, observacion_item, articulos_resueltos in filas:
            cur.execute(
                """
                INSERT INTO deposito.errores_mesa
                    ("nroPedido", fecha, "tipoPedido", ot, controlador, "nroArmador", "nombreArmador",
                     ubicacion, "detalleError", origen, "registradoPor",
                     "nroControladorReal", "nombreControladorReal", observacion, articulos)
                VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, 'calidad', %s, %s, %s, %s, %s)
                RETURNING id, "createdAt"
                """,
                (
                    nro_pedido, info["tipoPedido"], info["ot"], ctrl["nombreControlador"],
                    info.get("nroArmador"), info.get("nombreArmador"),
                    info["ubicacion"], detalle_error, registrado_por,
                    ctrl["nroControlador"], ctrl["nombreControlador"], observacion_item, articulos_resueltos,
                ),
            )
            new_id, created_at = cur.fetchone()
            resultados.append({
                "id": new_id, "detalleError": detalle_error, "observacion": observacion_item,
                "articulos": articulos_resueltos, "createdAt": created_at.isoformat(),
            })
        conn.commit()
    finally:
        conn.close()

    return {
        **info,
        "nroPedido": nro_pedido,
        "controlador": ctrl["nombreControlador"],
        "registradoPor": registrado_por,
        "nroControladorReal": ctrl["nroControlador"],
        "nombreControladorReal": ctrl["nombreControlador"],
        "cantidad": len(resultados),
        "items": resultados,
    }


def opciones() -> dict:
    return {"detalleError": DETALLE_ERROR_OPCIONES}


def opciones_calidad() -> dict:
    return {"detalleError": DETALLE_ERROR_OPCIONES_CALIDAD}


def fetch_errores_mesa_list(
    desde: str | None = None, hasta: str | None = None, limit: int = 1000
) -> list[dict]:
    """Lista de deposito.errores_mesa para la vista /deposito (tab "Errores de
    Mesa"). Filtro opcional por rango de fecha (columna `fecha`, resuelta del
    lado del server al insertar). Controlador/Preparador se filtran del lado
    del cliente con selects poblados a partir de lo ya traído — mismo patrón
    que el filtro de Operario en app/deposito/page.tsx."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        where = []
        params: list = []
        if desde:
            where.append("fecha >= %s")
            params.append(desde)
        if hasta:
            where.append("fecha <= %s")
            params.append(hasta)
        sql = (
            'SELECT id, "nroPedido", fecha, "tipoPedido", ot, controlador, '
            '"nombreArmador", ubicacion, "detalleError", origen, "registradoPor", '
            '"nroControladorReal", "nombreControladorReal", '
            'observacion, articulos, "createdAt" '
            "FROM deposito.errores_mesa"
        )
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += ' ORDER BY fecha DESC NULLS LAST, "createdAt" DESC LIMIT %s'
        params.append(limit)
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    for r in rows:
        if r.get("fecha") is not None:
            r["fecha"] = r["fecha"].isoformat()
        if r.get("createdAt") is not None:
            r["createdAt"] = r["createdAt"].isoformat()
    return rows


def update_observacion(error_id: int, observacion: str) -> dict:
    """Nota libre editable desde la vista web /deposito (columna al final de
    la tabla), no desde el widget de escritorio. Reemplaza el valor completo
    (no append)."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE deposito.errores_mesa SET observacion = %s WHERE id = %s RETURNING id",
            (observacion, error_id),
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise ValueError(f"Registro {error_id} no encontrado")
    return {"id": error_id, "observacion": observacion}
