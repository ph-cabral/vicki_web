"""
/deposito/picking-disponible — lo que REALMENTE hay para tomar en la POSICIÓN
de picking de cada renglón de las OT que ya están en manos de un armador.

Por qué hace falta (y en qué se diferencia de /deposito/reposicion-ot):

- Magnus resta `StkReal` cuando se REGISTRA el pedido, pero el físico del
  estante no baja hasta que el armador pickea. Entre medio, dos o tres OT
  pueden estar apuntadas a la MISMA posición con stock para una sola.
- `/deposito/reposicion-ot` compara la demanda viva contra el stock del
  DEPÓSITO ENTERO (Stk_ArticSucursalDeposito, depósito 1). Sólo detecta el
  faltante real de la empresa. Acá se compara contra la CANTIDAD DE ESA
  POSICIÓN (WMS.dbo.UbicacionDetalle), que es lo que el armador va a
  encontrar cuando llegue al estante: un artículo puede tener 300.000 u en
  guardado y cero en el estante.

El dato lo resuelve el propio WMS: al pasar el pedido a depósito crea la OT de
picking (Codot.CodotProcesoNegocio = 4) en estado Pendiente y ya deja, por
renglón, de qué posición hay que tomar (OTItem.OTItemUbicacionCodigo) y cuánto
(OTItemCantPedida). O sea que se puede avisar ANTES de que el armador arranque.

Cuenta por renglón:

    disponible = cantidad de (artículo, posición) en UbicacionDetalle
                 − lo que las OT ANTERIORES en la cola ya tienen comprometido
                   sobre esa misma posición (reparto FIFO por fecha de la OT)
    pedido     = OTItemCantPedida − OTItemCantCumplida
    a reponer  = max(0, pedido − disponible)

El reparto es FIFO y no "cada OT contra el total": con 80 en el estante y dos OT
pidiendo 60 y 50, la primera se lleva las 60 y sólo la segunda queda corta. Si se
marcaran las dos, el faltante se contaría dos veces (60 cuando en realidad faltan
30). Lo mismo con el stock de guardado y con la reposición en camino, que también
son un pozo compartido.

`UbicacionDetalleCantidad` YA está neto de lo pickeado (cuando el armador toma,
la cantidad sale de la posición). Lo que no está descontado, y es todo el
aporte de este módulo, es lo que las otras OT abiertas tienen comprometido
contra el mismo estante.

El "a reponer" se abre en tres situaciones, porque el WMS YA genera OT de
reposición solo (CodotProcesoNegocio = 1; en la reposición OTItemTipo = 1 es la
recolección desde la abastecedora y OTItemTipo = 2 el depósito en la posición
de picking):

    repo_pedida → ya hay OT de reposición viva hacia esa posición por >= el faltante
    reponer     → no hay OT de repo, pero hay stock en guardado/abastecedora
    faltante    → no alcanza ni sumando guardado: no está en el depósito

Gotchas (medidos 2026-09-21, ver claude/picking_disponible_al_asignar_armador.md):

- OT zombi: de 37 OT en estado 1, 9 eran de meses anteriores (una de 2025). Sin
  el filtro de VENTANA_DIAS inflan la demanda comprometida y generan alarmas
  falsas.
- PLAYA_PEDIDOS está marcada UbicacionEsPicking = 1 pero no es un estante (es
  acopio ya preparado): se marca `EsPlaya` y nunca se le ofrece reposición.
- 3,6 % de los renglones cierran con CantCumplida > CantPedida (artículos que
  se toman por bolsa/paquete entero). No rompe el cálculo.
- Una OT puede repetir (artículo, posición) en varios renglones: se agrupa
  antes de comparar contra el stock.
- Todo el cálculo vive DENTRO de la base WMS (sin cruce con EVERWEAR), así que
  no aplica el gotcha de collation. El nombre del artículo se resuelve aparte
  con _info_articulos (segunda conexión, se junta en Python).
"""
from datetime import datetime, timedelta

from db import get_connection
from deposito import (
    OT_COL_PEDIDO,
    PATRONES_CANCELADO,
    WMS_ESTADOS_VIVOS,
    WMS_ESTADO_LABELS,
    _es_operario_merca,
    _info_articulos,
    _info_pedidos_resumen,
    _int,
    _safe,
    _txt,
)

# Ventana de antigüedad de la OT (OTFechaHoraRegist). Fuera de esto es backlog
# muerto: OT que nadie va a tomar y que sólo ensucian la demanda comprometida.
VENTANA_DIAS = 7

# Ubicación que el WMS marca como picking pero no es un estante (acopio ya
# preparado). No admite reposición.
PLAYA = "PLAYA_PEDIDOS"

