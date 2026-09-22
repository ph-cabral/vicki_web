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

El guardado que habilita `reponer` se cuenta SÓLO en el depósito 1, el central
(ver DEPOSITO_CENTRAL): lo que está en otro depósito no se baja al estante.

Y el `faltante` se abre en dos, porque no son el mismo aviso:

    faltante             hay algo para bajar aunque no alcance → se muestra
    faltante + SinRepo   no hay NADA en el depósito central para reponer (ni en
                         guardado ni en camino), o el renglón es de playa: el
                         que repone no puede hacer nada con el aviso, así que
                         NO viaja en `porPasillo` (lo que lee el widget). Sigue
                         en `ots` y contado en resumen.faltanteSinRepo para la
                         vista web y para compras.

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
import re
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

# Depósito del que sí se puede bajar mercadería al estante. El 1er segmento del
# código es el depósito (`DD-PP-CC-NN`): de las 7.848 ubicaciones con código de
# rack, 7.847 son del 01 y una sola (`02-22-06-04-izq`, vacía) es de otro. Sumar
# otros depósitos daría "hay para reponer" sobre mercadería que no está acá.
DEPOSITO_CENTRAL = 1

SIN_ARMADOR = "— Sin asignar"

# Los nombres de Personal vienen con asteriscos adelante en varios legajos
# ('****Sanchez Evelyn'); se limpian sólo para mostrar, igual que en
# ot_reposicion._limpiar_nombre. El campo `Armador` de las OT se deja tal cual
# está para no cambiarle el valor a lo que ya lo consume.
_RE_ASTER = re.compile(r"^[\*\s]+")

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

# ── Armado de la OT de reposición ────────────────────────────────────────────
# Código de OT que usa el WMS para una reposición manual (pantalla
# wp_ejecutarot_cont.aspx, combo "Código"). Los otros son OT1PIC (picking),
# OT1U (ubicación) y OT1L (inventario).
CODOT_REPOSICION = "OT1R"

# De dónde BAJAR la mercadería al estante. Mismo criterio de "guardado" que usa
# el cálculo de arriba (EsGuardado ó EsAbastecedora), y se filtran después en
# Python las ubicaciones que no son rack y las de otro depósito — la lista de
# artículos es de un pasillo, así que el IN es chico.
SQL_ORIGENES = """
SELECT
    LTRIM(RTRIM(d.UbicacionDetalleArticuloId)) AS art,
    LTRIM(RTRIM(d.UbicacionCodigo))            AS ubic,
    SUM(d.UbicacionDetalleCantidad)            AS cant,
    MIN(d.UbicacionDetalleFecPrimIngAubi)      AS desde
FROM UbicacionDetalle d
INNER JOIN Ubicacion u ON u.UbicacionCodigo = d.UbicacionCodigo
WHERE d.UbicacionDetalleArticuloId IN ({ph})
  AND (ISNULL(u.UbicacionEsGuardado, 0) = 1 OR ISNULL(u.UbicacionEsAbastecedora, 0) = 1)
GROUP BY d.UbicacionDetalleArticuloId, d.UbicacionCodigo
HAVING SUM(d.UbicacionDetalleCantidad) > 0
"""

