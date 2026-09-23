"""
Alta de OT de reposición (OT1R) DESDE FUERA del WMS.

Es el único módulo de esta API que ESCRIBE en la base del WMS. Todo el resto
del proyecto (incluido picking_disponible.py, de donde sale el cálculo) es sólo
lectura sobre Magnus/WMS.

Qué escribe el WMS cuando se da de alta una OT de reposición por pantalla
(relevado 2026-09-22 comparando OT que quedaron en estado 1 contra OT ya
ejecutadas — ver claude/wms_alta_ot_reposicion_por_sql.md):

    WMS.dbo.OT      1 fila (cabecera). OTId es IDENTITY, no hay talonario.
    WMS.dbo.OTItem  2 filas por artículo: OTItemTipo = 1 (recolección, desde la
                    ubicación de GUARDADO) y OTItemTipo = 2 (ubicación, hacia
                    la posición de PICKING).

Y nada más: no toca UbicacionDetalle (no reserva stock), no genera Kmov, no
escribe Vitacora ni OTContenedor, y no escribe en EVERWEAR. Todo eso pasa
recién cuando el repositor ejecuta la OT. Los únicos triggers de OTItem pasan
el texto a mayúsculas; no hay stored procedure de alta (la lógica vive en el
GeneXus de wp_ejecutarot_cont.aspx).

Dos trampas de la cabecera que el nombre de los campos esconde:

  - `OTUsuarioGUID_Repositor` NO es un GUID: es `Personal.PersonalId` en texto
    ('124', '276', '289'…). Es lo que hace que la OT le aparezca al operario.
    El GUID de verdad va en `OTUsuarioGUID_Regist` y sale de
    `Personal.PersonalUserGUID`.
  - Las fechas vacías son '1753-01-01' (default de SQL Server), no NULL.

Como nada reserva stock, el riesgo real no es el INSERT sino armar dos OT que
manden a buscar el mismo pallet: por eso el stock libre se RELEE dentro de la
misma transacción, descontando lo que otras OT de reposición vivas ya tienen
comprometido sobre esa ubicación (SQL_ORIGEN_COMPROMETIDO).
"""
import os
import re
from datetime import datetime

from db import get_connection
from deposito import WMS_ESTADOS_VIVOS, _es_operario_merca, _info_articulos, _txt
from picking_disponible import (
    CODOT_REPOSICION,
    DEPOSITO_CENTRAL,
    SQL_ORIGEN_COMPROMETIDO,
    SQL_ORIGENES,
    UBIC_NO_RACK,
    VENTANA_DIAS,
    _art,
    _chunked_query,
    _num,
    _r3,
    deposito_de,
    fetch_picking_disponible,
    pasillo_de,
    texto_observaciones,
)

# Fecha "vacía" del WMS. SQL Server la escribe sola en las columnas datetime
# NOT NULL sin valor; si se mandara NULL o 1900-01-01 las pantallas del WMS
# muestran basura en la columna de ejecución.
FECHA_NULA = "1753-01-01"

# Estado de la OT recién creada (pendiente de ejecutar). 2/3/4 = ejecutada.
OT_ESTADO_PENDIENTE = 1
OT_ITEM_PENDIENTE = 1

OTITEM_RECOLECTAR = 1   # origen: ubicación de guardado
OTITEM_UBICAR = 2       # destino: posición de picking

# Marca en OTObservaciones para poder separar después, en la base, las OT que
# nacieron acá de las que se cargaron por la pantalla del WMS.
MARCA = os.getenv("WMS_OT_MARCA", "VICKI")

# Los nombres de Personal vienen con asteriscos adelante en varios legajos
# ('****Sanchez Evelyn'): se limpian sólo para mostrar.
_RE_ASTER = re.compile(r"^[\*\s]+")

PERSONAL_ACTIVO = 1


class OTReposicionError(Exception):
    """Validación que impide crear la OT. El mensaje va tal cual al operario."""


