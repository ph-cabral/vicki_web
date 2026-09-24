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

    disponible    = cantidad de (artículo, posición) en UbicacionDetalle
                    − lo que las OT ANTERIORES en la cola ya tienen comprometido
                      sobre esa misma posición (reparto FIFO por fecha de la OT)
    pedido        = OTItemCantPedida − OTItemCantCumplida
    a reponer BRUTO = max(0, pedido − disponible)
    a reponer       = max(0, a reponer BRUTO − lo que ya viene en camino)

El reparto es FIFO y no "cada OT contra el total": con 80 en el estante y dos OT
pidiendo 60 y 50, la primera se lleva las 60 y sólo la segunda queda corta. Si se
marcaran las dos, el faltante se contaría dos veces (60 cuando en realidad faltan
30). Lo mismo con el stock de guardado y con la reposición en camino, que también
son un pozo compartido.

`UbicacionDetalleCantidad` YA está neto de lo pickeado (cuando el armador toma,
la cantidad sale de la posición). Lo que no está descontado, y es todo el
aporte de este módulo, es lo que las otras OT abiertas tienen comprometido
contra el mismo estante.

**"a reponer" ya resta lo que viene en camino (2026-09-22).** Si hay una OT de
reposición viva hacia esa MISMA posición (armada desde este widget o a mano),
su cantidad pendiente se resta del faltante ANTES de mirar guardado — no es
todo o nada. Con 50 de faltante y una reposición ya pedida por 30, quedan 20
por resolver (no 50): el cartel muestra 20 y, si se vuelve a armar una OT para
ese pasillo, sólo se pide lo que sigue faltando — evita pedir dos veces el
mismo faltante. Si la reposición en camino cubre el faltante entero, la
cantidad neta llega a 0 y el artículo directamente NO entra a `porPasillo`
("armar OT" ya no tiene nada que hacer con él).

El "a reponer" (neto) se abre en tres situaciones, porque el WMS YA genera OT de
reposición solo (CodotProcesoNegocio = 1; en la reposición OTItemTipo = 1 es la
recolección desde la abastecedora y OTItemTipo = 2 el depósito en la posición
de picking):

    repo_pedida → lo que ya viene en camino cubre TODO el faltante restante
    reponer     → lo que queda después de la reposición en camino se puede
                  bajar de guardado/abastecedora
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

**Universo de la demanda (2026-09-23): todos los pedidos abiertos, no sólo los
asignados.** Antes entraban sólo las OT de picking vivas con armador de los
últimos 7 días; así el faltante se veía recién cuando el pedido ya estaba en
manos de alguien. Ahora se anticipa lo que va a faltar cuando se asignen:

    pedidos 10/100/210/310/410   pedido Abierto en Magnus (EstadoPedido = 2),
                                 con o sin armador, sin ventana de fecha
                                 (el filtro de abierto ya saca los zombis)
    acopio 70/75                 SÓLO la vuelta con remito 71 vivo (no anulado
                                 ni borrador) — el saldo del acopio sin vuelta
                                 mandada no es demanda. OJO: la cabecera del
                                 acopio suele estar en Estado 4 aunque la vuelta
                                 esté viva, por eso NO se mira EstadoPedido. Se
                                 acota a `dias` (default 15): hay OT de vueltas
                                 de 2025 que quedaron vivas con remito.
    centro de preparación        sólo CP1. La OT de picking del WMS ya es CP1
                                 (los renglones CP2 no viajan al WMS); los
                                 pedidos sin OT se leen de Magnus con
                                 CodCentroPrep = 1.
    pedido abierto sin OT        (el WMS todavía no la generó) → renglones CP1
                                 de Magnus, contra la posición de picking que el
                                 WMS tiene asignada al artículo (UbicacionItem
                                 sobre ubicación EsPicking, prefiriendo un
                                 estante de rack). Sin posición de rack →
                                 PLAYA_PEDIDOS, que es donde el WMS manda a
                                 pickear lo que no tiene lugar propio.

Reparto FIFO por escalones: primero las OT con armador (ya están consumiendo
el estante), después las OT sin armador y al final los pedidos sin OT; dentro
de cada escalón, por fecha. Así lo que ya está asignado nunca queda "corto"
por culpa de algo que todavía no se tomó.

Gotchas (medidos 2026-09-21, ver claude/picking_disponible_al_asignar_armador.md):