# OJO: varias ubicaciones ESPECIALES traen EsGuardado/EsAbastecedora en 1 y no
# son stock que se pueda bajar al estante (relevado 2026-09-21 sobre
# WMS.dbo.Ubicacion). Si se las suma a "en guardado", un artículo que sólo
# tiene material a granel sin embolsar aparece como "hay para reponer" cuando
# en realidad no se puede reponer hasta fraccionarlo.
#   PULMON_INGRESO     EsAbastecedora=1 — mercadería a granel SIN ingresar
#                      (ver deposito_embolsado.md: no es stock de la empresa).
#                      Va a su propio contador.
#   PULMON_EGRESO      EsAbastecedora=1 — salida, no repone.
#   SALON_RECEPCION / NO_CONFORME / DEVOLUCION_CLIENTE / UBICACION_FICTICIA
#                      EsGuardado=1 — no son racks.
# Los CARRO*/CAJ*/MHE* tienen los tres flags en 0, así que quedan afuera solos.
PULMON = "PULMON_INGRESO"
UBIC_NO_RACK: frozenset[str] = frozenset({
    "PULMON_INGRESO", "PULMON_EGRESO", "SALON_RECEPCION", "NO_CONFORME",
    "DEVOLUCION_CLIENTE", "UBICACION_FICTICIA", "PARA_BORRAR", PLAYA,
})

SIN_ARMADOR = "— Sin asignar"

_CH = 1000  # tope de parámetros por IN (mismo criterio que _info_articulos)


SQL_DEMANDA = """
SELECT
    OT.OTId,
    OT.{col_pedido}                           AS NroMovVenta,
    OT.OTEstado,
    OT.OTFechaHoraRegist,
    OT.OTClienteNombre,
    P.PersonalNombre                          AS Armador,
    LTRIM(RTRIM(i.OTItemArticuloId))          AS CodArticulo,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo))     AS Posicion,
    SUM(i.OTItemCantPedida - i.OTItemCantCumplida) AS Pendiente
FROM OT
INNER JOIN Codot    ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
LEFT  JOIN Personal P ON P.PersonalId = OT.OTUsuarioGUID_Repositor
WHERE Codot.CodotProcesoNegocio = 4              -- Picking
  AND OT.OTEstado IN ({vivos})                   -- Pendiente (0/1) o En proceso (5)
  AND OT.OTFechaHoraRegist >= ?
  AND i.OTItemTipo = 1                           -- Recolectar
  AND i.OTItemCantCumplida < i.OTItemCantPedida
GROUP BY OT.OTId, OT.{col_pedido}, OT.OTEstado, OT.OTFechaHoraRegist,
         OT.OTClienteNombre, P.PersonalNombre,
         i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""

SQL_STOCK_UBIC = """
SELECT
    LTRIM(RTRIM(d.UbicacionDetalleArticuloId)) AS art,
    LTRIM(RTRIM(d.UbicacionCodigo))            AS ubic,
    SUM(d.UbicacionDetalleCantidad)            AS cant,
    MAX(CASE WHEN ISNULL(u.UbicacionEsPicking, 0) = 1 THEN 1 ELSE 0 END) AS es_pick,
    MAX(CASE WHEN ISNULL(u.UbicacionEsGuardado, 0) = 1
               OR ISNULL(u.UbicacionEsAbastecedora, 0) = 1 THEN 1 ELSE 0 END) AS es_guard
FROM UbicacionDetalle d
LEFT JOIN Ubicacion u ON u.UbicacionCodigo = d.UbicacionCodigo
WHERE d.UbicacionDetalleArticuloId IN ({ph})
GROUP BY d.UbicacionDetalleArticuloId, d.UbicacionCodigo
"""

SQL_REPO_EN_CAMINO = """
SELECT
    LTRIM(RTRIM(i.OTItemArticuloId))      AS art,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS ubic,
    SUM(i.OTItemCantPedida - i.OTItemCantCumplida) AS en_camino
FROM OT
INNER JOIN Codot    ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio = 1              -- Reposición
  AND OT.OTEstado IN ({vivos})
  AND i.OTItemTipo = 2                           -- Depositar (destino = picking)
  AND i.OTItemCantCumplida < i.OTItemCantPedida
  AND i.OTItemArticuloId IN ({ph})
GROUP BY i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""


def _num(v) -> float:
    try:
        return float(_safe(v) or 0)
    except (TypeError, ValueError):
        return 0.0


def _r3(v: float) -> float:
    return round(v + 0.0, 3)


def _estado_label(estado) -> str:
    return WMS_ESTADO_LABELS.get(_int(estado), {}).get("label", "Sin estado")