# ── Operarios ────────────────────────────────────────────────────────────────
# Los que efectivamente repusieron, ordenados por uso: de los 51 de Personal,
# sólo 7 hicieron reposición en los últimos dos meses. Una lista de 51 nombres
# en un cartel de 560 px no se puede operar.
SQL_REPOSITORES = """
SELECT
    LTRIM(RTRIM(p.PersonalId))       AS pid,
    LTRIM(RTRIM(p.PersonalNombre))   AS nombre,
    COUNT(o.OTId)                    AS ots,
    MAX(o.OTFechaHoraRegist)         AS ultima
FROM Personal p
LEFT JOIN OT o
       ON o.OTUsuarioGUID_Repositor = p.PersonalId
      AND o.CodotCodigo = ?
      AND o.OTFechaHoraRegist >= ?
WHERE ISNULL(p.PersonalEstado, 0) = ?
GROUP BY p.PersonalId, p.PersonalNombre
"""


def _limpiar_nombre(nombre: str) -> str:
    return _RE_ASTER.sub("", _txt(nombre)) or _txt(nombre)


def fetch_repositores(dias: int = 90, todos: bool = False):
    """Operarios a los que se les puede asignar la OT.

    Por defecto sólo los que repusieron en los últimos `dias` (los que el
    repositor espera ver en la lista); `todos=1` trae los 51 activos, por si
    entra alguien nuevo. El orden es por uso: el que más repone, primero.
    """
    desde = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - _dias(dias)

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(
            SQL_REPOSITORES,
            [CODOT_REPOSICION, desde.strftime("%Y-%m-%d"), PERSONAL_ACTIVO],
        )
        filas = cur.fetchall()
    finally:
        conn.close()

    out = []
    for pid, nombre, ots, ultima in filas:
        n = int(ots or 0)
        if n <= 0 and not todos:
            continue
        # 'Mercaderia X Llegar' es un buzón, no una persona: aparece en el
        # ranking de reposición porque el WMS le cuelga las OT que esperan
        # mercadería, pero no se le puede asignar nada.
        if _es_operario_merca(nombre):
            continue
        out.append({
            "Id": _txt(pid),
            "Nombre": _limpiar_nombre(nombre),
            "OTs": n,
            "Ultima": ultima.isoformat(sep=" ", timespec="minutes") if ultima else None,
        })
    out.sort(key=lambda r: (-r["OTs"], r["Nombre"]))
    return {"operarios": out, "dias": dias, "todos": bool(todos)}


def _dias(n: int):
    from datetime import timedelta
    return timedelta(days=max(1, int(n or 1)))


# ── Candidatos de origen (lo que el operario elige en el cartel) ─────────────
def _candidatos(codigos: list[str]) -> dict[str, list[dict]]:
    """Por artículo, TODAS las ubicaciones de guardado con stock libre.

    A diferencia de `_elegir_origenes` de picking_disponible (que elige sola la
    mejor y parte el renglón), acá no se elige nada: la lista entera viaja al
    widget y la ubicación la toca el operario, que es el que sabe si el pallet
    está accesible. El orden sí es el mismo — mismo pasillo, después lo más
    viejo (FIFO), después lo que más cantidad tiene — así que la primera de la
    lista es la que el sistema hubiera elegido.
    """
    if not codigos:
        return {}
    vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)
    cand: dict[str, list[dict]] = {}
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        tomado: dict[tuple[str, str], float] = {}
        for art, ubic, cant in _chunked_query(
            cur, SQL_ORIGEN_COMPROMETIDO, codigos, vivos=vivos
        ):
            k = (_art(art), _txt(ubic))
            tomado[k] = tomado.get(k, 0.0) + _num(cant)
        for art, ubic, cant, desde in _chunked_query(cur, SQL_ORIGENES, codigos):
            art, ubic = _art(art), _txt(ubic)
            if ubic.upper() in UBIC_NO_RACK or deposito_de(ubic) != DEPOSITO_CENTRAL:
                continue
            libre = _num(cant) - tomado.get((art, ubic), 0.0)
            if libre <= 0:
                continue
            cand.setdefault(art, []).append({
                "ubic": ubic,
                "pasillo": pasillo_de(ubic),
                "libre": libre,
                "desde": desde,
                "comprometido": tomado.get((art, ubic), 0.0),
            })
    finally:
        conn.close()
    return cand