- OT zombi: de 37 OT en estado 1, 9 eran de meses anteriores (una de 2025). Sin
  el filtro de VENTANA_DIAS inflan la demanda comprometida y generan alarmas
  falsas.
- PLAYA_PEDIDOS (UbicacionEsPicking = 1) es un picking grande, el de todos los
  artículos sin posición de picking propia: el WMS ya no deja asignar más
  artículos a la playa en UbicacionItem, pero igual manda ahí los que no tienen
  lugar. Se trata como cualquier posición de picking: su stock es el
  disponible, se repone desde guardado y la reposición en camino hacia la playa
  cuenta. `EsPlaya` queda sólo como marca informativa (desde 2026-09-23; antes
  se la trataba como acopio sin reposición).
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
    WMS_ESTADOS_VIVOS,
    WMS_ESTADO_LABELS,
    es_operario_ignorado,
    _info_articulos,
    _int,
    _safe,
    _txt,
)

# Ventana de antigüedad de la VUELTA de acopio (OTFechaHoraRegist de su OT).
# Desde 2026-09-23 sólo aplica a 70/75: los demás pedidos entran si están
# Abiertos en Magnus, sin importar la fecha. Hay OT de vueltas de 2025 que
# quedaron vivas con remito y nadie va a tomar.
VENTANA_DIAS = 15

# Comprobantes con centro de preparación 1 que entran por "pedido abierto".
CODIGOS_PEDIDO_CP1 = (10, 100, 210, 310, 410)
# Acopio: entra sólo la vuelta con remito (CompCodigo 71) vivo.
CODIGOS_ACOPIO = (70, 75)
COMP_REMITO_ACOPIO = 71
ESTADO_PEDIDO_ABIERTO = 2
CENTRO_PREP_1 = 1
# Pedidos abiertos que todavía no tienen OT de picking: tope de antigüedad por
# resguardo (hoy son los últimos minutos; seek por EstadoPedido+CompCodigo).
PEDIDO_SIN_OT_VENTANA_DIAS = 30
# Preparador "Mercaderia X Llegar" (mismo número en Magnus Gen_Usuarios y en
# WMS Personal): usuario creado para APARTAR los pedidos que esperan
# mercadería. Nunca se van a poder reponer, así que no son demanda. Del lado
# WMS se descartan por nombre (deposito.es_operario_ignorado); del lado Magnus
# por este número en Ven_PedImpresoCA.CodArmador, que cubre el pedido apartado
# cuya OT todavía no tiene ese armador o que todavía no tiene OT.
COD_ARMADOR_ESPERA_MERCA = 239

# Marca histórica de "artículo sin posición de picking". Desde 2026-09-23 ya
# no se produce: sin estante propio el picking es PLAYA_PEDIDOS. Se deja el
# nombre porque el flag SinPosicion sigue viajando en la respuesta.
SIN_POSICION = "SIN_POSICION"
_BASE_MAGNUS = datetime(1800, 12, 28)

# Picking general de los artículos sin posición propia. Es destino válido de
# reposición; NO es origen (está en UBIC_NO_RACK: no se baja de la playa).
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
    OT.OTNromovventaRemito                    AS NroRemito,
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
  AND i.OTItemTipo = 1                           -- Recolectar
  AND i.OTItemCantCumplida < i.OTItemCantPedida
GROUP BY OT.OTId, OT.{col_pedido}, OT.OTNromovventaRemito, OT.OTEstado,
         OT.OTFechaHoraRegist, OT.OTClienteNombre, P.PersonalNombre,
         i.OTItemArticuloId, i.OTItemUbicacionCodigo
"""
# Sin filtro de fecha: el universo lo recorta Magnus (pedido abierto / vuelta
# con remito). Las OT vivas son un centenar y entran por el índice UOTESTADO.

# Estado y comprobante de los pedidos de las OT vivas (EVERWEAR, seek por PK).
SQL_PEDIDOS_ESTADO = """
SELECT cab.NroMovVenta, cab.CompCodigo, cab.EstadoPedido,
       CASE WHEN EXISTS (
            SELECT 1 FROM Ven_PedImpresoCA c
            WHERE c.NroMovVenta = cab.NroMovVenta
              AND c.CodArmador = {apartado}
       ) THEN 1 ELSE 0 END AS Apartado