# Lo que otras OT de reposición vivas YA se comprometieron a sacar de esas
# mismas ubicaciones de guardado (OTItemTipo = 1 = Recolectar). Sin esto, dos
# OT armadas con minutos de diferencia mandan al repositor a buscar dos veces
# el mismo stock y la segunda queda corta en el estante.
SQL_ORIGEN_COMPROMETIDO = """
SELECT
    LTRIM(RTRIM(i.OTItemArticuloId))      AS art,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo)) AS ubic,
    SUM(i.OTItemCantPedida - i.OTItemCantCumplida) AS tomado
FROM OT
INNER JOIN Codot    ON OT.CodotCodigo = Codot.CodotCodigo
INNER JOIN OTItem i ON i.OTId = OT.OTId
WHERE Codot.CodotProcesoNegocio = 1              -- Reposición
  AND OT.OTEstado IN ({vivos})
  AND i.OTItemTipo = 1                           -- Recolectar (origen = guardado)
  AND i.OTItemCantCumplida < i.OTItemCantPedida
  AND i.OTItemArticuloId IN ({ph})
GROUP BY i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""


def pasillo_de(ubic) -> str:
    """Pasillo al que pertenece una ubicación del WMS.

    El código es `DD-PP-CC-NN[-LADO]` (depósito, pasillo, columna, nivel) y el
    2º segmento es el pasillo — ver claude/wms_ubicaciones_nomenclatura.md. Dos
    cosas que no se pueden resolver con un split a secas:

    - **Sobrestock**: son 2.853 ubicaciones con el prefijo FIJO `01-09-04` y
      después su propia estructura (`01-09-04-PP-CC-NN[-D/I]`). No son la
      columna 4 del pasillo 9: es la zona de sobrestock entera. Se detectan
      porque tienen 6 segmentos numéricos y el 2º y 3º son 9 y 4 (un rack normal
      tiene 4).
    - **Códigos sucios** que hay en la base: `010-09-04-04-24-01` (un 0 de más),
      `SE01-09-04-02-10-02` (prefijo de letras), `01-34-04--03-DER` (doble
      guión), `01-16-08-O` (nivel con letra). Por eso se recorren los segmentos
      quedándose con los numéricos y se corta en el primero que no lo sea.

    Las ubicaciones con nombre (PLAYA_PEDIDOS, PULMON_INGRESO, CARRO01…) se
    devuelven tal cual: son su propio grupo.
    """
    u = _txt(ubic).upper()
    if not u:
        return "?"
    nums: list[int] = []
    for parte in [p for p in u.split("-") if p]:
        digitos = "".join(c for c in parte if c.isdigit())
        if digitos and digitos == parte:
            nums.append(int(digitos))
        elif not nums and digitos:
            nums.append(int(digitos))      # "SE01" al principio
        else:
            break                          # "DER", "IZQ", "TRAMO", nivel-letra
    if len(nums) >= 6 and nums[1] == 9 and nums[2] == 4:
        return "SOBRESTOCK"
    if len(nums) >= 2:
        return "%02d" % nums[1]
    return u


def deposito_de(ubic) -> int | None:
    """Depósito (1er segmento) de una ubicación con código de rack.

    `01-33-15-03` → 1. Devuelve None para las ubicaciones con nombre
    (PLAYA_PEDIDOS, CARRO25…), que no pertenecen a ningún depósito.

    Los códigos sucios con un 0 de más (`010-09-04-04-24-01`) son del 01: el
    depósito son los 2 primeros dígitos. Un prefijo de letras (`SE01-…`) se
    limpia igual que en pasillo_de.
    """
    u = _txt(ubic).upper()
    if not u:
        return None
    parte = next((p for p in u.split("-") if p), "")
    digitos = "".join(c for c in parte if c.isdigit())
    if not digitos:
        return None
    return int(digitos[:2])


def _orden_pasillo(pas: str):
    """Los numéricos primero y en orden; los con nombre, al final alfabético."""
    return (0, int(pas), "") if pas.isdigit() else (1, 0, pas)


def _num(v) -> float:
    try:
        return float(_safe(v) or 0)
    except (TypeError, ValueError):
        return 0.0


def _r3(v: float) -> float:
    return round(v + 0.0, 3)


def _estado_label(estado) -> str:
    return WMS_ESTADO_LABELS.get(_int(estado), {}).get("label", "Sin estado")


def _nombre_operario(nombre) -> str:
    """Nombre del armador listo para mostrar (sin los asteriscos del legajo)."""
    n = _txt(nombre)
    return _RE_ASTER.sub("", n) or n


def texto_observaciones(operarios) -> str:
    """Las Observaciones con las que nace la OT de reposición: una línea por
    armador que está esperando alguno de los artículos que se van a reponer.

        * para Sanchez Evelyn
        * para Gomez Luis

    El que repone lee ahí a quién le está destrabando el pedido, que es lo que
    decide si le conviene hacer ese viaje ahora o después. Se ordena
    alfabético y se deduplica sin distinguir mayúsculas; las OT sin armador
    asignado no aportan un nombre, así que no ocupan una línea.
    """
    vistos: set[str] = set()
    nombres: list[str] = []
    for o in operarios or []:
        n = _nombre_operario(o)
        if not n or n == SIN_ARMADOR or n.lower() in vistos:
            continue
        vistos.add(n.lower())
        nombres.append(n)
    return "\n".join("* para %s" % n for n in sorted(nombres, key=str.lower))


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
                elif deposito_de(u) != DEPOSITO_CENTRAL:
                    continue          # otro depósito: no se baja a este estante
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

    # Vista por PASILLO: se acumula artículo por artículo mientras se recorre,
    # incluidos los renglones que SÍ alcanzan, para que "cuánto se pidió en
    # total" sea la demanda real del artículo y no sólo la parte que quedó
    # corta. El "cuánto hay" se guarda por posición (dict) y no sumando, porque
    # dos OT sobre la misma posición traen el mismo stock y sumarlo lo contaría
    # dos veces.
    por_art: dict[tuple[str, str], dict] = {}
    PEOR = {"faltante": 0, "reponer": 1, "repo_pedida": 2, "ok": 3}

    salida = []
    tot = {"faltante": 0, "reponer": 0, "repo_pedida": 0}
    tot_sin_repo = 0
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

            # Sin nada para bajar al estante el aviso no sirve: el que repone no
            # puede hacer nada. Se marca y se saca de la vista por pasillo (el
            # widget), no del detalle por OT. La playa nunca se repone, así que
            # va siempre acá.
            sin_repo = sit == "faltante" and (
                es_playa or (en_guard <= 0 and en_camino <= 0)
            )
            if sit != "ok":
                problemas += 1
                tot[sit] += 1
                if sin_repo:
                    tot_sin_repo += 1

            pas = pasillo_de(pos)
            e = por_art.setdefault((pas, cod), {
                "ots": set(), "operarios": set(), "pedido": 0.0, "reponer": 0.0,
                "hay": {}, "sit": "ok", "posiciones": set(), "sin_repo": True,
            })
            e["ots"].add(ot["OTId"])
            e["operarios"].add(ot["Armador"])
            e["pedido"] += pedido
            e["reponer"] += a_reponer
            e["hay"][pos] = en_pos
            e["posiciones"].add(pos)
            if PEOR[sit] < PEOR[e["sit"]]:
                e["sit"] = sit
            # El artículo se oculta sólo si NINGUNO de sus renglones con
            # faltante tiene de dónde reponerse.
            if a_reponer > 0 and not sin_repo:
                e["sin_repo"] = False

            filas.append({
                "CodArticulo": cod,
                "Nombre":      info_art.get(cod, {}).get("Nombre", ""),
                "Posicion":    pos,
                "Pasillo":     pas,
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
                "SinRepo":     sin_repo,
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

    # Vista por pasillo = orden de trabajo del repositor: lo que no se puede
    # reponer (nada en el depósito central, o playa) no entra.
    grupos: dict[str, list] = {}
    ocultos_sin_repo = 0
    for (pas, cod), e in por_art.items():
        if e["reponer"] <= 0:
            continue
        if e["sin_repo"]:
            ocultos_sin_repo += 1
            continue
        # Quién está esperando este artículo. Va por artículo (y no sólo por
        # pasillo) porque es el dato con el que se arman las Observaciones de la
        # OT de reposición — ver texto_observaciones.
        operarios = sorted(
            {
                n for n in (_nombre_operario(o) for o in e["operarios"])
                if n and n != SIN_ARMADOR
            },
            key=str.lower,
        )
        grupos.setdefault(pas, []).append({
            "CodArticulo": cod,
            "Nombre":      info_art.get(cod, {}).get("Nombre", ""),
            "OTs":         len(e["ots"]),
            "Operarios":   operarios,
            "Hay":         _r3(sum(e["hay"].values())),
            "Pedido":      _r3(e["pedido"]),
            "AReponer":    _r3(e["reponer"]),
            "Posiciones":  sorted(e["posiciones"]),
            "Situacion":   e["sit"],
        })
    por_pasillo = []
    for pas in sorted(grupos, key=_orden_pasillo):
        filas_pas = sorted(grupos[pas], key=lambda r: (-r["AReponer"], r["CodArticulo"]))
        por_pasillo.append({
            "Pasillo":   pas,
            "Articulos": len(filas_pas),
            "AReponer":  _r3(sum(r["AReponer"] for r in filas_pas)),
            "Faltantes": sum(1 for r in filas_pas if r["Situacion"] == "faltante"),
            "rows":      filas_pas,
        })

    return {
        "generado":     datetime.now().isoformat(sep=" ", timespec="seconds"),
        "ventanaDias":  dias,
        "resumen": {
            "otsVivas":        len(ots),
            "otsConProblema":  len(salida),
            "faltanteReal":    tot["faltante"],
            "faltanteSinRepo": tot_sin_repo,
            "hayParaReponer":  tot["reponer"],
            "repoPedida":      tot["repo_pedida"],
            "articulosOcultosSinRepo": ocultos_sin_repo,
            "renglonesDescartados": descartadas,
            "renglonesEsperaMercaderia": espera_merca,
        },
        "ots": salida,
        "porPasillo": por_pasillo,
    }


def fetch_picking_disponible_ot(ot_id: int):
    """El cartel de UNA OT puntual (todos sus renglones, no sólo los que tienen
    problema). Reusa el cálculo general y filtra — el universo de OT vivas es
    chico (cientos de renglones), así que no justifica una consulta aparte."""
    data = fetch_picking_disponible(solo_problemas=False, solo_con_problema=False)
    ot = next((o for o in data["ots"] if o["OTId"] == int(ot_id)), None)
    return {"generado": data["generado"], "ot": ot}


# ── Armar la OT de reposición de un pasillo ──────────────────────────────────
def _elegir_origenes(pasillo: str, falta: float, candidatos: list[dict]) -> list[dict]:
    """Reparte lo que falta reponer entre las ubicaciones de guardado que
    tienen stock, y devuelve los renglones de recolección.

    El orden es el del recorrido real del repositor, no el del stock:

    1. **el mismo pasillo primero** — si el material está en el rack de arriba
       del propio estante no hay que cruzar el depósito;
    2. **lo más viejo primero** (FecPrimIngAubi), que es el FIFO que ya aplica
       el WMS al recolectar;
    3. a igualdad, la ubicación con más cantidad, para partir el renglón en la
       menor cantidad de paradas posible.

    Si ninguna cubre el total se parte en varios renglones, y si el guardado
    alcanza sólo para una parte se devuelve esa parte (un viaje que repone 30
    de 100 sirve igual, mismo criterio que la vista por pasillo).
    """
    orden = sorted(
        candidatos,
        key=lambda c: (
            0 if c["pasillo"] == pasillo else 1,
            str(c["desde"] or "9999"),
            -c["libre"],
        ),
    )
    lineas, resta = [], float(falta)
    for c in orden:
        if resta <= 0:
            break
        toma = min(resta, c["libre"])
        if toma <= 0:
            continue
        c["libre"] -= toma          # el dict es compartido entre artículos
        resta -= toma
        lineas.append({
            "Ubicacion": c["ubic"],
            "Deposito": DEPOSITO_CENTRAL,
            "Cantidad": _r3(toma),
            "EnUbicacion": _r3(c["libre"] + toma),
            "MismoPasillo": c["pasillo"] == pasillo,
        })
    return lineas


def fetch_ot_reposicion(pasillo: str, dias: int = VENTANA_DIAS):
    """Renglones listos para cargar la OT de reposición de UN pasillo.

    Es la vista por pasillo del widget (`porPasillo`) más el dato que ahí falta:
    **de qué ubicación de guardado sacar cada artículo**. El destino no se
    calcula acá a propósito — en la pantalla del WMS lo resuelve el botón
    "Ubicar todo en Picking", que usa la posición de picking que el propio WMS
    tiene asignada; se devuelve como `DestinoEsperado` sólo para control.

    Sale ordenado por ubicación de origen, que es el orden en que el repositor
    camina el pasillo.
    """
    pas = str(pasillo or "").strip().upper()
    if not pas:
        return {
            "pasillo": "", "codigo": CODOT_REPOSICION, "lineas": [],
            "sinOrigen": [], "operarios": [], "observaciones": "",
        }

    data = fetch_picking_disponible(dias=dias)
    grupo = next((g for g in data.get("porPasillo", []) if str(g["Pasillo"]).upper() == pas), None)
    filas = (grupo or {}).get("rows", [])
    codigos = sorted({r["CodArticulo"] for r in filas if r.get("AReponer", 0) > 0})

    cand: dict[str, list[dict]] = {}
    if codigos:
        vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)
        conn = get_connection("WMS")
        try:
            cur = conn.cursor()
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            tomado: dict[tuple[str, str], float] = {}
            for art, ubic, cant in _chunked_query(
                cur, SQL_ORIGEN_COMPROMETIDO, codigos, vivos=vivos
            ):
                k = (_txt(art), _txt(ubic))
                tomado[k] = tomado.get(k, 0.0) + _num(cant)
            for art, ubic, cant, desde in _chunked_query(cur, SQL_ORIGENES, codigos):
                art, ubic = _txt(art), _txt(ubic)
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
                })
        finally:
            conn.close()

    lineas, sin_origen = [], []
    for r in sorted(filas, key=lambda x: -x["AReponer"]):
        falta = r.get("AReponer") or 0
        if falta <= 0:
            continue
        destino = (r.get("Posiciones") or [None])[0]
        partes = _elegir_origenes(pas, falta, cand.get(r["CodArticulo"], []))
        cubierto = sum(p["Cantidad"] for p in partes)
        for p in partes:
            lineas.append({
                "Articulo": r["CodArticulo"],
                "Nombre": r.get("Nombre", ""),
                "DestinoEsperado": destino,
                "AReponer": _r3(falta),
                "Operarios": r.get("Operarios") or [],
                **p,
            })
        if cubierto < falta - 0.001:
            sin_origen.append({
                "Articulo": r["CodArticulo"],
                "Nombre": r.get("Nombre", ""),
                "AReponer": _r3(falta),
                "Cubierto": _r3(cubierto),
            })

    lineas.sort(key=lambda l: (l["Ubicacion"], l["Articulo"]))
    # Los armadores que esperan CUALQUIERA de los artículos que entran en la OT
    # (sólo los que quedaron con renglón: si no hay de dónde sacarlo, ese
    # operario no se destraba con esta OT y no va en las Observaciones).
    operarios = sorted(
        {o for l in lineas for o in (l.get("Operarios") or [])}, key=str.lower
    )
    return {
        "generado": data.get("generado"),
        "pasillo": pas,
        "codigo": CODOT_REPOSICION,
        "deposito": DEPOSITO_CENTRAL,
        "articulos": len({l["Articulo"] for l in lineas}),
        "unidades": _r3(sum(l["Cantidad"] for l in lineas)),
        "operarios": operarios,
        "observaciones": texto_observaciones(operarios),
        "lineas": lineas,
        "sinOrigen": sin_origen,
    }