def fetch_armado(pasillo: str, dias: int = VENTANA_DIAS):
    """Lo que hay que reponer en un pasillo, cada artículo con su lista de
    ubicaciones para elegir y su posición de picking de destino.

    Es lo que el widget dibuja al apretar "armar OT": una fila por artículo con
    un botón que despliega las `Opciones`. `Sugerida` es el índice de la
    ubicación que el sistema hubiera elegido (la primera), para poder pre-marcar
    sin quitarle la decisión al operario.
    """
    pas = str(pasillo or "").strip().upper()
    vacio = {
        "pasillo": pas, "codigo": CODOT_REPOSICION, "deposito": DEPOSITO_CENTRAL,
        "articulos": [], "sinOrigen": [], "operarios": [], "observaciones": "",
    }
    if not pas:
        return vacio

    data = fetch_picking_disponible(dias=dias)
    grupo = next(
        (g for g in data.get("porPasillo", []) if str(g["Pasillo"]).upper() == pas),
        None,
    )
    filas = [r for r in (grupo or {}).get("rows", []) if (r.get("AReponer") or 0) > 0]
    if not filas:
        return {**vacio, "generado": data.get("generado")}

    cand = _candidatos(sorted({r["CodArticulo"] for r in filas}))

    articulos, sin_origen = [], []
    for r in filas:
        cod = r["CodArticulo"]
        falta = float(r.get("AReponer") or 0)
        opciones = []
        for c in sorted(
            cand.get(cod, []),
            key=lambda c: (
                0 if c["pasillo"] == pas else 1,
                str(c["desde"] or "9999"),
                -c["libre"],
            ),
        ):
            opciones.append({
                "Ubicacion": c["ubic"],
                "Pasillo": c["pasillo"],
                "Libre": _r3(c["libre"]),
                "Cantidad": _r3(min(falta, c["libre"])),   # lo que se cargaría
                "Cubre": c["libre"] >= falta - 0.001,
                "MismoPasillo": c["pasillo"] == pas,
                "Desde": c["desde"].isoformat(sep=" ", timespec="minutes")
                         if hasattr(c["desde"], "isoformat") else None,
            })
        if not opciones:
            sin_origen.append({"Articulo": cod, "Nombre": r.get("Nombre", ""),
                               "AReponer": _r3(falta)})
            continue
        articulos.append({
            "Articulo": cod,
            "Nombre": r.get("Nombre", ""),
            "AReponer": _r3(falta),
            "Hay": r.get("Hay"),
            "OTs": r.get("OTs"),
            "Operarios": r.get("Operarios") or [],
            "Situacion": r.get("Situacion"),
            "Destino": (r.get("Posiciones") or [None])[0],
            "Sugerida": 0,
            "Opciones": opciones,
        })

    # Armadores que esperan alguno de los artículos que SÍ tienen de dónde
    # sacarse: es el texto de Observaciones con el que nace la OT. Se manda
    # armado para que el widget no tenga que rehacerlo (y para que la pantalla
    # del WMS y el alta directa escriban exactamente lo mismo).
    operarios = sorted(
        {o for a in articulos for o in (a.get("Operarios") or [])}, key=str.lower
    )
    return {
        "generado": data.get("generado"),
        "pasillo": pas,
        "codigo": CODOT_REPOSICION,
        "deposito": DEPOSITO_CENTRAL,
        "articulos": articulos,
        "operarios": operarios,
        "observaciones": texto_observaciones(operarios),
        "sinOrigen": sin_origen,
    }


# ── Validaciones del alta ────────────────────────────────────────────────────
SQL_PERSONAL = """
SELECT LTRIM(RTRIM(PersonalId)), LTRIM(RTRIM(PersonalNombre)),
       LTRIM(RTRIM(ISNULL(PersonalUserGUID, ''))), ISNULL(PersonalEstado, 0)
FROM Personal WHERE LTRIM(RTRIM(PersonalId)) = ?
"""