FROM VenFer_PedidoCabecera cab
WHERE cab.NroMovVenta IN ({ph})
"""

# Remitos de vuelta de acopio que siguen vivos (ni anulados ni borrador vacío).
# El NroMovVenta del remito lo trae la propia OT (OTNromovventaRemito).
SQL_REMITOS_VUELTA = """
SELECT r.NroMovVenta
FROM VenFer_RmtoCabecera r
WHERE r.NroMovVenta IN ({ph})
  AND r.CompCodigo = {comp_remito}
  AND ISNULL(r.EstadoRemito, 0) NOT IN (3, 4)
"""

# Pedidos abiertos con renglones CP1 cuyo centro 1 todavía no terminó. La
# CantidadCumplida de estos comprobantes viene precargada igual a la pedida,
# así que la demanda es CantidadPedida. Seek por VF_PEDCAB_Cla_EstadoCompCodigo.
SQL_PEDIDOS_SIN_OT = """
SELECT cab.NroMovVenta, cab.CompCodigo, cab.FechaPedido, cab.HoraRegistracion,
       RTRIM(cab.RazonSocial)            AS Cliente,
       LTRIM(RTRIM(r.CodArticu))         AS CodArticulo,
       SUM(r.CantidadPedida)             AS Pendiente
FROM VenFer_PedidoCabecera cab
INNER JOIN VenFer_PedidoReng r ON r.NroMovVenta = cab.NroMovVenta
WHERE cab.EstadoPedido = {abierto}
  AND cab.CompCodigo IN ({comps})
  AND cab.FechaPedido >= ?
  AND r.CodCentroPrep = {cp}
  AND r.Estado <> 4
  AND r.CantidadPedida > 0
  AND NOT EXISTS (                 -- apartado en "Mercaderia X Llegar"
        SELECT 1 FROM Ven_PedImpresoCA c
        WHERE c.NroMovVenta = cab.NroMovVenta
          AND c.CodArmador = {apartado})
  AND NOT EXISTS (
        SELECT 1 FROM Ven_PedImpresoCA c
        WHERE c.NroMovVenta = cab.NroMovVenta
          AND c.CodCentroPrep = {cp}
          AND (LTRIM(RTRIM(ISNULL(c.ObsArmadorMovil, ''))) <> ''
               OR ISNULL(c.FechaFin, 0) > 0))
GROUP BY cab.NroMovVenta, cab.CompCodigo, cab.FechaPedido, cab.HoraRegistracion,
         cab.RazonSocial, r.CodArticu
"""

# De esos, los que YA tienen OT de picking en el WMS (en cualquier estado): si
# está viva ya entra por SQL_DEMANDA; si está cumplida ya salió del estante.
# Seek por UOTPEDIDO (OTNromovventa).
SQL_PEDIDOS_CON_OT = """
SELECT DISTINCT OT.{col_pedido}
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
WHERE Codot.CodotProcesoNegocio = 4
  AND OT.{col_pedido} IN ({ph})
"""

# Posición de picking asignada a cada artículo (la misma que el WMS pone en
# OTItemUbicacionCodigo al generar la OT). Seek por IUBICACIONITEM1.
SQL_POS_PICKING = """
SELECT LTRIM(RTRIM(ui.UbicacionItemArticuloId)) AS art,
       LTRIM(RTRIM(ui.UbicacionCodigo))         AS ubic,
       ISNULL(ui.UbicacionItemStkMaximo, 0)     AS mx
FROM UbicacionItem ui
INNER JOIN Ubicacion u ON u.UbicacionCodigo = ui.UbicacionCodigo
WHERE ui.UbicacionItemArticuloId IN ({ph})
  AND ISNULL(u.UbicacionEsPicking, 0) = 1
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



def _art(v) -> str:
    """Código de artículo normalizado para usar como CLAVE.

    El WMS guarda el mismo artículo con mayúsculas o minúsculas según quién lo
    cargó (`nc2000010` en UbicacionDetalle, `NC2000010` en OTItem). SQL Server
    los iguala (collation CI) y por eso el IN los trae, pero los dicts de
    Python no: sin esto el stock de la posición quedaba bajo otra clave y el
    renglón salía con HAY = 0. Relevado 23/09/2026: 226 filas de
    UbicacionDetalle (217 artículos, todas con stock), 4.630 de OTItem y 511
    de UbicacionItem tienen minúsculas.
    """
    return _txt(v).upper()


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