def _chunked_query(cur, sql_tpl: str, codigos: list[str], **fmt) -> list[tuple]:
    """Ejecuta una consulta con IN (...) partida de a _CH códigos."""
    out: list[tuple] = []
    for i in range(0, len(codigos), _CH):
        chunk = codigos[i:i + _CH]
        ph = ",".join("?" for _ in chunk)
        cur.execute(sql_tpl.format(ph=ph, **fmt), chunk)
        out.extend(cur.fetchall())
    return out


def fetch_picking_disponible(
    dias: int = VENTANA_DIAS,
    solo_problemas: bool = True,
    solo_con_problema: bool = True,
):
    """Foto en vivo, por OT de picking viva, de lo que hay para tomar en cada
    posición. Devuelve las OT ordenadas por gravedad (faltantes primero) con el
    detalle renglón por renglón (disponible | pedido | a reponer).

    dias           ventana de antigüedad de la OT (default 7, ver VENTANA_DIAS)
    solo_problemas si True (default) cada OT trae sólo los renglones con
                   problema; si False trae todos los renglones (para el
                   cartel completo del pedido).
    solo_con_problema si True (default) sólo se devuelven las OT que tienen
                   al menos un renglón con problema.
    """
    dias = max(1, int(dias or VENTANA_DIAS))
    desde = datetime.now() - timedelta(days=dias)
    vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute(
            SQL_DEMANDA.format(col_pedido=OT_COL_PEDIDO, vivos=vivos), [desde]
        )
        cols = [c[0] for c in cur.description]
        demanda = [dict(zip(cols, r)) for r in cur.fetchall()]

        codigos = sorted({_txt(f["CodArticulo"]) for f in demanda if _txt(f["CodArticulo"])})

        stock: dict[tuple[str, str], float] = {}
        guardado: dict[str, float] = {}
        pulmon: dict[str, float] = {}
        otro_picking: dict[str, float] = {}
        repo: dict[tuple[str, str], float] = {}
        if codigos:
            for art, ubic, cant, es_pick, es_guard in _chunked_query(cur, SQL_STOCK_UBIC, codigos):
                art, ubic, cant = _txt(art), _txt(ubic), _num(cant)
                stock[(art, ubic)] = stock.get((art, ubic), 0.0) + cant
                u = ubic.upper()
                if u == PULMON:
                    pulmon[art] = pulmon.get(art, 0.0) + cant
                elif u in UBIC_NO_RACK:
                    continue          # carros, cajas, no conforme, devolución…
                elif _int(es_guard) == 1:
                    guardado[art] = guardado.get(art, 0.0) + cant
                elif _int(es_pick) == 1:
                    otro_picking[art] = otro_picking.get(art, 0.0) + cant
            for art, ubic, en_camino in _chunked_query(
                cur, SQL_REPO_EN_CAMINO, codigos, vivos=vivos
            ):
                k = (_txt(art), _txt(ubic))
                repo[k] = repo.get(k, 0.0) + _num(en_camino)
    finally:
        conn.close()

    # Pedidos cancelados en Magnus: sus OT no son trabajo real (mismo criterio
    # que fetch_reposicion_ot_abiertas).
    pedidos = sorted({_int(f["NroMovVenta"]) for f in demanda if f.get("NroMovVenta") is not None})
    info_ped = _info_pedidos_resumen(pedidos) if pedidos else {}

    ots: dict[int, dict] = {}
    descartadas = 0
    espera_merca = 0

    for f in demanda:
        otid = _int(f.get("OTId"))
        nro = _int(f.get("NroMovVenta")) if f.get("NroMovVenta") is not None else None
        estado_mag = info_ped.get(nro, {}).get("Estado") if nro is not None else None
        if estado_mag and any(p in str(estado_mag).upper() for p in PATRONES_CANCELADO):
            descartadas += 1
            continue
        armador = _txt(f.get("Armador")) or SIN_ARMADOR
        if _es_operario_merca(armador):
            espera_merca += 1
            continue
        cod = _txt(f.get("CodArticulo"))
        pos = _txt(f.get("Posicion"))
        pend = _num(f.get("Pendiente"))
        if not cod or pend <= 0:
            continue

        ot = ots.setdefault(otid, {
            "OTId": otid,
            "NroMovVenta": nro,
            "Cliente": _txt(f.get("OTClienteNombre")),
            "Armador": armador,
            "Estado": _estado_label(f.get("OTEstado")),
            "Registrada": f.get("OTFechaHoraRegist"),
            "_reng": {},
        })
        r = ot["_reng"].setdefault((cod, pos), 0.0)
        ot["_reng"][(cod, pos)] = r + pend

    info_art = _info_articulos(codigos) if codigos else {}

    # Reparto FIFO: la OT más vieja tiene prioridad sobre la misma posición. Si
    # dos OT se pelean 80 unidades pidiendo 60 y 50, la primera se lleva las 60
    # y sólo la segunda queda corta — marcar a las DOS contaría el faltante dos
    # veces (serían 60 a reponer cuando en realidad faltan 30). Lo mismo con el
    # stock de guardado y con la reposición en camino, que también son un pozo
    # compartido entre OT.
    orden_fifo = sorted(
        ots.values(),
        key=lambda o: (str(o["Registrada"] or ""), o["OTId"]),
    )
    libre_pos: dict[tuple[str, str], float] = {}
    libre_repo: dict[tuple[str, str], float] = {}
    libre_guard: dict[str, float] = {}

    salida = []
    tot = {"faltante": 0, "reponer": 0, "repo_pedida": 0}
    for ot in orden_fifo:
        filas = []
        problemas = 0
        for (cod, pos), pedido in ot["_reng"].items():
            k = (cod, pos)
            en_pos = stock.get(k, 0.0)
            disp = libre_pos.get(k, en_pos)          # lo que queda cuando llega ESTA OT
            otras = max(0.0, en_pos - disp)          # lo que ya se comprometieron las anteriores
            libre_pos[k] = max(0.0, disp - pedido)
            a_reponer = max(0.0, pedido - disp)
            en_camino = libre_repo.get(k, repo.get(k, 0.0))
            en_guard = libre_guard.get(cod, guardado.get(cod, 0.0))
            en_pulmon = pulmon.get(cod, 0.0)
            es_playa = pos.upper() == PLAYA

            if a_reponer <= 0:
                sit = "ok"
            elif not es_playa and en_camino >= a_reponer:
                sit = "repo_pedida"
                libre_repo[k] = max(0.0, en_camino - a_reponer)
            elif not es_playa and en_guard >= a_reponer:
                sit = "reponer"
                libre_guard[cod] = max(0.0, en_guard - a_reponer)
            else:
                sit = "faltante"
            if sit != "ok":
                problemas += 1
                tot[sit] += 1

            filas.append({
                "CodArticulo": cod,
                "Nombre":      info_art.get(cod, {}).get("Nombre", ""),
                "Posicion":    pos,
                "Pedido":      _r3(pedido),
                "EnPosicion":  _r3(en_pos),
                "OtrasOT":     _r3(otras),
                "Disponible":  _r3(disp),
                "AReponer":    _r3(a_reponer),
                "RepoEnCamino": _r3(en_camino),
                "EnGuardado":  _r3(en_guard),
                "EnPulmon":    _r3(en_pulmon),
                "OtroPicking": _r3(max(0.0, otro_picking.get(cod, 0.0) - (en_pos if not es_playa else 0.0))),
                "EsPlaya":     es_playa,
                "Situacion":   sit,
            })

        if solo_con_problema and not problemas:
            continue
        orden = {"faltante": 0, "reponer": 1, "repo_pedida": 2, "ok": 3}
        filas.sort(key=lambda x: (orden[x["Situacion"]], -x["AReponer"], x["CodArticulo"]))
        if solo_problemas:
            filas = [x for x in filas if x["Situacion"] != "ok"]
        salida.append({
            "OTId":        ot["OTId"],
            "NroMovVenta": ot["NroMovVenta"],
            "Cliente":     ot["Cliente"],
            "Armador":     ot["Armador"],
            "Estado":      ot["Estado"],
            "Registrada":  ot["Registrada"].isoformat(sep=" ", timespec="minutes")
                           if hasattr(ot["Registrada"], "isoformat") else _txt(ot["Registrada"]),
            "Renglones":   len(ot["_reng"]),
            "ConProblema": problemas,
            "Faltantes":   sum(1 for x in filas if x["Situacion"] == "faltante"),
            "rows":        filas,
        })

    salida.sort(key=lambda o: (-o["Faltantes"], -o["ConProblema"], o["OTId"]))

    return {
        "generado":     datetime.now().isoformat(sep=" ", timespec="seconds"),
        "ventanaDias":  dias,
        "resumen": {
            "otsVivas":        len(ots),
            "otsConProblema":  len(salida),
            "faltanteReal":    tot["faltante"],
            "hayParaReponer":  tot["reponer"],
            "repoPedida":      tot["repo_pedida"],
            "renglonesDescartados": descartadas,
            "renglonesEsperaMercaderia": espera_merca,
        },
        "ots": salida,
    }


def fetch_picking_disponible_ot(ot_id: int):
    """El cartel de UNA OT puntual (todos sus renglones, no sólo los que tienen
    problema). Reusa el cálculo general y filtra — el universo de OT vivas es
    chico (cientos de renglones), así que no justifica una consulta aparte."""
    data = fetch_picking_disponible(solo_problemas=False, solo_con_problema=False)
    ot = next((o for o in data["ots"] if o["OTId"] == int(ot_id)), None)
    return {"generado": data["generado"], "ot": ot}