# Las ubicaciones que tocan los renglones, con sus flags. El IN es de un puñado
# de códigos (los de una OT), no del universo.
SQL_UBICACIONES = """
SELECT LTRIM(RTRIM(u.UbicacionCodigo))          AS ubic,
       ISNULL(u.UbicacionEsGuardado, 0)         AS guardado,
       ISNULL(u.UbicacionEsAbastecedora, 0)     AS abastecedora,
       ISNULL(u.UbicacionEsPicking, 0)          AS picking,
       ISNULL(u.UbicacionEstado, 0)             AS estado
FROM Ubicacion u
WHERE LTRIM(RTRIM(u.UbicacionCodigo)) IN ({ph})
"""

# Stock de las ubicaciones de origen elegidas, releído en la transacción del
# alta: entre que el operario abrió el cartel y apretó Guardar pudo pasar un
# picking o el alta de otra OT.
SQL_STOCK_ORIGEN = """
SELECT LTRIM(RTRIM(d.UbicacionDetalleArticuloId)) AS art,
       LTRIM(RTRIM(d.UbicacionCodigo))            AS ubic,
       SUM(d.UbicacionDetalleCantidad)            AS cant,
       MIN(d.UbicacionDetalleFecPrimIngAubi)      AS desde
FROM UbicacionDetalle d
WHERE LTRIM(RTRIM(d.UbicacionDetalleArticuloId)) IN ({ph_art})
  AND LTRIM(RTRIM(d.UbicacionCodigo)) IN ({ph_ubi})
GROUP BY d.UbicacionDetalleArticuloId, d.UbicacionCodigo
"""

# Lo que otras OT de reposición vivas ya se comprometieron a sacar de esas
# ubicaciones (mismo criterio que SQL_ORIGEN_COMPROMETIDO, acotado a las
# ubicaciones de esta OT).
SQL_COMPROMETIDO_UBI = """
SELECT LTRIM(RTRIM(i.OTItemArticuloId))      AS art,
       LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS ubic,
       SUM(i.OTItemCantPedida - i.OTItemCantCumplida) AS tomado
FROM OT
INNER JOIN Codot    ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio = 1
  AND OT.OTEstado IN ({vivos})
  AND i.OTItemTipo = 1
  AND i.OTItemCantCumplida < i.OTItemCantPedida
  AND LTRIM(RTRIM(i.OTItemArticuloId)) IN ({ph_art})
  AND LTRIM(RTRIM(i.OTItemUbicacionCodigo)) IN ({ph_ubi})
GROUP BY i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""

# Reposición viva YA pedida hacia el mismo destino: evita que dos personas
# armen la misma OT con minutos de diferencia (el caso que más duele, porque la
# segunda manda al repositor a un estante que ya se va a llenar).
SQL_REPO_VIVA_DESTINO = """
SELECT LTRIM(RTRIM(i.OTItemArticuloId))      AS art,
       LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS ubic,
       SUM(i.OTItemCantPedida - i.OTItemCantCumplida) AS pendiente
FROM OT
INNER JOIN Codot    ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio = 1
  AND OT.OTEstado IN ({vivos})
  AND i.OTItemTipo = 2
  AND i.OTItemCantCumplida < i.OTItemCantPedida
  AND LTRIM(RTRIM(i.OTItemArticuloId)) IN ({ph_art})
  AND LTRIM(RTRIM(i.OTItemUbicacionCodigo)) IN ({ph_ubi})
GROUP BY i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""

SQL_INSERT_OT = """
INSERT INTO OT (
    OTFechaHoraRegist, OTLastRenglon, OTEstado,
    OTEgresoKmovId, OTIngresoKmovId, CodotCodigo,
    OTUsuarioGUID_Regist, OTUsuarioGUID_Repositor, OTUsuarioGUID_Ejecucion,
    OTFechaHoraEjecucion, OTObservaciones, OTCantTiempoPick,
    OTFechaHoraPickIni, OTFechaHoraPickFin, OTDeviceIdPick,
    OTPrioridadPedido, OTClienteNombre, OTClienteId,
    OTNroca, OTNrocp, OTNromovventa, OTNromovventaRemito, OTPedidoId
) VALUES (
    GETDATE(), ?, ?,
    0, 0, ?,
    ?, ?, '',
    ?, ?, ?,
    ?, ?, '',
    0, '', '',
    0, 0, 0, 0, ''
)
"""