def _registro_pedido(fecha_dias, hora):
    """FechaPedido (días desde 1800-12-28) + HoraRegistracion → datetime.

    HoraRegistracion viene en CENTÉSIMAS de segundo desde medianoche (3185540 =
    08:50:55, verificado contra la OT del mismo pedido); si llega un valor chico
    se lee como HHMM, igual que el resto de las horas de Magnus."""
    try:
        f = int(fecha_dias or 0)
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    try:
        h = int(hora or 0)
    except (TypeError, ValueError):
        h = 0
    if h > 2359:
        seg = h // 100
    else:
        hh, mm = divmod(h, 100)
        seg = hh * 3600 + mm * 60
    return _BASE_MAGNUS + timedelta(days=f, seconds=min(seg, 86399))


def _dias_magnus(d: datetime) -> int:
    return (datetime(d.year, d.month, d.day) - _BASE_MAGNUS).days


def _magnus_universo(pedidos: list[int], remitos: list[int]):
    """Una sola conexión a EVERWEAR para las tres cosas que decide Magnus:
    estado/comprobante de los pedidos de las OT vivas, qué remitos de vuelta de
    acopio siguen vivos y los pedidos abiertos CP1 que todavía no tienen OT."""
    info: dict[int, dict] = {}
    remitos_ok: set[int] = set()
    sin_ot: list[dict] = []
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        for nro, comp, estado, apartado in _chunked_query(
            cur, SQL_PEDIDOS_ESTADO, pedidos, apartado=COD_ARMADOR_ESPERA_MERCA
        ):
            info[_int(nro)] = {
                "CompCodigo": _int(comp),
                "EstadoPedido": _int(estado),
                "Apartado": _int(apartado) == 1,
            }
        for (nro,) in _chunked_query(
            cur, SQL_REMITOS_VUELTA, remitos, comp_remito=COMP_REMITO_ACOPIO
        ):
            remitos_ok.add(_int(nro))
        desde = _dias_magnus(datetime.now() - timedelta(days=PEDIDO_SIN_OT_VENTANA_DIAS))
        cur.execute(
            SQL_PEDIDOS_SIN_OT.format(
                abierto=ESTADO_PEDIDO_ABIERTO,
                comps=",".join(str(c) for c in CODIGOS_PEDIDO_CP1),
                cp=CENTRO_PREP_1,
                apartado=COD_ARMADOR_ESPERA_MERCA,
            ),
            [desde],
        )
        cols = [c[0] for c in cur.description]
        sin_ot = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()
    return info, remitos_ok, sin_ot