SQL_INSERT_ITEM = """
INSERT INTO OTItem (
    OTId, OTItemNroRenglon, OTItemCantPedida, OTItemCantCumplida,
    OTItemEstado, OTItemUbicacionCodigo, OTItemUbicacionDepositoId,
    OTItemArticuloId, OTItemTipo, OTItemFec,
    OTItemFechaHoraPickFin, OTItemFechaHoraPickIni,
    OTItemContenedorAsoc, OTItemFechaHoraRegistracion,
    OTItemNroRef, OTItemObservaciones
) VALUES (
    ?, ?, ?, 0,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?,
    '', GETDATE(),
    0, ''
)
"""


def _normalizar_lineas(lineas) -> list[dict]:
    """Valida la forma del payload antes de tocar la base."""
    if not lineas:
        raise OTReposicionError("No hay renglones para cargar.")
    out = []
    for i, l in enumerate(lineas, 1):
        art = _art((l or {}).get("articulo"))
        origen = _txt((l or {}).get("origen")).upper()
        destino = _txt((l or {}).get("destino")).upper()
        try:
            cant = float((l or {}).get("cantidad") or 0)
        except (TypeError, ValueError):
            cant = 0.0
        if not art:
            raise OTReposicionError(f"Renglón {i}: falta el artículo.")
        if not origen:
            raise OTReposicionError(f"Renglón {i} ({art}): falta la ubicación de origen.")
        if not destino:
            raise OTReposicionError(f"Renglón {i} ({art}): falta la posición de destino.")
        if cant <= 0:
            raise OTReposicionError(f"Renglón {i} ({art}): la cantidad tiene que ser mayor que 0.")
        if origen == destino:
            raise OTReposicionError(f"Renglón {i} ({art}): el origen y el destino son la misma ubicación.")
        out.append({"articulo": art, "origen": origen, "destino": destino,
                    "cantidad": _r3(cant)})
    # Un mismo (artículo, origen) dos veces en la misma OT duplicaría el retiro
    # sin que ninguna validación de stock lo note (cada una pasa por separado).
    vistos = set()
    for l in out:
        k = (l["articulo"], l["origen"])
        if k in vistos:
            raise OTReposicionError(
                f"{l['articulo']} aparece dos veces desde {l['origen']}."
            )
        vistos.add(k)
    if len(out) > 99:
        # OTLastRenglon es smallint y el WMS numera 1..N sobre el total de
        # renglones (tipo 1 + tipo 2): 99 artículos ya son 198 renglones.
        raise OTReposicionError("Demasiados artículos para una sola OT (máximo 99).")
    return out