def fetch_picking_disponible(
    dias: int = VENTANA_DIAS,
    solo_problemas: bool = True,
    solo_con_problema: bool = True,
):
    """Foto en vivo de lo que hay para tomar en cada posición de picking contra
    TODOS los pedidos abiertos (ver "Universo de la demanda" arriba): OT de
    picking vivas con o sin armador, vueltas de acopio con remito y pedidos
    abiertos CP1 que todavía no tienen OT. Devuelve un cartel por OT (o por
    pedido, si todavía no tiene OT) ordenado por gravedad, con el detalle
    renglón por renglón (disponible | pedido | a reponer).

    dias           ventana de antigüedad de las VUELTAS de acopio 70/75
                   (default 15, ver VENTANA_DIAS). No recorta a los demás.
    solo_problemas si True (default) cada OT trae sólo los renglones con
                   problema; si False trae todos los renglones (para el
                   cartel completo del pedido).
    solo_con_problema si True (default) sólo se devuelven las OT que tienen
                   al menos un renglón con problema.
    """
    dias = max(1, int(dias or VENTANA_DIAS))
    desde_acopio = datetime.now() - timedelta(days=dias)
    vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)

    stock: dict[tuple[str, str], float] = {}
    guardado: dict[str, float] = {}
    pulmon: dict[str, float] = {}
    otro_picking: dict[str, float] = {}
    repo: dict[tuple[str, str], float] = {}
    pos_pick: dict[str, str] = {}

    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        cur.execute(SQL_DEMANDA.format(col_pedido=OT_COL_PEDIDO, vivos=vivos))
        cols = [c[0] for c in cur.description]
        demanda = [dict(zip(cols, r)) for r in cur.fetchall()]

        pedidos_ot = sorted({_int(f["NroMovVenta"]) for f in demanda if _int(f.get("NroMovVenta"))})
        remitos = sorted({_int(f["NroRemito"]) for f in demanda if _int(f.get("NroRemito"))})
        info_ped, remitos_ok, sin_ot = _magnus_universo(pedidos_ot, remitos)

        # Pedidos abiertos sin OT: se descartan los que ya tienen OT de picking
        # (viva → ya viene en `demanda`; cumplida → ya salió del estante).
        cand = sorted({_int(f["NroMovVenta"]) for f in sin_ot})
        con_ot = {
            _int(r[0]) for r in _chunked_query(
                cur, SQL_PEDIDOS_CON_OT, cand, col_pedido=OT_COL_PEDIDO
            )
        } if cand else set()
        sin_ot = [f for f in sin_ot if _int(f["NroMovVenta"]) not in con_ot]

        arts_sin_ot = sorted({_art(f["CodArticulo"]) for f in sin_ot if _art(f["CodArticulo"])})
        if arts_sin_ot:
            mejor: dict[str, float] = {}
            for art, ubic, mx in _chunked_query(cur, SQL_POS_PICKING, arts_sin_ot):
                art, ubic, mx = _art(art), _txt(ubic), _num(mx)
                if ubic.upper() == PLAYA:
                    continue          # la playa es el último recurso (abajo)
                # Si hay más de una, la de mayor capacidad (StkMaximo) es la
                # que el WMS usa como principal.
                if art not in pos_pick or mx > mejor[art] or (
                    mx == mejor[art] and ubic < pos_pick[art]
                ):
                    pos_pick[art], mejor[art] = ubic, mx

        codigos = sorted(
            {_art(f["CodArticulo"]) for f in demanda if _art(f["CodArticulo"])}
            | set(arts_sin_ot)
        )

        if codigos:
            for art, ubic, cant, es_pick, es_guard in _chunked_query(cur, SQL_STOCK_UBIC, codigos):
                art, ubic, cant = _art(art), _txt(ubic), _num(cant)
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
                k = (_art(art), _txt(ubic))
                repo[k] = repo.get(k, 0.0) + _num(en_camino)
    finally:
        conn.close()

    ots: dict[int, dict] = {}
    descartadas = 0          # pedido no abierto / cancelado / inexistente en Magnus
    acopio_sin_remito = 0
    acopio_fuera_ventana = 0
    espera_merca = 0
    sin_asignar = 0

    for f in demanda:
        otid = _int(f.get("OTId"))
        nro = _int(f.get("NroMovVenta")) if f.get("NroMovVenta") is not None else None
        ip = info_ped.get(nro) if nro is not None else None
        if ip is None:
            descartadas += 1
            continue
        if ip["CompCodigo"] in CODIGOS_ACOPIO:
            # Acopio: manda la VUELTA (remito 71 vivo), no el estado de la
            # cabecera — que suele estar en 4 con la vuelta todavía en curso.
            if _int(f.get("NroRemito")) not in remitos_ok:
                acopio_sin_remito += 1
                continue
            reg = f.get("OTFechaHoraRegist")
            if hasattr(reg, "year") and reg < desde_acopio:
                acopio_fuera_ventana += 1
                continue
        elif ip["EstadoPedido"] != ESTADO_PEDIDO_ABIERTO:
            descartadas += 1
            continue
        armador = _txt(f.get("Armador")) or SIN_ARMADOR
        # El buzón "Mercaderia X Llegar" y los demás operarios de
        # deposito.OPERARIOS_IGNORADOS no generan aviso: de esas OT ya se sabe
        # por qué están esperando.
        if es_operario_ignorado(armador) or ip.get("Apartado"):
            espera_merca += 1
            continue
        cod = _art(f.get("CodArticulo"))
        pos = _txt(f.get("Posicion"))
        pend = _num(f.get("Pendiente"))
        if not cod or pend <= 0:
            continue
        asignada = armador != SIN_ARMADOR
        if not asignada:
            sin_asignar += 1

        ot = ots.setdefault(otid, {
            "OTId": otid,
            "NroMovVenta": nro,
            "Cliente": _txt(f.get("OTClienteNombre")),
            "Armador": armador,
            "Estado": _estado_label(f.get("OTEstado")),
            "Registrada": f.get("OTFechaHoraRegist"),
            "Asignada": asignada,
            "SinOT": False,
            "Acopio": ip["CompCodigo"] in CODIGOS_ACOPIO,
            # escalón del FIFO: lo asignado consume primero.
            "_tier": 0 if asignada else 1,
            "_reng": {},
        })
        ot["_reng"][(cod, pos)] = ot["_reng"].get((cod, pos), 0.0) + pend

    # Pedidos abiertos que el WMS todavía no pasó a OT: último escalón. La
    # clave es el NroMovVenta en negativo, para no chocar con un OTId real.
    for f in sin_ot:
        nro = _int(f.get("NroMovVenta"))
        cod = _art(f.get("CodArticulo"))
        pend = _num(f.get("Pendiente"))
        if not nro or not cod or pend <= 0:
            continue
        # Sin estante propio el WMS lo manda a pickear a la playa.
        pos = pos_pick.get(cod, PLAYA)
        sin_asignar += 1
        ot = ots.setdefault(-nro, {
            "OTId": -nro,
            "NroMovVenta": nro,
            "Cliente": _txt(f.get("Cliente")),
            "Armador": SIN_ARMADOR,
            "Estado": "Sin OT",
            "Registrada": _registro_pedido(f.get("FechaPedido"), f.get("HoraRegistracion")),
            "Asignada": False,
            "SinOT": True,
            "Acopio": False,
            "_tier": 2,
            "_reng": {},
        })
        ot["_reng"][(cod, pos)] = ot["_reng"].get((cod, pos), 0.0) + pend

    info_art = {k.upper(): v for k, v in (_info_articulos(codigos) if codigos else {}).items()}

    # Reparto FIFO: la OT más vieja tiene prioridad sobre la misma posición. Si
    # dos OT se pelean 80 unidades pidiendo 60 y 50, la primera se lleva las 60
    # y sólo la segunda queda corta — marcar a las DOS contaría el faltante dos
    # veces (serían 60 a reponer cuando en realidad faltan 30). Lo mismo con el
    # stock de guardado y con la reposición en camino, que también son un pozo
    # compartido entre OT.
    orden_fifo = sorted(
        ots.values(),
        key=lambda o: (o["_tier"], str(o["Registrada"] or ""), abs(o["OTId"])),
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
            a_reponer_bruto = max(0.0, pedido - disp)
            en_camino = libre_repo.get(k, repo.get(k, 0.0))
            en_guard = libre_guard.get(cod, guardado.get(cod, 0.0))
            en_pulmon = pulmon.get(cod, 0.0)
            es_playa = pos.upper() == PLAYA
            # Ya no se genera (sin estante → PLAYA); queda por compatibilidad.
            sin_pos = pos.upper() == SIN_POSICION

            # Lo que ya viene en camino (una OT de reposición viva hacia esta
            # MISMA posición — armada desde este widget o a mano) se resta del
            # faltante ANTES de mirar guardado. Sin esto, un faltante de 50 con
            # una OT de reposición ya pedida por 30 seguía avisando "faltan 50"
            # en vez de "faltan 20", y "armar OT" de nuevo volvía a pedir las 50
            # enteras — duplicando lo que ya se sacó de guardado.
            cubierto_en_camino = 0.0 if sin_pos else min(a_reponer_bruto, en_camino)
            libre_repo[k] = max(0.0, en_camino - cubierto_en_camino)
            a_reponer = max(0.0, a_reponer_bruto - cubierto_en_camino)

            if a_reponer_bruto <= 0:
                sit = "ok"
            elif a_reponer <= 0:
                # la reposición en camino ya cubre TODO el faltante restante.
                sit = "repo_pedida"
            elif en_guard >= a_reponer and not sin_pos:
                sit = "reponer"
                libre_guard[cod] = max(0.0, en_guard - a_reponer)
            else:
                sit = "faltante"

            # Sin nada para bajar al estante el aviso no sirve: el que repone no
            # puede hacer nada. Se marca y se saca de la vista por pasillo (el
            # widget), no del detalle por OT. La playa se repone como cualquier
            # otra posición de picking.
            sin_repo = sit == "faltante" and (
                sin_pos or (en_guard <= 0 and en_camino <= 0)
            )
            if sit != "ok":
                problemas += 1
                tot[sit] += 1
                if sin_repo:
                    tot_sin_repo += 1

            pas = pasillo_de(pos)
            e = por_art.setdefault((pas, cod), {
                "ots": set(), "sin_asignar": set(), "operarios": set(),
                "pedido": 0.0, "reponer": 0.0,
                "hay": {}, "sit": "ok", "posiciones": set(), "sin_repo": True,
                "detalle": {},
            })
            e["ots"].add(ot["OTId"])
            if not ot["Asignada"]:
                e["sin_asignar"].add(ot["OTId"])
            e["operarios"].add(ot["Armador"])
            e["pedido"] += pedido
            e["reponer"] += a_reponer
            e["hay"][pos] = en_pos
            e["posiciones"].add(pos)
            # Qué pedido pide cuánto de este artículo (click en la columna OT
            # del widget). Se suma por OT: una OT con el mismo artículo en dos
            # posiciones del mismo pasillo es una sola línea. El dict conserva
            # el orden del recorrido, así que sale en orden FIFO — el primero es
            # el que se lleva el estante y los de abajo son los que quedan cortos.
            d = e["detalle"].setdefault(ot["OTId"], {
                "OTId":        None if ot["SinOT"] else ot["OTId"],
                "NroMovVenta": ot["NroMovVenta"],
                "Cliente":     ot["Cliente"],
                "Armador":     "" if not ot["Asignada"] else _nombre_operario(ot["Armador"]),
                "SinOT":       ot["SinOT"],
                "Cantidad":    0.0,
                "Falta":       0.0,
            })
            d["Cantidad"] += pedido
            d["Falta"] += a_reponer
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
                "SinPosicion": sin_pos,
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
            "Asignada":    ot["Asignada"],
            "SinOT":       ot["SinOT"],
            "Acopio":      ot["Acopio"],
            "Registrada":  ot["Registrada"].isoformat(sep=" ", timespec="minutes")
                           if hasattr(ot["Registrada"], "isoformat") else _txt(ot["Registrada"]),
            "Renglones":   len(ot["_reng"]),
            "ConProblema": problemas,
            "Faltantes":   sum(1 for x in filas if x["Situacion"] == "faltante"),
            "rows":        filas,
        })

    salida.sort(key=lambda o: (-o["Faltantes"], -o["ConProblema"], o["OTId"]))

    # Vista por pasillo = orden de trabajo del repositor: lo que no se puede
    # reponer (nada en el depósito central) no entra. La playa sí: es su
    # propio grupo PLAYA_PEDIDOS, al final.
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
            # de esas, cuántas todavía no tienen armador (u OT): el faltante
            # que se va a dar cuando se asignen.
            "SinAsignar":  len(e["sin_asignar"]),
            "Operarios":   operarios,
            "Hay":         _r3(sum(e["hay"].values())),
            "Pedido":      _r3(e["pedido"]),
            "AReponer":    _r3(e["reponer"]),
            "Posiciones":  sorted(e["posiciones"]),
            "Situacion":   e["sit"],
            "Detalle": [
                dict(d, Cantidad=_r3(d["Cantidad"]), Falta=_r3(d["Falta"]))
                for d in e["detalle"].values()
            ],
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
            "otsVivas":        sum(1 for o in ots.values() if not o["SinOT"]),
            "otsAsignadas":    sum(1 for o in ots.values() if o["Asignada"]),
            "otsSinAsignar":   sum(1 for o in ots.values() if not o["Asignada"] and not o["SinOT"]),
            "pedidosSinOT":    sum(1 for o in ots.values() if o["SinOT"]),
            "vueltasAcopio":   sum(1 for o in ots.values() if o["Acopio"]),
            "otsConProblema":  len(salida),
            "faltanteReal":    tot["faltante"],
            "faltanteSinRepo": tot_sin_repo,
            "hayParaReponer":  tot["reponer"],
            "repoPedida":      tot["repo_pedida"],
            "articulosOcultosSinRepo": ocultos_sin_repo,
            "renglonesDescartados": descartadas,
            # Renglones dejados afuera por operario ignorado (el buzón de
            # mercadería y los de OPERARIOS_IGNORADOS). Se mantiene el nombre
            # del campo: es el que ya lee la vista web.
            "renglonesEsperaMercaderia": espera_merca,
            # Renglones de pedidos todavía sin armador (OT sin asignar o sin
            # OT). Desde 2026-09-23 ENTRAN en el cálculo, en el último escalón
            # del FIFO; el contador queda para mostrar cuánto es anticipado.
            "renglonesSinAsignar": sin_asignar,
            "renglonesAcopioSinRemito": acopio_sin_remito,
            "renglonesAcopioFueraVentana": acopio_fuera_ventana,
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