def _validar_contra_base(cur, lineas: list[dict], forzar: bool) -> dict:
    """Todo lo que el WMS valida en la pantalla y por SQL no valida nadie.

    Devuelve {(art, origen): fecha_fifo} para poder completar OTItemFec igual
    que lo hace el WMS (la fecha del stock de origen, copiada al destino).
    """
    arts = sorted({l["articulo"] for l in lineas})
    ubis = sorted({l["origen"] for l in lineas} | {l["destino"] for l in lineas})
    ph_art = ",".join("?" for _ in arts)
    ph_ubi = ",".join("?" for _ in ubis)

    # 1. Las ubicaciones existen, están activas y son del tipo que corresponde.
    cur.execute(SQL_UBICACIONES.format(ph=ph_ubi), ubis)
    info_ubi = {
        _txt(u).upper(): {"guardado": int(g or 0), "abastecedora": int(a or 0),
                          "picking": int(p or 0), "estado": int(e or 0)}
        for u, g, a, p, e in cur.fetchall()
    }
    for l in lineas:
        o = info_ubi.get(l["origen"])
        if not o:
            raise OTReposicionError(f"La ubicación de origen {l['origen']} no existe.")
        if o["estado"] != 1:
            raise OTReposicionError(f"La ubicación de origen {l['origen']} está inactiva.")
        if not (o["guardado"] or o["abastecedora"]):
            raise OTReposicionError(
                f"{l['origen']} no es una ubicación de guardado: no se puede recolectar de ahí."
            )
        if l["origen"].upper() in UBIC_NO_RACK:
            raise OTReposicionError(f"{l['origen']} no es un rack, no se repone desde ahí.")
        if deposito_de(l["origen"]) != DEPOSITO_CENTRAL:
            raise OTReposicionError(f"{l['origen']} no es del depósito central.")

        d = info_ubi.get(l["destino"])
        if not d:
            raise OTReposicionError(f"La posición de destino {l['destino']} no existe.")
        if d["estado"] != 1:
            raise OTReposicionError(f"La posición de destino {l['destino']} está inactiva.")
        if not d["picking"]:
            raise OTReposicionError(f"{l['destino']} no es una posición de picking.")

    # 2. El stock alcanza AHORA, descontando lo que otras OT vivas se llevan.
    cur.execute(SQL_STOCK_ORIGEN.format(ph_art=ph_art, ph_ubi=ph_ubi), arts + ubis)
    stock, fifo = {}, {}
    for art, ubic, cant, desde in cur.fetchall():
        k = (_art(art), _txt(ubic).upper())
        stock[k] = _num(cant)
        fifo[k] = desde

    vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)
    cur.execute(
        SQL_COMPROMETIDO_UBI.format(vivos=vivos, ph_art=ph_art, ph_ubi=ph_ubi),
        arts + ubis,
    )
    tomado = {(_art(a), _txt(u).upper()): _num(t) for a, u, t in cur.fetchall()}

    for l in lineas:
        k = (l["articulo"], l["origen"])
        libre = stock.get(k, 0.0) - tomado.get(k, 0.0)
        if libre < l["cantidad"] - 0.001:
            raise OTReposicionError(
                "%s: en %s quedan %s disponibles (se pidieron %s). "
                "Se movió el stock mientras armabas la OT — volvé a abrir el pasillo."
                % (l["articulo"], l["origen"], _fmt(libre), _fmt(l["cantidad"]))
            )

    # 3. No duplicar una reposición que ya está viva hacia el mismo estante.
    if not forzar:
        cur.execute(
            SQL_REPO_VIVA_DESTINO.format(vivos=vivos, ph_art=ph_art, ph_ubi=ph_ubi),
            arts + ubis,
        )
        ya = {(_art(a), _txt(u).upper()): _num(p) for a, u, p in cur.fetchall()}
        for l in lineas:
            p = ya.get((l["articulo"], l["destino"]), 0.0)
            if p > 0:
                raise OTReposicionError(
                    "%s ya tiene una reposición viva hacia %s por %s u. "
                    "Si igual querés mandar otra, usá «Forzar» en el menú."
                    % (l["articulo"], l["destino"], _fmt(p))
                )

    return fifo


def _fmt(v: float) -> str:
    f = float(v or 0)
    return str(int(round(f))) if abs(f - round(f)) < 0.005 else ("%.2f" % f)


_RE_FECHA = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _fecha_fifo(valor) -> str:
    """OTItemFec: la fecha (sin hora) del stock de origen, igual que la carga la
    pantalla del WMS. Sin dato, hoy.

    El driver devuelve datetime, pero se acepta también el texto por si alguna
    vez viene como string (y para poder probarlo sin base)."""
    if hasattr(valor, "strftime"):
        return valor.strftime("%Y-%m-%d")
    m = _RE_FECHA.match(str(valor or ""))
    if m:
        return m.group(1)
    return datetime.now().strftime("%Y-%m-%d")


def crear_ot(
    pasillo: str,
    operario: str,
    lineas,
    observaciones: str = "",
    simular: bool = False,
    forzar: bool = False,
):
    """Da de alta la OT de reposición y devuelve su número.

    Con `simular=True` corre TODAS las validaciones y devuelve los renglones tal
    como se insertarían, sin escribir nada. Es el modo con el que conviene
    estrenar esto: si el plan coincide con lo que carga la pantalla del WMS,
    recién ahí se apaga.

    Los renglones se numeran corridos 1..N: primero todos los tipo 1 (orígenes)
    y después todos los tipo 2 (destinos), que es el orden con el que los deja
    la pantalla del WMS.
    """
    pas = str(pasillo or "").strip().upper()
    ops = _normalizar_lineas(lineas)
    pid = _txt(operario)
    if not pid:
        raise OTReposicionError("Falta elegir el operario que va a reponer.")

    conn = get_connection("WMS", aislamiento="READ COMMITTED")
    try:
        cur = conn.cursor()

        cur.execute(SQL_PERSONAL, [pid])
        fila = cur.fetchone()
        if not fila:
            raise OTReposicionError(f"El operario {pid} no existe en el WMS.")
        _, nombre, guid, estado = fila
        if int(estado or 0) != PERSONAL_ACTIVO:
            raise OTReposicionError(f"{_limpiar_nombre(nombre)} está dado de baja en el WMS.")
        guid = _txt(guid)
        if not guid:
            raise OTReposicionError(
                f"{_limpiar_nombre(nombre)} no tiene usuario del WMS asociado "
                "(Personal.PersonalUserGUID vacío)."
            )

        fifo = _validar_contra_base(cur, ops, forzar)

        renglones = []
        nro = 0
        for l in ops:
            nro += 1
            renglones.append({
                "Renglon": nro, "Tipo": OTITEM_RECOLECTAR, "Articulo": l["articulo"],
                "Ubicacion": l["origen"], "Cantidad": l["cantidad"],
                "Fec": _fecha_fifo(fifo.get((l["articulo"], l["origen"]))),
            })
        for l in ops:
            nro += 1
            renglones.append({
                "Renglon": nro, "Tipo": OTITEM_UBICAR, "Articulo": l["articulo"],
                "Ubicacion": l["destino"], "Cantidad": l["cantidad"],
                "Fec": _fecha_fifo(fifo.get((l["articulo"], l["origen"]))),
            })

        # La marca va SIEMPRE adelante: es lo único que permite separar después,
        # en la base, las OT que nacieron acá de las cargadas por pantalla. Lo
        # que venga en `observaciones` va DEBAJO y no pegado con espacios: es la
        # lista "* para <armador>" (una por línea), que así se lee igual en el
        # textarea del WMS y en la columna.
        cabecera = " ".join(
            p for p in (MARCA, ("pasillo %s" % pas) if pas else "") if p
        )
        extra = _txt(observaciones)
        obs = ("%s\n%s" % (cabecera, extra) if extra else cabecera)[:1000]

        plan = {
            "simulado": bool(simular),
            "pasillo": pas,
            "codigo": CODOT_REPOSICION,
            "operario": {"Id": pid, "Nombre": _limpiar_nombre(nombre), "Guid": guid},
            "observaciones": obs,
            "articulos": len(ops),
            "unidades": _r3(sum(l["cantidad"] for l in ops)),
            "renglones": renglones,
        }

        if simular:
            plan["OTId"] = None
            plan["mensaje"] = "Simulación: no se escribió nada en el WMS."
            return plan

        cur.execute(SQL_INSERT_OT, [
            len(renglones), OT_ESTADO_PENDIENTE, CODOT_REPOSICION,
            guid, pid, FECHA_NULA, obs, FECHA_NULA, FECHA_NULA, FECHA_NULA,
        ])
        cur.execute("SELECT CAST(SCOPE_IDENTITY() AS int)")
        ot_id = cur.fetchone()[0]
        if not ot_id:
            raise OTReposicionError("El WMS no devolvió el número de OT; no se creó nada.")

        for r in renglones:
            cur.execute(SQL_INSERT_ITEM, [
                ot_id, r["Renglon"], r["Cantidad"],
                OT_ITEM_PENDIENTE, r["Ubicacion"], str(DEPOSITO_CENTRAL),
                r["Articulo"], r["Tipo"], r["Fec"],
                FECHA_NULA, FECHA_NULA,
            ])
        conn.commit()

        plan["OTId"] = int(ot_id)
        plan["mensaje"] = "OT %d creada para %s." % (ot_id, _limpiar_nombre(nombre))
        return plan
    except OTReposicionError:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()
