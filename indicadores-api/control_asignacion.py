"""
Cola de asignación de pedidos — widget de Mesa de Control (
2026-07-29). Reemplaza el input manual de "Nro Pedido" del widget por un
botón "Asignar": en vez de tipear el pedido a mano, el operario reclama el
próximo pedido de una cola armada con el cruce:

    Abierto en Magnus (EVERWEAR.dbo.TMP_TiempoDePedidos.Estado = 'Abierto',
    cruzado por NroMovVenta contra VenFer_PedidoCabecera solo para traer
    FechaPedido/TipoPedido/Cliente — ver FIX 2026-07-31 más abajo)
        ∩
    Cumplido en WMS: la OT de Picking MÁS RECIENTE del pedido (mayor OTId)
    está en OTEstado=2 — ver FIX 2026-08-03 más abajo (no alcanza con que
    EXISTA alguna OT vieja Cumplida)

cruzados por NroMovVenta ("número de movimiento", mismo campo que ya usa
fetch_pedido_lookup en errores_mesa.py vía OT.{OT_COL_PEDIDO}).

FIX 2026-07-29 (mismo día, tras deploy): el cruce arrancaba por WMS — traía
los últimos `limit` (500) OT Cumplidas por fecha, acotadas además a los
últimos 60 días (CONTROL_ASIGNACION_VENTANA_DIAS), y recién ahí filtraba
contra Magnus. Un pedido Abierto en Magnus cuyo picking se cumplió hace más
de 60 días (o que no entraba en el top-500 más reciente) quedaba afuera sin
que hubiera ningún error — resultado: "No hay pedidos disponibles para
asignar" con pedidos que sí correspondían. Se invirtió el orden: ahora se
arranca por TODOS los Abiertos de Magnus (universo naturalmente acotado —
son los pedidos activos, no el historial de OTs) y se filtra ese conjunto
contra WMS por NroMovVenta puntual, sin ventana de fecha ni límite de
"últimos N". La intersección resultante es la misma; solo cambió qué lado
maneja el volumen.

Tabla: deposito.control_asignacion (ver ever/sql/deposito_control_asignacion.sql
— correr ANTES de deployar este módulo).

ORDEN de la cola (cambiado 2026-08-03): "prioridad"
ascendente y, dentro de cada prioridad, fecha ascendente (más viejo primero)
— la idea es vaciar todos los atrasados de prioridad 1 hasta ponerse al día
y recién ahí pasar a prioridad 2, también de más viejo a más nuevo.
"prioridad" = `VenFer_PedidoCabecera.Prioridad` (Magnus; mismo campo que ya
usa `main.py` para el reporte "Por prioridad"), 1 = más urgente. Pedidos sin
prioridad cargada (NULL) se tratan como la prioridad más baja (van al final)
para no colarse adelante de los que sí tienen prioridad asignada — ver
COALESCE en SQL_MAGNUS_ABIERTOS_TODOS.
ANTES (hasta 2026-08-03) ordenaba por "nroPedido" ascendente, empate por
fecha descendente — se dejó de usar por pedido explícito de contaduría/mesa
de control.

CONCURRENCIA (pedido explícito: nunca asignar el mismo pedido a 2
operarios, van a ser muchos usando el widget a la vez): el reclamo es un
único UPDATE atómico con "SELECT ... FOR UPDATE SKIP LOCKED" (ver
asignar_siguiente) — 2 operarios apretando "Asignar" al mismo tiempo, incluso
en la misma fracción de segundo, siempre terminan con filas distintas. No
hace falta lockear la tabla entera ni coordinar nada del lado de la app.

UN PEDIDO POR OPERARIO A LA VEZ (2026-07-31): si vuelven a
apretar "Asignar" mientras su pedido anterior TODAVÍA no cerró en Magnus, NO
se les entrega uno nuevo — se les devuelve el mismo de siempre (mismo
nroPedido, misma fila). Solo cuando ese pedido está Cerrado (FechaCierre > 0
en VenFer_PedidoCabecera, ver _fetch_pedido_cerrado) el próximo click sí
reclama uno nuevo de la cola. Ver _fetch_asignacion_activa +
_fetch_pedido_cerrado, usados al principio de asignar_siguiente.

CODCLIENTE (mismo día): el cuadro grande del widget ahora
también muestra el número de cliente, no solo el nombre — se suma
`CodCliente` (VenFer_PedidoCabecera, mismo campo del JOIN contra
MAGNUS_SITD.dbo.Clientes que ya se usaba para el nombre) en todo el camino:
SQL_MAGNUS_ABIERTOS_TODOS -> fetch_pedidos_cumplidos_abiertos -> refrescar_cola
-> columna "codCliente" en deposito.control_asignacion (ALTER idempotente en
ever/sql/deposito_control_asignacion.sql, correr antes de deployar) ->
_fetch_asignacion_activa / asignar_siguiente. Sin verificar en vivo.

FIX 2026-08-03 (reportado en vivo): la cola traía pedidos
que WMS todavía no marca Cumplido. Causa: `SQL_WMS_CUMPLIDOS_POR_PEDIDO`
filtraba `OTEstado = 2` directo en el SQL — si un pedido tenía una OT vieja
ya Cumplida y una MÁS NUEVA sin terminar (repick/corrección tras un error),
la vieja igual matcheaba y el pedido se daba por listo. Fix: se trae TODA OT
de Picking del pedido (`SQL_WMS_OT_POR_PEDIDO`, sin filtrar OTEstado) y en
Python se elige la de mayor OTId (más reciente, mismo criterio que usa
`deposito.py`); el pedido solo cuenta como Cumplido si ESA está en
OTEstado=2. Sin verificar en vivo — falta rebuild indicadores-api.

FIX 2026-08-05 (cambio de criterio): el lado WMS del
cruce deja de ser "Cumplido" (OTEstado=2) — pasa a ser "el pedido tiene al
menos 1 renglón de su OT de Picking parado en la ubicación PLAYA_PEDIDOS"
(OTItem.OTItemUbicacionCodigo, confirmado por diagnóstico en vivo contra
WMS). El lado Magnus (Abierto, SQL_MAGNUS_ABIERTOS_TODOS) no cambió — sigue
siendo el universo base y la fuente de fecha/tipo/cliente/prioridad. Ver
SQL_WMS_PLAYA_PEDIDOS / fetch_pedidos_en_playa_pedidos (nuevas) y
refrescar_cola (ahora llama a la nueva función). La query/función vieja
("Cumplido") se deja intacta, sin usar, en
SQL_WMS_OT_POR_PEDIDO_LEGACY_CUMPLIDO / fetch_pedidos_cumplidos_abiertos_legacy
— pedido explícito de no perderla. Ojo: la columna correcta para ir
de OT a Magnus sigue siendo OT.OTNroMovVenta (constante OT_COL_PEDIDO en
deposito.py) — en el diagnóstico se probó por error OT.OTPedidoId primero,
que también existe pero es un ID compuesto interno de WMS (ej.
"MAGEW-738058-0-0-334695"), no el NroMovVenta de Magnus. Sin verificar en
vivo — falta rebuild indicadores-api.

FIX 2026-08-24 (reportado en vivo: la cola asignó el pedido 757536
con su OT 144356 todavía "En Proceso"): PLAYA_PEDIDOS solo NO alcanza. El
armador va dejando renglones en playa MIENTRAS pickea, así que el pedido
aparecía en la cola con el picking a medio hacer. El lado WMS pasa a exigir
las dos cosas: la OT de Picking MÁS RECIENTE del pedido tiene que estar
Cumplida (OTEstado = 2) Y tener algún renglón en PLAYA_PEDIDOS. No revierte
el FIX 2026-08-05, lo suma. Detalle importante del cómo (es la trampa del FIX
2026-08-03): ninguno de los dos filtros va en el WHERE — SQL_WMS_PLAYA_PEDIDOS
trae TODAS las OT de Picking del pedido con un flag EnPlaya y la decisión se
toma en Python sobre max(OTId), para que un repick nuevo En Proceso gane
siempre sobre una OT vieja Cumplida. Solo afecta a los pedidos NO acopio; el
camino de acopio (70/75) no toca WMS. Sin verificar en vivo — falta rebuild
indicadores-api.

FIX 2026-08-24, 2da vuelta del día (reportado en vivo: la cola le
asignó el 757555, ya FACTURADO). La causa NO era Facturado: era que
`TMP_TiempoDePedidos` —el universo entero de esta cola— es una FOTO que llena
SP_TiempoPedidos_Cargar, no el estado en vivo. El 757555 estaba EstadoPedido=4
(Cerrado), cerrado y controlado ese mismo día, y TMP seguía diciendo
'Abierto'. Medido sobre los 55 candidatos del día: 25 ya cerrados (los 25
facturados y controlados) + 6 anulados = 31 de 55 no tenían que estar.
El arreglo son DOS PIEZAS, porque el bug tiene dos mitades:
  1. Qué ENTRA: `cab.EstadoPedido = 2` en SQL_MAGNUS_ABIERTOS_TODOS (en vivo,
     contra Cabecera). Ver el comentario largo en esa query.
  2. Qué SE QUEDA: purgar_cola_obsoleta(), llamada desde refrescar_cola. Las
     filas entran con ON CONFLICT DO NOTHING y asignar_siguiente reparte con
     un `WHERE "asignadoEn" IS NULL` sin chequear nada contra Magnus, así que
     una fila que entró legítimamente y cuyo pedido cerró 3 días después se
     seguía entregando. Sin esta segunda mitad, el filtro de la pieza 1 no
     limpia nada de lo que ya está en la cola.
Sin verificar en vivo — falta rebuild indicadores-api.

FIX 2026-08-24, 3ra vuelta — EL CAMBIO GRANDE, y el que cierra el tema.
Con el filtro de arriba puesto, la cola quedó VACÍA mientras Magnus mostraba
22 pedidos "Armado finalizado listo para control". O sea: el problema nunca
fue solo que sobraran, también faltaban, y por la misma razón de fondo — el
universo estaba armado sobre dos señales que no significan lo que se creía:

  · 'PLAYA_PEDIDOS' en WMS: de los pedidos listos, UNO tenía un ítem ahí.
  · TMP_TiempoDePedidos: ni siquiera contiene los pedidos del día.

La señal real vive en Magnus y siempre estuvo: `Ven_PedImpresoCA` con
`ObsArmadorMovil` cargada = el armador terminó y anotó dónde dejó el pedido.
Verificado 22/22 contra la pantalla de Magnus y la base al mismo tiempo, sin
falsos positivos. Ver SQL_MAGNUS_LISTOS_PARA_CONTROL /
fetch_pedidos_listos_para_control para el detalle y las reglas descartadas.
WMS pasa a ser opcional: solo resuelve el NOMBRE del armador.
Sin verificar en vivo — falta rebuild indicadores-api.

ACOPIO 70/75 — LA UNIDAD DE CONTROL ES LA VUELTA, NO EL PEDIDO
(2026-08-21; cierra el problema que venía dando vueltas
desde el FIX 2026-08-04 y el FIX 2026-08-18 de más arriba).

El bug de diseño: un acopio queda `EstadoPedido = 2` (Abierto) DURANTE MESES
—no cierra hasta que se entregó el 100% o se anuló— y este módulo libera al
operario cuando el PEDIDO cierra en Magnus (`_fetch_pedido_cerrado`). Con un
acopio asignado, ese gate no se cumplía nunca: el operario quedaba trabado y
"Asignar" le devolvía siempre el mismo pedido. Los parches anteriores
(excluir 70/75 de la cola; después dejar entrar 70 solo con Prioridad 1/3)
esquivaban el síntoma sin tocar la causa.

La causa es la unidad. Cada vuelta del acopio es 1 OT1PIC de WMS = 1 REMITO
de Magnus (`VenFer_RmtoCabecera`, `CompCodigo = 71`, `NroMovPedido` = el
pedido; son 1 a 1). Las tres fechas del remito SON el circuito:

    FechaArmado  + UsuarioArmado -> terminó de preparar (armador real)
    FechaCierre  + UsuarioCierre -> PASÓ POR MESA DE CONTROL
    FechaEnvio                   -> salió al cliente

`Gen_Usuarios` 174 = "MESA CONTROL 1", 175 = "MESA CONTROL 2", 214 =
"MESA CONTROL 3" — son PUESTOS, no personas, y aparecen SOLO en
`UsuarioCierre`. O sea: el control de acopio SIEMPRE estuvo registrado, en el
remito. En acopio la mesa NO escribe en `Ven_PedImpresoCP` (por eso
consulta_tandas_control_cod70.py daba 0 filas ahí y se concluyó, mal, que
"no hay señal de control"; en cod.10 es al revés — el remito nunca trae
FechaArmado).

Entonces:
  · La cola guarda una fila POR VUELTA para acopio (columna "nroRemito" > 0)
    y una fila POR PEDIDO para todo lo demás ("nroRemito" = 0). Unicidad
    ("nroPedido", "nroRemito") — ver ever/sql/deposito_control_asignacion.sql,
    CORRER ESE ALTER ANTES DE REBUILDEAR.
  · El lado WMS NO se usa para acopio: `FechaArmado > 0` en el remito ya es
    "terminó de preparar", que es lo mismo que buscaba el cruce contra
    PLAYA_PEDIDOS, y evita el bug de `CodotProcesoNegocio` (esa columna vive
    en `Codot`, no en `OT`).
  · El gate de liberación se elige por fila (`_fetch_asignacion_cerrada`):
    remito -> `VenFer_RmtoCabecera.FechaCierre > 0` (lo que escribe mesa);
    pedido -> `_fetch_pedido_cerrado` de siempre, sin cambios.
  · Se descarta el criterio "solo Prioridad 1/3" del FIX 2026-08-18: era un
    workaround de esto mismo. Ahora entran TODOS los acopios, por vuelta.

QUEDAN AFUERA (si no, vuelven a trabar el puesto): remitos sin renglones y
`EstadoRemito = 3` (borrador sin emitir = vuelta que fue a buscar y no había
nada) — no van a pasar por mesa nunca. Y `EstadoRemito = 4` = anulado.

FIX 2026-08-21 (aparte, latente): `SQL_MAGNUS_ABIERTOS_TODOS` no traía
`CodCliente` pero `refrescar_cola` insertaba `c["codCliente"]` — KeyError en
cada refresco. Se agrega la columna al SELECT y al dict de salida de las dos
funciones que la usan. Venía roto desde el alta de codCliente (2026-07-31).

CompCodigo 410 (2026-08-25: "agregá los 410, que no se
retiren y ponelos primero que todo sin importar prioridad"): el 410
(PED.NF.CEN, "pedido no facturable de centro") vuelve a la whitelist de
`SQL_MAGNUS_LISTOS_PARA_CONTROL` — revierte la decisión del 2026-08-24 de
dejarlo afuera — y encabeza la cola por encima de la afinidad y de la
prioridad. Para poder ordenar por eso se guarda `CompCodigo` en la cola:
columna nueva "compCodigo" (ALTER idempotente en
ever/sql/deposito_control_asignacion.sql, CORRER ANTES DE DEPLOYAR — sin ella
el INSERT de refrescar_cola falla). Filas viejas: "compCodigo" NULL, se
comportan como no-410. Sin verificar en vivo.

AFINIDAD POR CLIENTE (2026-08-25: "los 2 pedidos de MAGAL
que se los pase a la misma persona, uno detrás del otro"): `asignar_siguiente`
ordena AHORA primero por "es del mismo cliente que el último pedido que
reclamó ESE operario" y recién después por prioridad/fecha. La ventana está en
AFINIDAD_CLIENTE_HORAS (12 h): si el último reclamo es más viejo, no aplica.
Es preferencia, no filtro — si no hay otro pedido libre de ese cliente, sigue
el orden de siempre. Consecuencia buscada y aceptada: la afinidad pesa más que
la prioridad, así que un prioridad 1 puede esperar un turno. Sin verificar en
vivo — falta rebuild indicadores-api.

RESERVA POR CLIENTE (2026-09-23): la afinidad deja de ser preferencia y pasa a
ser regla — todas las unidades de un cliente (pedidos 10/100/210/310/410 y
vueltas de acopio 70/75) las controla el primero al que se le asignó una.
Tabla deposito.control_reserva_cliente; estados nuevo/tomado/espera; el widget
pregunta Tomar/Esperar cuando el cliente tiene unidades en preparación y
vuelve a preguntar cada vez que se suma una lista. Ver el bloque "RESERVA POR
CLIENTE" más abajo (evaluar_reservas, _reclamar, decidir_grupo, estado_grupos).
"""
from datetime import datetime, timedelta

from db import get_connection
from db_pg import get_pg_connection
from deposito import OT_COL_PEDIDO
from errores_mesa import fetch_operario_nombre, _col_observaciones_ot, BASE_DATE

# Tope de seguridad: cuántos pedidos Abiertos de Magnus se consideran como
# máximo en un solo refresco de la cola (ordenados Prioridad ASC, fecha ASC —
# mismo criterio que el ORDER BY de asignar_siguiente, así que un recorte
# acá nunca deja afuera al que le tocaría el turno).
# Ajustable sin tocar el resto de la lógica.
MAGNUS_ABIERTOS_LIMIT = 3000

# AFINIDAD POR CLIENTE (2026-08-25): ventana hacia atrás en
# la que se mira el ÚLTIMO pedido que reclamó el operario para tratar de darle
# otro del MISMO cliente. Fuera de esta ventana (arrancó otro turno, volvió al
# otro día) la afinidad no aplica y el orden es el de siempre.
AFINIDAD_CLIENTE_HORAS = 12


# ── Magnus: TODOS los pedidos Abiertos (fecha/tipo/cliente) — universo base ──
# FIX 2026-07-31 (tras diagnóstico en vivo): la versión
# original filtraba "Abierto" vía VenFer_PedidoCabecera.EstadoPedido -> JOIN
# Pedido_Estados.Ped_EstadoDescripcion. Esa fuente ya se había detectado rota
# el 2026-07-23 en deposito.py (fetch_pedidos_hora / "Abiertos ahora": ver
# comentario ahí, "subcontaba"/quedaba plana) y se reemplazó en TODO el resto
# del proyecto por EVERWEAR.dbo.TMP_TiempoDePedidos.Estado = 'Abierto' (la
# misma tabla que llena SP_TiempoPedidos_Cargar y que ya usa la pestaña
# "Tiempo de Pedidos" + fetch_abiertos_ahora). Este módulo, escrito 6 días
# después, reintrodujo el patrón viejo sin saberlo — en vivo daba
# TOTAL ABIERTOS: 0 (el join contra Pedido_Estados no matcheaba ninguna fila),
# así que la cola de asignación nunca tenía candidatos. Se corrige acá al
# mismo criterio ya probado (TMP_TiempoDePedidos), manteniendo
# FechaPedido/TipoPedido/Cliente desde Cabecera para no tocar el resto del
# módulo.
SQL_MAGNUS_ABIERTOS_TODOS = """
SELECT TOP ({limit})
    cab.NroMovVenta,
    cab.FechaPedido,
    cc.DetalleCorto     AS TipoPedido,
    cli.Cliente_Nombre  AS Cliente,
    cab.CodCliente      AS CodCliente,
    cab.Prioridad       AS Prioridad
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
INNER JOIN EVERWEAR.dbo.TMP_TiempoDePedidos   t   ON t.NroMovVenta   = cab.NroMovVenta
LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante cc  ON cab.CompCodigo   = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Clientes           cli ON cab.CodCliente   = cli.CodCliente
WHERE t.Estado = 'Abierto'
  AND cab.EstadoPedido = 2
  -- FIX 2026-08-24, 2da vuelta del día (reportado en vivo: la cola
  -- le asignó el pedido 757555, que en Magnus ya estaba FACTURADO). Causa
  -- real: `TMP_TiempoDePedidos` NO es el estado en vivo, es una foto que
  -- llena SP_TiempoPedidos_Cargar cada tanto. El 757555 tenía
  -- EstadoPedido = 4 (Cerrado), FechaCierre = 82419 (24/08, ese mismo día) y
  -- control de Rios Ivan en Ven_PedImpresoCP, pero TMP seguía diciendo
  -- 'Abierto' -> volvía a la cola. Los 2 gates de WMS no lo frenan porque el
  -- pedido efectivamente se pickeó y quedó en playa.
  --   Medido el 2026-08-24 (vicki/diag_asignacion_estado.py), sobre los 55
  --   que TMP daba por Abiertos:
  --       EstadoPedido = 2 (Abierto)  -> 24 |  0 facturados |  3 con control
  --       EstadoPedido = 4 (Cerrado)  -> 25 | 25 facturados | 25 con control
  --       EstadoPedido = 7 (Anulado)  ->  6 |  0 facturados |  1 con control
  --   O sea: 31 de 55 no tenían que estar, y los 25 cerrados YA habían pasado
  --   por mesa (100%). `VenFer_PedidoCabecera.EstadoPedido` sí es en vivo
  --   (2 Abierto · 4 Cerrado · 7 Anulado) — el JOIN roto que motivó el
  --   FIX 2026-07-31 era contra `Pedido_Estados`, NO esta columna.
  -- Se DEJA el INNER JOIN a TMP a propósito: es el conjunto de trabajo que ya
  -- mantiene el ERP y acota el universo. Sacarlo abriría todo el histórico de
  -- pedidos que nunca cerraron.
  -- NO se filtra por control registrado (Ven_PedImpresoCP): de los 24
  -- Abiertos de verdad solo 2 ya tenían control y los 2 quedaban afuera igual
  -- por el gate de WMS. Y filtrar por control rompería el REPICK (pedido que
  -- vuelve a pickearse tras un error de mesa y necesita control de nuevo):
  -- FechaControl es DATE, no datetime, así que un repick del mismo día es
  -- indistinguible de un control ya hecho. Ver docstring de
  -- purgar_cola_obsoleta para el otro lado del mismo bug.
  AND (
        cab.CompCodigo IN (10, 100, 210, 310)  -- ACOPIO: 70 y 75 NO entran
        -- por acá. Desde 2026-08-21 tienen su propia query, por vuelta:
        -- SQL_MAGNUS_ACOPIO_ESPERA_CONTROL. El criterio "70 solo Prioridad
        -- 1/3" del FIX 2026-08-18 queda DESCARTADO (era un workaround de que
        -- el pedido de acopio no cierra nunca) — ver docstring del módulo.
        -- FIX 2026-08-04: antes era NOT IN (70) — dejaba pasar Factura Directa
        -- (107/1107/1207/170/207/47/7) a la cola del widget de errores-mesa.
        -- Whitelist explícita, solo para esta cola: Pedido Mayorista (10),
        -- Pedido Mayorista Mostradores (100), Pedido Móvil (210), Pedido Web
        -- (310). Acota mucho más que antes (ya no solo excluye acopios) —
        -- este criterio es EXCLUSIVO de esta cola, no tocar las demás
        -- queries de "Abiertos" del proyecto (deposito.py, etc.).
        -- FIX 2026-08-18 (dato confirmado por él): acopio
        -- (CompCodigo=70) vuelve a esta cola, pero SOLO Prioridad 1 y 3. El
        -- resto de las prioridades de acopio se entregan de a poco durante
        -- varios meses (una OT de Picking nueva por cada tanda que llega) y
        -- NO tienen ninguna señal en Magnus/WMS de "esta tanda ya se
        -- controló" — confirmado corriendo consulta_tandas_control_cod70.py
        -- contra 8 pedidos cod.70 con 4 a 10 OT de Picking cada uno a lo
        -- largo de varios meses: Ven_PedImpresoCP (Mesa de Control) da 0
        -- filas en los 8, o sea el control de Magnus no se usa para esas
        -- prioridades. Prioridad 1/3 quedan afuera de ese patrón (dato) y sí pueden entrar a la cola con el mismo criterio
        -- Abierto+Cumplido que el resto de los tipos de pedido.
      )
ORDER BY COALESCE(cab.Prioridad, 999) ASC, cab.FechaPedido ASC
-- 2026-08-03: prioridad ASC (1 = más urgente) y, dentro
-- de cada prioridad, fecha ASC (más viejo primero) — vaciar los atrasados de
-- prioridad 1 hasta ponerse al día antes de pasar a prioridad 2. Antes era
-- NroMovVenta ASC. Sin Prioridad cargada -> 999, al final de la cola.
"""
# SELECT TOP ({limit})
#     cab.NroMovVenta,
#     cab.FechaPedido,
#     cc.DetalleCorto     AS TipoPedido,
#     cli.Cliente_Nombre  AS Cliente,
#     cab.Prioridad       AS Prioridad
# FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
# INNER JOIN EVERWEAR.dbo.TMP_TiempoDePedidos   t   ON t.NroMovVenta   = cab.NroMovVenta
# LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante cc  ON cab.CompCodigo   = cc.CompCodigo
# LEFT JOIN MAGNUS_SITD.dbo.Clientes           cli ON cab.CodCliente   = cli.CodCliente
# WHERE t.Estado = 'Abierto'
#   AND (
#         cab.CompCodigo IN (10, 75, 100, 210, 310)  -- FIX 2026-08-04: antes era NOT IN (70) — dejaba pasar Factura Directa
#         -- (107/1107/1207/170/207/47/7) a la cola del widget de errores-mesa.
#         -- Whitelist explícita, solo para esta cola: Pedido Mayorista (10),
#         -- Pedido Mayorista Mostradores (100), Pedido Móvil (210), Pedido Web
#         -- (310). Acota mucho más que antes (ya no solo excluye acopios) —
#         -- este criterio es EXCLUSIVO de esta cola, no tocar las demás
#         -- queries de "Abiertos" del proyecto (deposito.py, etc.).
#         OR (cab.CompCodigo = 70 AND cab.Prioridad IN (1, 3))
#         -- FIX 2026-08-18 (dato confirmado por él): acopio
#         -- (CompCodigo=70) vuelve a esta cola, pero SOLO Prioridad 1 y 3. El
#         -- resto de las prioridades de acopio se entregan de a poco durante
#         -- varios meses (una OT de Picking nueva por cada tanda que llega) y
#         -- NO tienen ninguna señal en Magnus/WMS de "esta tanda ya se
#         -- controló" — confirmado corriendo consulta_tandas_control_cod70.py
#         -- contra 8 pedidos cod.70 con 4 a 10 OT de Picking cada uno a lo
#         -- largo de varios meses: Ven_PedImpresoCP (Mesa de Control) da 0
#         -- filas en los 8, o sea el control de Magnus no se usa para esas
#         -- prioridades. Prioridad 1/3 quedan afuera de ese patrón (dato) y sí pueden entrar a la cola con el mismo criterio
#         -- Abierto+Cumplido que el resto de los tipos de pedido.
#       )
# ORDER BY COALESCE(cab.Prioridad, 999) ASC, cab.FechaPedido ASC
# -- 2026-08-03: prioridad ASC (1 = más urgente) y, dentro
# -- de cada prioridad, fecha ASC (más viejo primero) — vaciar los atrasados de
# -- prioridad 1 hasta ponerse al día antes de pasar a prioridad 2. Antes era
# -- NroMovVenta ASC. Sin Prioridad cargada -> 999, al final de la cola.

# ── WMS: de esos pedidos puntuales, TODAS sus OT de Picking (no solo las ────
# Cumplidas) — para poder quedarnos con la MÁS RECIENTE y recién ahí decidir
# si el pedido está Cumplido. FIX 2026-08-03 (reportado en
# vivo: la cola traía pedidos que WMS no marca Cumplido): antes esta query
# filtraba OTEstado=2 directo en SQL, así que si un pedido tenía una OT vieja
# Cumplida y una MÁS NUEVA todavía sin terminar (repick/corrección), la vieja
# igual matcheaba y el pedido entraba a la cola como si estuviera listo. Ver
# fetch_pedidos_cumplidos_abiertos: ahí se agrupa por pedido y se elige la OT
# de mayor OTId (mismo criterio "más reciente" que ya usa deposito.py,
# ORDER BY OT.OTId DESC) — el pedido solo cuenta como Cumplido si ESA es
# OTEstado=2.
#
# LEGACY (a partir de 2026-08-05, ver SQL_WMS_PLAYA_PEDIDOS más abajo): el criterio "Cumplido" se reemplazó por "está físicamente
# parado en la ubicación PLAYA_PEDIDOS" — refrescar_cola ya NO llama a
# fetch_pedidos_cumplidos_abiertos. Se deja el código acá sin tocar (no se
# borra) por si hace falta volver atrás o comparar.
SQL_WMS_OT_POR_PEDIDO_LEGACY_CUMPLIDO = """
SELECT
    OT.{col_pedido}            AS NroPedido,
    OT.OTId                    AS Ot,
    OT.OTEstado                AS OTEstado,
    OT.OTFechaHoraEjecucion    AS Cumplido,
    P_Repositor.PersonalId     AS NroArmador,
    P_Repositor.PersonalNombre AS NombreArmador{observ_select}
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
WHERE Codot.CodotProcesoNegocio = 4          -- Picking
  AND OT.{col_pedido} IN ({ph})
"""


# ── WMS: pedidos con al menos 1 renglón de la OT de Picking parado en la ────
# ubicación PLAYA_PEDIDOS (2026-08-05). Reemplaza el
# criterio "Cumplido" de arriba: la señal de "listo para Mesa de Control" ya
# no es el estado de la OT, es la ubicación física del pedido en WMS.
# Columna confirmada por diagnóstico en vivo: OTItem.OTItemUbicacionCodigo
# (NO OT.OTPedidoId/OT.OTObservaciones). El cruce con Magnus sigue siendo por
# {col_pedido} = OT_COL_PEDIDO = "OTNroMovVenta" (mismo campo ya confirmado y
# usado en TODO el resto del proyecto — errores_mesa.py, deposito.py — para
# ir de OT a VenFer_PedidoCabecera.NroMovVenta; OT.OTPedidoId es OTRA columna,
# con un ID compuesto tipo "MAGEW-738058-0-0-334695", no sirve para este
# cruce).
# FIX 2026-08-24 (reportado en vivo: la cola asignó el pedido 757536
# con su OT 144356 en "En Proceso" y Fin Picking 00:00:00). Estar parado en
# PLAYA_PEDIDOS NO alcanza: el armador deja renglones en playa MIENTRAS sigue
# pickeando, así que hay renglones en playa con la OT todavía En Proceso. El
# criterio vuelve a exigir CUMPLIDA (OTEstado = 2) **además** de estar en
# playa: es un AND con el FIX 2026-08-05, no un reemplazo.
#
# Ojo con el CÓMO, que es la trampa del FIX 2026-08-03: el filtro NO va en el
# WHERE. Si acá filtráramos OTEstado = 2, un pedido con una OT vieja Cumplida
# + un repick MÁS NUEVO En Proceso volvería a colarse (la vieja sobrevive al
# filtro y pasa a ser "la más reciente"). Por eso la query trae TODAS las OT de
# Picking del pedido —con y sin renglones en playa— marcando cuáles están en
# playa (EnPlaya), y la decisión ("la más reciente tiene que estar Cumplida Y
# en playa") se toma en Python sobre max(OTId). Por lo mismo se saca el INNER
# JOIN a OTItem: filtraba las OT sin playa, y la OT nueva En Proceso ni
# siquiera aparecía para ganar el max(OTId).
SQL_WMS_PLAYA_PEDIDOS = """
SELECT
    OT.{col_pedido}            AS NroPedido,
    OT.OTId                    AS Ot,
    OT.OTEstado                AS OTEstado,
    OT.OTFechaHoraEjecucion    AS Cumplido,
    P_Repositor.PersonalId     AS NroArmador,
    P_Repositor.PersonalNombre AS NombreArmador,
    CASE WHEN EXISTS (
        SELECT 1 FROM OTItem i
        WHERE i.OTId = OT.OTId
          AND i.OTItemUbicacionCodigo = 'PLAYA_PEDIDOS'
    ) THEN 1 ELSE 0 END        AS EnPlaya
FROM OT
INNER JOIN Codot ON OT.CodotCodigo = Codot.CodotCodigo
LEFT JOIN Personal P_Repositor ON OT.OTUsuarioGUID_Repositor = P_Repositor.PersonalId
WHERE Codot.CodotProcesoNegocio = 4          -- Picking
  AND OT.{col_pedido} IN ({ph})
"""


def fetch_pedidos_cumplidos_abiertos_legacy(limit: int = MAGNUS_ABIERTOS_LIMIT) -> list[dict]:
    """Cruce Abierto(Magnus) ∩ Cumplido(WMS) por NroMovVenta. Cada dict trae
    nroPedido/fecha/tipoPedido/cliente/ubicacion/ot/nroArmador/nombreArmador
    — mismos campos que usa deposito.control_asignacion.

    Arranca por Magnus (TODOS los Abiertos, hasta `limit`, prioridad ASC/
    fecha ASC) y recién ahí consulta WMS puntualmente por esos NroMovVenta — sin ventana
    de fecha. Antes era al revés (WMS primero, acotado a los últimos 500
    Cumplidos de los últimos 60 días) y dejaba afuera Abiertos con picking
    cumplido hace rato; ver nota "FIX 2026-07-29" en el docstring del módulo."""
    conn = get_connection("EVERWEAR")
    abiertos: dict[int, dict] = {}
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_MAGNUS_ABIERTOS_TODOS.format(limit=limit))
        for nro, fecha_int, tipo_pedido, cliente, cod_cliente, prioridad in cur.fetchall():
            if nro is None:
                continue
            # BASE_DATE ya es un datetime.date (ver errores_mesa.py) — sumarle
            # un timedelta da otro date, no hace falta (ni se puede) llamar
            # .date() de nuevo. FIX 2026-07-31: este bug estaba latente desde
            # el 2026-07-29 (nunca se disparaba porque el filtro de Abierto
            # de más arriba siempre devolvía 0 filas antes del fix de hoy).
            fecha = (BASE_DATE + timedelta(days=int(fecha_int))) if fecha_int else None
            abiertos[int(nro)] = {
                "fecha": fecha,
                "tipoPedido": (tipo_pedido or "").strip() or None,
                "cliente": (cliente or "").strip() or None,
                # FIX 2026-08-21: faltaba y refrescar_cola lo insertaba igual.
                "codCliente": int(cod_cliente) if cod_cliente is not None else None,
                # Orden de la cola (2026-08-03) — ver
                # SQL_MAGNUS_ABIERTOS_TODOS. None = sin prioridad cargada.
                "prioridad": int(prioridad) if prioridad is not None else None,
            }
    finally:
        conn.close()

    if not abiertos:
        return []

    conn = get_connection("WMS")
    wms: dict[int, dict] = {}
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        observ_col = _col_observaciones_ot(conn)
        observ_select = f", OT.{observ_col} AS Ubicacion" if observ_col else ""
        nros = list(abiertos.keys())
        CH = 1000
        for i in range(0, len(nros), CH):
            chunk = nros[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            cur.execute(
                SQL_WMS_OT_POR_PEDIDO_LEGACY_CUMPLIDO.format(
                    col_pedido=OT_COL_PEDIDO, observ_select=observ_select, ph=ph,
                ),
                chunk,
            )
            cols = [c[0] for c in cur.description]
            for row in cur.fetchall():
                d = dict(zip(cols, row))
                nro = d.get("NroPedido")
                ot_id = d.get("Ot")
                if nro is None or ot_id is None:
                    continue
                n = int(nro)
                prev = wms.get(n)
                # Nos quedamos con la OT de Picking de MAYOR OTId (la más
                # reciente), sea Cumplida o no — así, si el pedido tiene una
                # OT nueva todavía sin terminar, esa manda y no una vieja ya
                # Cumplida (ver nota FIX 2026-08-03 junto a la query).
                if prev is None or int(ot_id) > prev["ot"]:
                    ubic = d.get("Ubicacion")
                    wms[n] = {
                        "ot": int(ot_id),
                        "otEstado": int(d["OTEstado"]) if d.get("OTEstado") is not None else None,
                        "nroArmador": int(d["NroArmador"]) if d.get("NroArmador") is not None else None,
                        "nombreArmador": (d.get("NombreArmador") or "").strip() or None,
                        "ubicacion": (str(ubic).strip() or None) if ubic is not None else None,
                    }
    finally:
        conn.close()

    out: list[dict] = []
    for nro, ab in abiertos.items():
        w = wms.get(nro)
        if w is None or w.get("otEstado") != 2:
            # Sin OT de Picking, o la más reciente todavía no está Cumplida
            # (OTEstado=2) — no está lista para controlar.
            continue
        out.append({
            "nroPedido": nro,
            "fecha": ab["fecha"],
            "tipoPedido": ab["tipoPedido"],
            "cliente": ab["cliente"],
            "codCliente": ab["codCliente"],
            "prioridad": ab["prioridad"],
            "nroRemito": 0,          # fila "por pedido" (ver docstring: acopio va por vuelta)
            "ubicacion": w["ubicacion"],
            "ot": w["ot"],
            "nroArmador": w["nroArmador"],
            "nombreArmador": w["nombreArmador"],
        })
    return out


# ══════════════════════════════════════════════════════════════════════════
# EL GATE BUENO — "listo para control" = el armador dejó escrita la UBICACIÓN
# ══════════════════════════════════════════════════════════════════════════
# FIX 2026-08-24, 3ra vuelta del día. Reemplaza TODO el cruce contra WMS
# (SQL_MAGNUS_ABIERTOS_TODOS + SQL_WMS_PLAYA_PEDIDOS) como criterio de entrada
# a la cola. Las dos señales que se usaban quedan DESCARTADAS con datos:
#
#   1. `OTItem.OTItemUbicacionCodigo = 'PLAYA_PEDIDOS'` (FIX 2026-08-05).
#      De los pedidos que Magnus daba por listos, UNO SOLO tenía un ítem ahí.
#      El resto estaba en '0003' o en el hueco concreto ('01-16-10-C',
#      '01-16-07-M', 'Est 1 14'). La playa física existe, pero WMS guarda el
#      hueco, no el literal — el gate miraba un string que casi nunca aparece.
#      Este es el filtro que dejó la cola VACÍA con 22 pedidos esperando mesa.
#
#   2. `INNER JOIN TMP_TiempoDePedidos` (FIX 2026-07-31). Peor que estar
#      atrasada: NO TIENE los pedidos del día. Con el INNER JOIN, un pedido
#      armado hoy no puede entrar a la cola nunca. Ver docstring del módulo.
#
# La señal real: **`Ven_PedImpresoCA.ObsArmadorMovil`**. El armador escribe
# ahí la ubicación física donde dejó el pedido CUANDO TERMINA DE ARMARLO. Ese
# campo ES "armado finalizado listo para control" (el círculo gris de la
# pantalla "Armar Pedidos" de Magnus).
#
# Verificado 2026-08-24 contra la pantalla de Magnus y la base al mismo
# tiempo: **22 de 22**, sin un solo falso positivo ni falso negativo. Lo único
# que Magnus lista y esta query no era el pedido 757707, CompCodigo 410
# (PED.NF.CEN) — quedaba afuera por la whitelist de comprobantes, no por el
# gate. DESDE 2026-08-25 el 410 también entra (y va primero de todo), así que
# la query y esa pantalla muestran exactamente lo mismo.
#
# Reglas que se probaron y NO sirven (mismo run):
#   · `cab.FechaArmado > 0`      -> deja entrar 37 de más, incluida la basura
#     vieja de Prioridad 9 (METALFOR y cía, pedidos de 2024 todavía abiertos).
#   · `Ven_PedImpresoCA.Estado = 1` / `FechaFin > 0` -> casi siempre en 0, no
#     se usan en la práctica.
#   · `cab.Impreso = 1`          -> 2 de 22.
#
# "ALGUNA fila con ubicación", no "todas": un pedido puede tener más de un
# centro de preparación (`CodCentroPrep` 1 y 2) y el CP2 NUNCA escribe
# ObsArmadorMovil (verificado 2026-09-23 en todos los CA de CP2), así que
# exigir ubicación en todas las filas perdía los pedidos con CP2.
#
# CAMBIO 2026-09-23 — GATE POR CENTRO: con "alguna fila" alcanzaba que
# terminara CP1 para que el pedido entrara a la cola aunque CP2 siguiera sin
# preparar; mesa no lo puede cerrar hasta que llegue lo de CP2 (casos 761948
# y 762126: CP1 con ubicación, CP2 con FechaFin = 0 y sin tanda). Ahora, además
# de la fila con ubicación, CADA centro que tenga renglones no anulados del
# pedido tiene que estar terminado: una fila de Ven_PedImpresoCA de ESE
# centro con ubicación cargada o con FechaFin > 0 (la señal de fin del CP2;
# coincide con la FechaDesde de su tanda en VenFer_PedidoRengPreparacion).
# Centro sin fila CA (no se mandó a preparar) = espera. Ver
# _SQL_GATE_CENTROS; se aplica también en la purga (SQL_PEDIDOS_YA_NO_VAN)
# para sacar lo que ya estaba en la cola con un centro pendiente.
# Medido 2026-09-23 sobre los 8 candidatos del momento: quedan en espera
# exactamente 761948 y 762126; 753015 (CP2 terminado) sigue entrando.
# Seeks: VenFer_PedidoReng clustered (NroMovVenta, NroRenglon) y
# Ven_PedImpresoCA clustered (NroMovVenta, CodCentroPrep, NroCentroArmado).
#
# De regalo, Ven_PedImpresoCA es el puente Magnus<->WMS que ya existía:
#   ObsArmadorMovil  -> la ubicación que el widget muestra (antes salía de
#                       OTItem, con el problema de arriba)
#   WMS_NroOTPicking -> el OTId de WMS, sin cruzar por OTNroMovVenta
#   CodArmador       -> el armador según Magnus
# Misma lección que el acopio 70/75: el circuito YA estaba registrado en
# Magnus; el cruce contra WMS era el rodeo.
# Pedido con algún centro de preparación todavía sin terminar. Se usa con
# NOT EXISTS (cola) y con EXISTS (purga). {nro} = expresión del NroMovVenta.
_SQL_GATE_CENTROS = """
    SELECT 1
    FROM EVERWEAR.dbo.VenFer_PedidoReng r
    WHERE r.NroMovVenta = {nro}
      AND r.CodCentroPrep > 0
      AND r.Estado <> 4
      AND NOT EXISTS (
            SELECT 1
            FROM EVERWEAR.dbo.Ven_PedImpresoCA c
            WHERE c.NroMovVenta   = r.NroMovVenta
              AND c.CodCentroPrep = r.CodCentroPrep
              AND (LTRIM(RTRIM(ISNULL(c.ObsArmadorMovil, ''))) <> ''
                   OR ISNULL(c.FechaFin, 0) > 0)
          )
"""

SQL_MAGNUS_LISTOS_PARA_CONTROL = """
SELECT TOP ({limit})
    cab.NroMovVenta,
    cab.FechaPedido,
    cc.DetalleCorto     AS TipoPedido,
    cli.Cliente_Nombre  AS Cliente,
    cab.CodCliente      AS CodCliente,
    cab.Prioridad       AS Prioridad,
    ca.ObsArmadorMovil  AS Ubicacion,
    ca.WMS_NroOTPicking AS Ot,
    ca.CodArmador       AS CodArmador,
    cab.CompCodigo      AS CompCodigo
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
INNER JOIN (
    -- 1 fila por pedido: la asignación de armado MÁS RECIENTE que tenga
    -- ubicación cargada. Con 2 centros de preparación hay 2 filas y solo una
    -- suele tener la ubicación escrita.
    SELECT
        NroMovVenta,
        ObsArmadorMovil,
        WMS_NroOTPicking,
        CodArmador,
        ROW_NUMBER() OVER (
            PARTITION BY NroMovVenta
            ORDER BY FechaAsignacion DESC, HoraAsignacion DESC, NroInterno DESC
        ) AS rn
    FROM EVERWEAR.dbo.Ven_PedImpresoCA
    WHERE LTRIM(RTRIM(ISNULL(ObsArmadorMovil, ''))) <> ''
) ca ON ca.NroMovVenta = cab.NroMovVenta AND ca.rn = 1
LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante cc  ON cab.CompCodigo = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Clientes           cli ON cab.CodCliente = cli.CodCliente
WHERE cab.EstadoPedido = 2
  AND cab.CompCodigo IN (10, 100, 210, 310, 410)
  -- 2026-09-23: todos los centros de preparación del pedido terminados
  -- (ver _SQL_GATE_CENTROS y el comentario de arriba).
  AND NOT EXISTS ({gate_centros})
  -- Misma whitelist de siempre (ver SQL_MAGNUS_ABIERTOS_TODOS para el porqué
  -- de cada código) MÁS el 410.
  --
  -- CAMBIO 2026-08-25 (revierte la decisión del 2026-08-24): CompCodigo
  -- 410 (PED.NF.CEN, "pedido no facturable de centro") ENTRA a la cola —
  -- "agregá los 410, que no se retiren". Antes quedaba afuera de la whitelist
  -- y era la única diferencia entre esta query y la pantalla Armar Pedidos de
  -- Magnus; ahora las dos muestran lo mismo. Además va PRIMERO en la cola,
  -- por encima de cualquier prioridad — ver el ORDER BY de acá abajo y el de
  -- asignar_siguiente (los dos tienen que decir lo mismo).
  --
  -- Acopio 70/75 NO entra por acá: va por vuelta/remito,
  -- SQL_MAGNUS_ACOPIO_ESPERA_CONTROL — y encima no usa Ven_PedImpresoCA (los
  -- 59 acopios abiertos al 2026-08-24 tienen 0 filas con ubicación y 0 con
  -- OT de WMS ahí, confirmado).
ORDER BY CASE WHEN cab.CompCodigo = 410 THEN 0 ELSE 1 END ASC,
         COALESCE(cab.Prioridad, 999) ASC, cab.FechaPedido ASC
"""

# Nombre del armador: se sigue tomando de WMS (Personal), igual que antes, para
# no cambiar lo que ve el operario en el widget. La diferencia es que ahora se
# entra por OTId directo (Ven_PedImpresoCA.WMS_NroOTPicking) en vez de buscar
# la OT por NroMovVenta y adivinar cuál es la buena.
SQL_WMS_ARMADOR_POR_OT = """
SELECT
    OT.OTId,
    P.PersonalId     AS NroArmador,
    P.PersonalNombre AS NombreArmador
FROM OT
LEFT JOIN Personal P ON OT.OTUsuarioGUID_Repositor = P.PersonalId
WHERE OT.OTId IN ({ph})
"""


def fetch_pedidos_listos_para_control(limit: int = MAGNUS_ABIERTOS_LIMIT) -> list[dict]:
    """Pedidos (no acopio) listos para mesa de control, 100% desde Magnus.
    Misma forma de salida que fetch_pedidos_en_playa_pedidos —
    nroPedido/fecha/tipoPedido/cliente/codCliente/prioridad/nroRemito/
    ubicacion/ot/nroArmador/nombreArmador— así refrescar_cola no cambia.

    WMS ya no decide nada: solo se usa para resolver el NOMBRE del armador a
    partir del OTId que Magnus guarda en Ven_PedImpresoCA.WMS_NroOTPicking. Si
    WMS no contesta o la OT no está, el pedido igual entra a la cola sin nombre
    de armador — antes eso lo dejaba afuera."""
    conn = get_connection("EVERWEAR")
    filas: list[dict] = []
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_MAGNUS_LISTOS_PARA_CONTROL.format(
            limit=limit, gate_centros=_SQL_GATE_CENTROS.format(nro="cab.NroMovVenta")))
        for (nro, fecha_int, tipo_pedido, cliente, cod_cliente,
             prioridad, ubicacion, ot, _cod_armador, comp_codigo) in cur.fetchall():
            if nro is None:
                continue
            filas.append({
                "nroPedido": int(nro),
                "fecha": (BASE_DATE + timedelta(days=int(fecha_int))) if fecha_int else None,
                "tipoPedido": (tipo_pedido or "").strip() or None,
                "cliente": (cliente or "").strip() or None,
                "codCliente": int(cod_cliente) if cod_cliente is not None else None,
                "compCodigo": int(comp_codigo) if comp_codigo is not None else None,
                "prioridad": int(prioridad) if prioridad is not None else None,
                "nroRemito": 0,   # fila "por pedido"; acopio va por vuelta
                "ubicacion": (ubicacion or "").strip() or None,
                "ot": int(ot) if ot else None,
                "nroArmador": None,
                "nombreArmador": None,
            })
    finally:
        conn.close()

    ots = sorted({f["ot"] for f in filas if f["ot"]})
    if not ots:
        return filas

    armadores: dict[int, tuple[int | None, str | None]] = {}
    try:
        conn = get_connection("WMS")
        try:
            cur = conn.cursor()
            cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            CH = 1000
            for i in range(0, len(ots), CH):
                chunk = ots[i:i + CH]
                ph = ",".join("?" for _ in chunk)
                cur.execute(SQL_WMS_ARMADOR_POR_OT.format(ph=ph), chunk)
                for ot_id, nro_arm, nombre_arm in cur.fetchall():
                    armadores[int(ot_id)] = (
                        int(nro_arm) if nro_arm is not None else None,
                        (nombre_arm or "").strip() or None,
                    )
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — WMS caído: la cola no se cae con él
        return filas

    for f in filas:
        if f["ot"] in armadores:
            f["nroArmador"], f["nombreArmador"] = armadores[f["ot"]]
    return filas


def fetch_pedidos_en_playa_pedidos(limit: int = MAGNUS_ABIERTOS_LIMIT) -> list[dict]:
    """LEGACY desde 2026-08-24 (3ra vuelta) — ya NO la llama refrescar_cola.
    La reemplaza fetch_pedidos_listos_para_control: su filtro de
    'PLAYA_PEDIDOS' dejaba afuera casi todo (ver el comentario largo arriba).
    Se deja intacta, sin usar, igual que fetch_pedidos_cumplidos_abiertos_legacy
    — pedido explícito de no perder los criterios viejos.

    Cruce Abierto(Magnus) ∩ "está en la ubicación PLAYA_PEDIDOS" (WMS,
    OTItem.OTItemUbicacionCodigo) por NroMovVenta. Reemplaza el criterio
    "Cumplido" (ver fetch_pedidos_cumplidos_abiertos_legacy) — 2026-08-05: la señal de "listo para Mesa de Control" pasa a ser
    la ubicación física del pedido en WMS, no el estado de la OT. Mismo
    armado que la función legacy (arranca por TODOS los Abiertos de Magnus y
    filtra puntual contra WMS por esos NroMovVenta, en lotes de 1000) —
    misma forma de salida (nroPedido/fecha/tipoPedido/cliente/codCliente/
    prioridad/ubicacion/ot/nroArmador/nombreArmador)."""
    conn = get_connection("EVERWEAR")
    abiertos: dict[int, dict] = {}
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_MAGNUS_ABIERTOS_TODOS.format(limit=limit))
        for nro, fecha_int, tipo_pedido, cliente, cod_cliente, prioridad in cur.fetchall():
            if nro is None:
                continue
            fecha = (BASE_DATE + timedelta(days=int(fecha_int))) if fecha_int else None
            abiertos[int(nro)] = {
                "fecha": fecha,
                "tipoPedido": (tipo_pedido or "").strip() or None,
                "cliente": (cliente or "").strip() or None,
                # FIX 2026-08-21: faltaba y refrescar_cola lo insertaba igual.
                "codCliente": int(cod_cliente) if cod_cliente is not None else None,
                "prioridad": int(prioridad) if prioridad is not None else None,
            }
    finally:
        conn.close()

    if not abiertos:
        return []

    conn = get_connection("WMS")
    wms: dict[int, dict] = {}
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        nros = list(abiertos.keys())
        CH = 1000
        for i in range(0, len(nros), CH):
            chunk = nros[i:i + CH]
            ph = ",".join("?" for _ in chunk)
            cur.execute(
                SQL_WMS_PLAYA_PEDIDOS.format(col_pedido=OT_COL_PEDIDO, ph=ph),
                chunk,
            )
            cols = [c[0] for c in cur.description]
            for row in cur.fetchall():
                d = dict(zip(cols, row))
                nro = d.get("NroPedido")
                ot_id = d.get("Ot")
                if nro is None or ot_id is None:
                    continue
                n = int(nro)
                prev = wms.get(n)
                # Nos quedamos con la OT de mayor OTId (más reciente) de TODAS
                # las de Picking del pedido — no solo de las que están en playa
                # (FIX 2026-08-24): si la más nueva es un repick En Proceso
                # tiene que ganar ella y frenar al pedido, aunque todavía no
                # haya dejado nada en playa. Mismo criterio "más reciente
                # manda" que la función legacy.
                if prev is None or int(ot_id) > prev["ot"]:
                    wms[n] = {
                        "ot": int(ot_id),
                        "otEstado": int(d["OTEstado"]) if d.get("OTEstado") is not None else None,
                        "enPlaya": bool(d.get("EnPlaya")),
                        "nroArmador": int(d["NroArmador"]) if d.get("NroArmador") is not None else None,
                        "nombreArmador": (d.get("NombreArmador") or "").strip() or None,
                        "ubicacion": "PLAYA_PEDIDOS",
                    }
    finally:
        conn.close()

    out: list[dict] = []
    for nro, ab in abiertos.items():
        w = wms.get(nro)
        if w is None:
            # Sin OT de Picking en WMS.
            continue
        if not w.get("enPlaya"):
            # Ningún renglón de su OT de Picking más reciente está en
            # PLAYA_PEDIDOS — todavía no está listo para Mesa de Control.
            continue
        if w.get("otEstado") != 2:
            # FIX 2026-08-24: está en playa pero la OT sigue En Proceso (el
            # armador todavía está pickeando, o hay un repick abierto). No se
            # controla hasta que WMS la marque Cumplida.
            continue
        out.append({
            "nroPedido": nro,
            "fecha": ab["fecha"],
            "tipoPedido": ab["tipoPedido"],
            "cliente": ab["cliente"],
            "codCliente": ab["codCliente"],
            "prioridad": ab["prioridad"],
            "nroRemito": 0,          # fila "por pedido" (ver docstring: acopio va por vuelta)
            "ubicacion": w["ubicacion"],
            "ot": w["ot"],
            "nroArmador": w["nroArmador"],
            "nombreArmador": w["nombreArmador"],
        })
    return out


# ── ACOPIO 70/75: vueltas esperando mesa de control ─────────────────────────
# (2026-08-21) Una fila por VUELTA, no por pedido — ver docstring del módulo.
# Solo Magnus: no hace falta cruzar a WMS porque cada vuelta ya es un remito
# (OT1PIC <-> remito es 1 a 1) y `FechaArmado > 0` es el "terminó de
# preparar" que del otro lado se buscaba con PLAYA_PEDIDOS.
#
# El filtro es, literalmente, "armado y todavía sin pasar por mesa":
#     FechaArmado > 0   AND   FechaCierre = 0
# más las dos exclusiones que si no vuelven a trabar el puesto:
#     EstadoRemito 3 (borrador sin emitir = la vuelta fue a buscar y no había
#                     nada) y 4 (anulado)  -> no pasan por mesa nunca
#     remito sin renglones                 -> idem
#
# `fecha` sale de FechaArmado (no de FechaPedido): dentro de cada prioridad la
# cola es FIFO por "desde cuándo está esperando mesa", que para una vuelta es
# el momento en que se terminó de armar. FechaPedido acá no sirve — es la
# misma para todas las vueltas del acopio, que pueden ser 10 a lo largo de un
# año.
#
# BASE DE FECHAS: las fechas de Magnus son "días desde 1800-12-28" (BASE_DATE
# en errores_mesa.py). Se devuelven como int y se convierten en Python, igual
# que FechaPedido — no se toca SQL para eso.
SQL_MAGNUS_ACOPIO_ESPERA_CONTROL = """
SELECT TOP ({limit})
    rmt.NroMovVenta     AS NroRemito,
    cab.NroMovVenta     AS NroPedido,
    rmt.FechaArmado     AS FechaArmado,
    cc.DetalleCorto     AS TipoPedido,
    cli.Cliente_Nombre  AS Cliente,
    cab.CodCliente      AS CodCliente,
    cab.Prioridad       AS Prioridad,
    pca.ObsArmadorMovil AS Ubicacion,
    rmt.OTId            AS Ot,
    rmt.UsuarioArmado   AS NroArmador,
    usr.Nombre          AS NombreArmador,
    cab.CompCodigo      AS CompCodigo
FROM EVERWEAR.dbo.VenFer_RmtoCabecera rmt
INNER JOIN EVERWEAR.dbo.VenFer_PedidoCabecera cab ON cab.NroMovVenta = rmt.NroMovPedido
LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante cc  ON cab.CompCodigo  = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Clientes           cli ON cab.CodCliente  = cli.CodCliente
LEFT JOIN EVERWEAR.dbo.Ven_PedImpresoCA      pca ON pca.NroMovVenta = cab.NroMovVenta
LEFT JOIN EVERWEAR.dbo.[Gen_Usuarios]        usr ON usr.Numero      = rmt.UsuarioArmado
WHERE rmt.CompCodigo = 71                 -- remito de acopio
  AND cab.CompCodigo IN (70, 75)          -- el pedido es un acopio
  AND rmt.FechaArmado > 0                 -- la vuelta terminó de armarse
  AND ISNULL(rmt.FechaCierre, 0) = 0      -- y todavía no pasó por mesa
  AND rmt.EstadoRemito NOT IN (3, 4)      -- 3 borrador (vuelta vacía) / 4 anulado
  AND EXISTS (
        SELECT 1 FROM EVERWEAR.dbo.VenFer_RmtoReng rr
        WHERE rr.NroMovVenta = rmt.NroMovVenta
      )
ORDER BY COALESCE(cab.Prioridad, 999) ASC, rmt.FechaArmado ASC
"""


def fetch_acopio_vueltas_espera_control(limit: int = MAGNUS_ABIERTOS_LIMIT) -> list[dict]:
    """Vueltas de acopio (70/75) armadas y todavía sin pasar por mesa de
    control. Una fila por REMITO (`nroRemito`), no por pedido — ver docstring
    del módulo. Misma forma de salida que
    fetch_pedidos_en_playa_pedidos (nroPedido/fecha/tipoPedido/cliente/
    codCliente/prioridad/ubicacion/ot/nroArmador/nombreArmador) más
    `nroRemito`, así refrescar_cola las inserta con el mismo código.

    Solo Magnus: no se consulta WMS (ver comentario junto a la query)."""
    conn = get_connection("EVERWEAR")
    out: list[dict] = []
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(SQL_MAGNUS_ACOPIO_ESPERA_CONTROL.format(limit=limit))
        cols = [c[0] for c in cur.description]
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            nro_remito, nro_pedido = d.get("NroRemito"), d.get("NroPedido")
            if nro_remito is None or nro_pedido is None:
                continue
            armado = d.get("FechaArmado")
            fecha = (BASE_DATE + timedelta(days=int(armado))) if armado else None
            ubic = d.get("Ubicacion")
            out.append({
                "nroPedido": int(nro_pedido),
                "nroRemito": int(nro_remito),
                "fecha": fecha,
                "tipoPedido": (d.get("TipoPedido") or "").strip() or None,
                "cliente": (d.get("Cliente") or "").strip() or None,
                "codCliente": int(d["CodCliente"]) if d.get("CodCliente") is not None else None,
                "compCodigo": int(d["CompCodigo"]) if d.get("CompCodigo") is not None else None,
                "prioridad": int(d["Prioridad"]) if d.get("Prioridad") is not None else None,
                # En acopio la "ubicación" es la física del acopio en playa,
                # que el armador deja escrita en Ven_PedImpresoCA.
                "ubicacion": (str(ubic).strip() or None) if ubic is not None else None,
                "ot": int(d["Ot"]) if d.get("Ot") is not None else None,
                "nroArmador": int(d["NroArmador"]) if d.get("NroArmador") is not None else None,
                "nombreArmador": (d.get("NombreArmador") or "").strip() or None,
            })
    finally:
        conn.close()
    return out


# ── Purga de la cola: filas que quedaron viejas DESPUÉS de haber entrado ────
# FIX 2026-08-24, 2da vuelta del día. El filtro nuevo de
# SQL_MAGNUS_ABIERTOS_TODOS (EstadoPedido = 2) evita que entren pedidos ya
# cerrados/anulados, pero NO limpia los que ya están en la cola: refrescar_cola
# inserta con ON CONFLICT DO NOTHING y asignar_siguiente reparte con un
# `WHERE "asignadoEn" IS NULL` sin ningún chequeo contra Magnus. O sea: una
# fila que entró cuando el pedido estaba abierto se queda ahí para siempre y
# se entrega igual aunque el pedido haya cerrado 3 días después. Ese es el
# camino por el que salió el 757555 aun con el filtro puesto.
#
# Solo se tocan filas SIN asignar ("asignadoEn" IS NULL): las ya asignadas son
# historial (las lee fetch_pedidos_asignados) y no se borran nunca.
# 2026-09-23: también sale de la cola (sin asignar) el pedido que tiene un
# centro de preparación pendiente (CP2 sin terminar) — entró con el criterio
# viejo de "alguna fila con ubicación". Cuando el centro termine, el próximo
# refresco lo vuelve a insertar (la fila se borró, no choca el ON CONFLICT).
SQL_PEDIDOS_YA_NO_VAN = """
SELECT cab.NroMovVenta
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
WHERE cab.NroMovVenta IN ({ph})
  AND (cab.EstadoPedido <> 2 OR ISNULL(cab.FechaCierre, 0) > 0
       OR EXISTS (""" + _SQL_GATE_CENTROS.format(nro="cab.NroMovVenta") + """))
"""

# Equivalente para las filas de acopio (unidad = la vuelta/remito, ver
# docstring del módulo): la vuelta ya no va si pasó por mesa (FechaCierre > 0)
# o si el remito quedó en borrador sin emitir (3) o anulado (4) — mismas
# exclusiones que SQL_MAGNUS_ACOPIO_ESPERA_CONTROL, pero aplicadas después.
SQL_REMITOS_YA_NO_VAN = """
SELECT NroMovVenta
FROM EVERWEAR.dbo.VenFer_RmtoCabecera
WHERE NroMovVenta IN ({ph})
  AND (ISNULL(FechaCierre, 0) > 0 OR EstadoRemito IN (3, 4))
"""

_PURGA_CHUNK = 500   # tope de parámetros por IN, para no reventar el driver


def _magnus_ya_no_van(sql: str, nros: list[int]) -> set[int]:
    """De la lista que se le pasa, cuáles ya no corresponden. Vacío si la
    lista viene vacía (no se abre conexión al pedo)."""
    if not nros:
        return set()
    fuera: set[int] = set()
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        for i in range(0, len(nros), _PURGA_CHUNK):
            lote = nros[i:i + _PURGA_CHUNK]
            ph = ",".join("?" * len(lote))
            cur.execute(sql.format(ph=ph), lote)
            fuera.update(int(r[0]) for r in cur.fetchall())
    finally:
        conn.close()
    return fuera


def purgar_cola_obsoleta() -> int:
    """Saca de la cola las filas SIN asignar cuyo pedido (o vuelta de acopio)
    ya no corresponde controlar. Devuelve cuántas se borraron.

    Por qué hace falta además del filtro de SQL_MAGNUS_ABIERTOS_TODOS: ese
    filtro decide qué ENTRA. Esta función decide qué SE QUEDA. Entre que un
    pedido entra a la cola y que alguien lo reclama pueden pasar días, y en el
    medio el pedido se controla y se cierra — la cola no se enteraba.

    Gate por tipo de fila, mismo criterio que _fetch_asignacion_cerrada:
      · "nroRemito" = 0  -> pedido: EstadoPedido <> 2 (cerrado/anulado) o
        FechaCierre > 0.
      · "nroRemito" > 0  -> acopio: el remito cerró (pasó por mesa) o quedó
        en borrador/anulado.

    Si Magnus no contesta, no borra nada y sigue: la cola sucia es un mal
    menor frente a dejar el widget sin poder asignar."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            'SELECT id, "nroPedido", "nroRemito" FROM deposito.control_asignacion '
            'WHERE "asignadoEn" IS NULL'
        )
        pendientes = cur.fetchall()
    finally:
        conn.close()

    if not pendientes:
        return 0

    pedidos = [int(p[1]) for p in pendientes if not (p[2] or 0)]
    remitos = [int(p[2]) for p in pendientes if (p[2] or 0)]

    try:
        fuera_ped = _magnus_ya_no_van(SQL_PEDIDOS_YA_NO_VAN, pedidos)
        fuera_rmt = _magnus_ya_no_van(SQL_REMITOS_YA_NO_VAN, remitos)
    except Exception:  # noqa: BLE001 — Magnus caído / timeout: no purgar
        return 0

    ids = [
        int(p[0]) for p in pendientes
        if (int(p[2]) in fuera_rmt if (p[2] or 0) else int(p[1]) in fuera_ped)
    ]
    if not ids:
        return 0

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            'DELETE FROM deposito.control_asignacion '
            'WHERE id = ANY(%s) AND "asignadoEn" IS NULL',
            (ids,),
        )
        borradas = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return borradas


def refrescar_cola(limit: int = MAGNUS_ABIERTOS_LIMIT) -> int:
    """Agrega a deposito.control_asignacion los pedidos Abiertos(Magnus) ∩ en
    PLAYA_PEDIDOS(WMS) que todavía no estén en la cola (ON CONFLICT DO
    NOTHING — no toca los que ya están, asignados o no). Devuelve cuántos se
    agregaron. Se llama al reclamar (asignar_siguiente), no hace falta un
    loop/cron aparte.

    FIX 2026-08-05: pasó a usar
    fetch_pedidos_en_playa_pedidos en vez de fetch_pedidos_cumplidos_abiertos
    (criterio "Cumplido" en WMS) — ver esa función y
    fetch_pedidos_cumplidos_abiertos_legacy (se deja sin usar, sin borrar).

    FIX 2026-08-24, 3ra vuelta: pasó a usar fetch_pedidos_listos_para_control
    (100% Magnus, gate = Ven_PedImpresoCA.ObsArmadorMovil). Los dos criterios
    de WMS quedan legacy — ver el comentario largo sobre
    SQL_MAGNUS_LISTOS_PARA_CONTROL.

    2026-08-21: se le suman las VUELTAS de acopio 70/75
    (fetch_acopio_vueltas_espera_control), que son filas por remito
    ("nroRemito" > 0) y no por pedido. El ON CONFLICT ahora es por
    ("nroPedido", "nroRemito"), así que un mismo acopio puede entrar muchas
    veces —una por vuelta, a lo largo de meses— sin pisarse. Las filas
    no-acopio siguen con "nroRemito" = 0 y se comportan igual que siempre.

    FIX 2026-08-24, 2da vuelta: antes de agregar, PURGA (ver
    purgar_cola_obsoleta). Agregar solo lo nuevo no alcanzaba — las filas
    viejas de pedidos ya cerrados se quedaban en la cola y se seguían
    entregando."""
    purgar_cola_obsoleta()
    candidatos = fetch_pedidos_listos_para_control(limit) + fetch_acopio_vueltas_espera_control(limit)
    if not candidatos:
        return 0
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        nuevos = 0
        for c in candidatos:
            cur.execute(
                """
                INSERT INTO deposito.control_asignacion
                    ("nroPedido", "nroRemito", fecha, "tipoPedido", cliente, "codCliente",
                     "compCodigo", "prioridad", ubicacion, ot, "nroArmador", "nombreArmador")
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT ("nroPedido", "nroRemito") DO NOTHING
                """,
                (
                    c["nroPedido"], c.get("nroRemito", 0), c["fecha"], c["tipoPedido"],
                    c["cliente"], c["codCliente"], c.get("compCodigo"),
                    c["prioridad"], c["ubicacion"], c["ot"],
                    c["nroArmador"], c["nombreArmador"],
                ),
            )
            nuevos += cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return nuevos


def _fetch_pedido_cerrado(nro_pedido: int) -> bool:
    """True si `nro_pedido` ya está Cerrado en Magnus. Mismo criterio que
    fetch_pedidos_hora (deposito.py): VenFer_PedidoCabecera.FechaCierre es la
    fecha nativa de Magnus (días desde 1800-12-28); <= 0 o NULL = todavía no
    cerró. Se usa Cabecera (no TMP_TiempoDePedidos) para este chequeo puntual
    porque es en vivo — TMP_TiempoDePedidos es una foto que llena
    SP_TiempoPedidos_Cargar y podría tardar en reflejar el cierre.

    Si el pedido no aparece en Cabecera (caso raro / archivado), se considera
    Cerrado para no dejar al operario trabado esperando un pedido que ya no
    existe."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT FechaCierre FROM EVERWEAR.dbo.VenFer_PedidoCabecera WHERE NroMovVenta = ?",
            (nro_pedido,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if row is None:
        return True
    fecha_cierre = row[0]
    try:
        return fecha_cierre is not None and int(fecha_cierre) > 0
    except (TypeError, ValueError):
        return False


def _fetch_remito_controlado(nro_remito: int) -> bool:
    """True si esa VUELTA de acopio ya pasó por mesa de control, o sea si el
    remito tiene `FechaCierre > 0` (fecha nativa de Magnus, días desde
    1800-12-28; 0/NULL = todavía no). `UsuarioCierre` en acopio es el PUESTO
    de mesa (174 = MESA CONTROL 1, 175 = MESA 2, 214 = MESA 3), no una
    persona — no se usa acá, pero es la prueba de que este campo ES el
    control (ver docstring del módulo).

    Este es el gate que reemplaza a `_fetch_pedido_cerrado` para las filas de
    acopio: el PEDIDO de acopio no cierra hasta dentro de meses, la VUELTA
    cierra el mismo día.

    Si el remito no aparece (anulado y purgado, caso raro), se considera
    controlado para no dejar al operario trabado — mismo criterio que
    _fetch_pedido_cerrado."""
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT FechaCierre FROM EVERWEAR.dbo.VenFer_RmtoCabecera WHERE NroMovVenta = ?",
            (nro_remito,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if row is None:
        return True
    fecha_cierre = row[0]
    try:
        return fecha_cierre is not None and int(fecha_cierre) > 0
    except (TypeError, ValueError):
        return False


def _fetch_asignacion_cerrada(activa: dict) -> bool:
    """¿La asignación activa del operario ya terminó? Elige el gate según el
    tipo de fila (2026-08-21):

      · "nroRemito" > 0  -> fila de acopio, unidad = la VUELTA. Termina
        cuando ESE remito pasó por mesa (FechaCierre > 0).
      · "nroRemito" = 0  -> fila normal, unidad = el PEDIDO. Termina cuando el
        pedido cierra en Magnus, igual que siempre.

    Este selector es todo el arreglo del problema que trababa el puesto: con
    un acopio asignado, el gate viejo (pedido cerrado) no se cumplía nunca
    porque un acopio queda Abierto durante meses."""
    nro_remito = activa.get("nroRemito") or 0
    if nro_remito:
        return _fetch_remito_controlado(int(nro_remito))
    return _fetch_pedido_cerrado(activa["nroPedido"])


def _fetch_asignacion_activa(nro_operario: int) -> dict | None:
    """Última fila que este operario reclamó (deposito.control_asignacion,
    la más reciente por "asignadoEn"). None si nunca reclamó nada. Se usa
    para no entregarle un pedido nuevo mientras el anterior sigue abierto —
    ver nota "UN PEDIDO POR OPERARIO A LA VEZ" en el docstring del módulo."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, "nroPedido", "nroRemito", fecha, "tipoPedido", cliente, "codCliente",
                   "prioridad", ubicacion, ot, "nroArmador", "nombreArmador",
                   "asignadoA", "asignadoEn"
            FROM deposito.control_asignacion
            WHERE "nroOperarioAsignado" = %s AND "asignadoEn" IS NOT NULL
            ORDER BY "asignadoEn" DESC
            LIMIT 1
            """,
            (nro_operario,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return None
    cols = [
        "id", "nroPedido", "nroRemito", "fecha", "tipoPedido", "cliente", "codCliente",
        "prioridad", "ubicacion", "ot", "nroArmador", "nombreArmador",
        "asignadoA", "asignadoEn",
    ]
    out = dict(zip(cols, row))
    if out.get("fecha") is not None:
        out["fecha"] = out["fecha"].isoformat()
    if out.get("asignadoEn") is not None:
        out["asignadoEn"] = out["asignadoEn"].isoformat()
    return out


# ══════════════════════════════════════════════════════════════════════════
# RESERVA POR CLIENTE (2026-09-23)
#
# Regla: todos los pedidos de un mismo cliente los controla la PRIMERA
# persona a la que se le asignó uno de ellos. Si el cliente tiene 5 pedidos y
# al operario le toca 1, los otros 4 le van a tocar a él cuando estén listos.
#
# La unidad sigue siendo la misma que en la cola: pedido (10/100/210/310/410)
# o VUELTA de acopio (70/75, remito 71). El "grupo" de un cliente es:
#   · listo      -> la unidad pasaría hoy el gate de la cola (mismo criterio que
#                   SQL_MAGNUS_LISTOS_PARA_CONTROL / SQL_MAGNUS_ACOPIO_ESPERA_CONTROL,
#                   incluido el gate de centros CP1/CP2).
#   · en prep.   -> ya se mandó a armar y todavía no terminó: fila de
#                   Ven_PedImpresoCA con FechaAsignacion en los últimos
#                   RESERVA_PREP_DIAS días (CP1 sin ubicación o CP2 sin FechaFin),
#                   o remito 71 emitido (EstadoRemito 1/2) con FechaArmado = 0.
#                   Un pedido abierto que nunca se mandó al depósito NO traba al
#                   grupo, y uno mandado hace más de RESERVA_PREP_DIAS tampoco
#                   (medido 2026-09-23: 4 de 80 pedidos en preparación tenían
#                   más de 7 días — trabados, no "en camino").
#
# Estados de la reserva (deposito.control_reserva_cliente, 1 fila por cliente):
#   nuevo   -> se le acaba de asignar la 1ª unidad y hay otras en preparación:
#              el widget le pregunta Tomar / Esperar.
#   tomado  -> la toma: el resto del cliente le cae a él, primero en la cola,
#              a medida que se pone listo. No se le vuelve a preguntar.
#   espera  -> prefiere esperar: la unidad vuelve a la cola RESERVADA para él
#              (nadie más la puede tomar) y sigue con otros clientes. Cuando se
#              suma otra unidad lista ("listosAlDecidir" crece) se le vuelve a
#              preguntar. Si quedan TODAS listas, pasa sola a "tomado" y el
#              widget, si está libre, se las asigna.
#
# Liberación de la reserva: cuando en Magnus ya no queda ninguna unidad del
# cliente (todo controlado/cerrado) o cuando el operario deja de dar señales
# ("vistoEn" más viejo que RESERVA_INACTIVO_MIN: widget cerrado, PC apagada,
# cambio de operario). El widget nuevo refresca "vistoEn" cada 30 s.
#
# Concurrencia: el reclamo + alta de reserva van dentro de un
# pg_advisory_xact_lock — dos operarios que aprietan Asignar a la vez con
# pedidos del mismo cliente en la cola no pueden quedarse con uno cada uno.
# ══════════════════════════════════════════════════════════════════════════

RESERVA_PREP_DIAS = 7
RESERVA_INACTIVO_MIN = 30
_LOCK_COLA = 7_310_425   # clave del pg_advisory_xact_lock de la cola

_SQL_PG_RESERVA_DDL = """
CREATE TABLE IF NOT EXISTS deposito.control_reserva_cliente (
    "codCliente"      integer PRIMARY KEY,
    "nroOperario"     integer NOT NULL,
    "asignadoA"       text,
    cliente           text,
    estado            text NOT NULL DEFAULT 'nuevo',
    "listosAlDecidir" integer NOT NULL DEFAULT 0,
    "creadoEn"        timestamp NOT NULL DEFAULT now(),
    "actualizadoEn"   timestamp NOT NULL DEFAULT now(),
    "vistoEn"         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_control_reserva_operario
    ON deposito.control_reserva_cliente ("nroOperario");
CREATE INDEX IF NOT EXISTS idx_control_asignacion_cliente
    ON deposito.control_asignacion ("codCliente");
"""
_reserva_ddl_ok = False


def _asegurar_tabla_reserva() -> None:
    """CREATE IF NOT EXISTS una sola vez por proceso (también está en
    sql/deposito_control_asignacion.sql). Si el usuario de PG no tiene
    permiso de DDL, sigue: la tabla la crea el .sql."""
    global _reserva_ddl_ok
    if _reserva_ddl_ok:
        return
    try:
        conn = get_pg_connection()
        try:
            cur = conn.cursor()
            cur.execute(_SQL_PG_RESERVA_DDL)
            conn.commit()
        finally:
            conn.close()
        _reserva_ddl_ok = True
    except Exception:  # noqa: BLE001
        _reserva_ddl_ok = True


# Grupo de uno o más clientes en Magnus. Seeks: VenFer_PedidoCabecera por
# VF_PEDCAB_Cla_EstadoCliente (EstadoPedido, CodCliente); remitos 71 por
# VF_REMCAB_Cla_CodClienteFecha (CodCliente); CA/Reng por sus clustered. {ph} = IN
# de CodCliente (se usa dos veces: los parámetros van duplicados).
_SQL_GRUPO_CLIENTES = """
SELECT cab.CodCliente, cab.NroMovVenta AS NroPedido, 0 AS NroRemito,
       CASE WHEN EXISTS (
                SELECT 1 FROM EVERWEAR.dbo.Ven_PedImpresoCA c
                WHERE c.NroMovVenta = cab.NroMovVenta
                  AND LTRIM(RTRIM(ISNULL(c.ObsArmadorMovil, ''))) <> '')
             AND NOT EXISTS ({gate_centros})
            THEN 1 ELSE 0 END AS Listo
FROM EVERWEAR.dbo.VenFer_PedidoCabecera cab
WHERE cab.EstadoPedido = 2
  AND cab.CodCliente IN ({ph})
  AND cab.CompCodigo IN (10, 100, 210, 310, 410)
  AND EXISTS (
        SELECT 1 FROM EVERWEAR.dbo.Ven_PedImpresoCA c
        WHERE c.NroMovVenta = cab.NroMovVenta
          AND (c.FechaAsignacion >= DATEDIFF(DAY, '1800-12-28', GETDATE()) - {dias}
               OR LTRIM(RTRIM(ISNULL(c.ObsArmadorMovil, ''))) <> ''))
UNION ALL
SELECT cab.CodCliente, rmt.NroMovPedido, rmt.NroMovVenta,
       CASE WHEN rmt.FechaArmado > 0 THEN 1 ELSE 0 END
FROM EVERWEAR.dbo.VenFer_RmtoCabecera rmt
INNER JOIN EVERWEAR.dbo.VenFer_PedidoCabecera cab ON cab.NroMovVenta = rmt.NroMovPedido
-- Acopio: se entra por el REMITO (VF_REMCAB_Cla_CodClienteFecha) y NO se
-- exige pedido abierto — medido 2026-09-23: las vueltas recién mandadas
-- (remito 71 EstadoRemito 1/2, FechaArmado 0) cuelgan de pedidos 70/75 ya en
-- EstadoPedido 4. Misma lógica que SQL_MAGNUS_ACOPIO_ESPERA_CONTROL, que
-- tampoco filtra el estado del pedido. rmt.CodCliente = cab.CodCliente en
-- 574/574 remitos 71 (desde 82350).
WHERE rmt.CodCliente IN ({ph})
  AND cab.CompCodigo IN (70, 75)
  AND rmt.CompCodigo = 71
  AND ISNULL(rmt.FechaCierre, 0) = 0
  AND (
        (rmt.FechaArmado > 0 AND rmt.EstadoRemito NOT IN (3, 4)
         AND EXISTS (SELECT 1 FROM EVERWEAR.dbo.VenFer_RmtoReng rr
                     WHERE rr.NroMovVenta = rmt.NroMovVenta))
     OR (ISNULL(rmt.FechaArmado, 0) = 0 AND rmt.EstadoRemito IN (1, 2)
         AND rmt.FecRegistracion >= DATEDIFF(DAY, '1800-12-28', GETDATE()) - {dias})
      )
"""


def fetch_grupos_magnus(cod_clientes: list[int]) -> dict[int, list[dict]]:
    """{codCliente: [{nroPedido, nroRemito, listo}]} — unidades vivas del
    cliente (listas o en preparación). Cliente sin unidades = no aparece."""
    cods = sorted({int(c) for c in cod_clientes if c is not None})
    out: dict[int, list[dict]] = {}
    if not cods:
        return out
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        for i in range(0, len(cods), _PURGA_CHUNK // 2):
            lote = cods[i:i + _PURGA_CHUNK // 2]
            ph = ",".join("?" * len(lote))
            cur.execute(
                _SQL_GRUPO_CLIENTES.format(
                    ph=ph, dias=int(RESERVA_PREP_DIAS),
                    gate_centros=_SQL_GATE_CENTROS.format(nro="cab.NroMovVenta")),
                lote + lote,
            )
            for cod, nro_ped, nro_rmt, listo in cur.fetchall():
                out.setdefault(int(cod), []).append({
                    "nroPedido": int(nro_ped),
                    "nroRemito": int(nro_rmt or 0),
                    "listo": bool(listo),
                })
    finally:
        conn.close()
    for lst in out.values():
        lst.sort(key=lambda u: (u["nroPedido"], u["nroRemito"]))
    return out


def _unidades_asignadas(cur, cod_clientes: list[int]) -> set[tuple[int, int]]:
    """(nroPedido, nroRemito) de ese/os cliente/s que ya se entregaron a un
    operario (en control o controlados con el cierre de Magnus demorado)."""
    if not cod_clientes:
        return set()
    cur.execute(
        'SELECT "nroPedido", "nroRemito" FROM deposito.control_asignacion '
        'WHERE "codCliente" = ANY(%s) AND "asignadoEn" IS NOT NULL '
        "  AND \"asignadoEn\" > now() - interval '60 days'",
        (list(cod_clientes),),
    )
    return {(int(a), int(b or 0)) for a, b in cur.fetchall()}


def _tocar_operario(nro_operario: int) -> None:
    """Latido: el operario sigue en su puesto -> sus reservas no vencen."""
    try:
        conn = get_pg_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                'UPDATE deposito.control_reserva_cliente SET "vistoEn" = now() '
                'WHERE "nroOperario" = %s',
                (nro_operario,),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — sin tabla todavía / PG caído
        pass


def _resumir(reserva: dict, unidades: list[dict], asignadas: set) -> dict:
    """Arma el resumen del grupo y decide la transición de estado (no escribe:
    devuelve "_nuevoEstado"/"_nuevoListos" para que el llamador persista)."""
    detalle = []
    libres = asignados = prep = 0
    for u in unidades:
        clave = (u["nroPedido"], u["nroRemito"])
        if not u["listo"]:
            est = "prep"
            prep += 1
        elif clave in asignadas:
            est = "asignado"
            asignados += 1
        else:
            est = "listo"
            libres += 1
        detalle.append({"nroPedido": u["nroPedido"], "nroRemito": u["nroRemito"], "estado": est})

    estado = reserva["estado"]
    listos_decidir = int(reserva.get("listosAlDecidir") or 0)
    oferta = False
    auto = False
    nuevo_estado, nuevo_listos = estado, listos_decidir

    if estado == "nuevo":
        if prep == 0:
            nuevo_estado = "tomado"          # nada que esperar: no se pregunta
        else:
            oferta = True
    elif estado == "espera":
        if prep == 0 and libres > 0:
            nuevo_estado = "tomado"          # quedaron todas listas: van a él
            auto = True
        elif libres > listos_decidir:
            oferta = True                    # se sumó otra lista: volver a preguntar
        elif libres < listos_decidir:
            nuevo_listos = libres            # se anuló alguna: bajar la vara

    return {
        "codCliente": reserva["codCliente"],
        "cliente": reserva.get("cliente"),
        "nroOperario": reserva["nroOperario"],
        "asignadoA": reserva.get("asignadoA"),
        "estado": nuevo_estado,
        "total": len(unidades),
        "listos": libres,            # listos y todavía sin entregar
        "asignados": asignados,      # ya entregados (en control / controlados)
        "enPreparacion": prep,
        "oferta": oferta,
        "todosListos": prep == 0,
        "autoAsignar": auto,
        "pedidos": detalle,
        "_nuevoEstado": nuevo_estado if nuevo_estado != estado else None,
        "_nuevoListos": nuevo_listos if nuevo_listos != listos_decidir else None,
    }


def evaluar_reservas(nro_operario: int | None = None) -> dict[int, dict]:
    """Mantenimiento + estado de las reservas (todas, o las de un operario):
    borra las vencidas por inactividad y las de clientes que ya no tienen
    unidades vivas en Magnus, aplica las transiciones de estado y devuelve
    {codCliente: resumen}. Si Magnus no contesta, no borra nada por grupo
    (solo por inactividad) y devuelve lo que pueda."""
    _asegurar_tabla_reserva()
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            'DELETE FROM deposito.control_reserva_cliente '
            'WHERE "vistoEn" < now() - make_interval(mins => %s)',
            (RESERVA_INACTIVO_MIN,),
        )
        sql = ('SELECT "codCliente", "nroOperario", "asignadoA", cliente, estado, '
               '"listosAlDecidir" FROM deposito.control_reserva_cliente')
        params: tuple = ()
        if nro_operario is not None:
            sql += ' WHERE "nroOperario" = %s'
            params = (nro_operario,)
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        reservas = [dict(zip(cols, r)) for r in cur.fetchall()]
        conn.commit()
        if not reservas:
            return {}

        cods = [r["codCliente"] for r in reservas]
        try:
            grupos = fetch_grupos_magnus(cods)
        except Exception:  # noqa: BLE001 — Magnus caído: no tocar reservas
            return {}
        asignadas = _unidades_asignadas(cur, cods)

        out: dict[int, dict] = {}
        for r in reservas:
            unidades = grupos.get(int(r["codCliente"]), [])
            if not unidades:
                cur.execute(
                    'DELETE FROM deposito.control_reserva_cliente WHERE "codCliente" = %s',
                    (r["codCliente"],),
                )
                continue
            res = _resumir(r, unidades, asignadas)
            if res["_nuevoEstado"] is not None or res["_nuevoListos"] is not None:
                cur.execute(
                    'UPDATE deposito.control_reserva_cliente '
                    'SET estado = %s, "listosAlDecidir" = %s, "actualizadoEn" = now() '
                    'WHERE "codCliente" = %s',
                    (res["estado"],
                     res["_nuevoListos"] if res["_nuevoListos"] is not None else r["listosAlDecidir"],
                     r["codCliente"]),
                )
            res.pop("_nuevoEstado", None)
            res.pop("_nuevoListos", None)
            out[int(r["codCliente"])] = res
        conn.commit()
        return out
    finally:
        conn.close()


_COLS_FILA = [
    "id", "nroPedido", "nroRemito", "fecha", "tipoPedido", "cliente", "codCliente",
    "prioridad", "ubicacion", "ot", "nroArmador", "nombreArmador",
    "asignadoA", "asignadoEn",
]


def _fila_json(row) -> dict:
    out = dict(zip(_COLS_FILA, row))
    if out.get("fecha") is not None:
        out["fecha"] = out["fecha"].isoformat()
    if out.get("asignadoEn") is not None:
        out["asignadoEn"] = out["asignadoEn"].isoformat()
    return out


def _reclamar(cur, nro_operario: int, nombre: str, cod_cliente_afin,
              solo_cliente: int | None = None):
    """UPDATE atómico que entrega la próxima fila libre. Respeta reservas:
    nunca entrega una fila de un cliente reservado por OTRO operario (vigente)
    ni de un cliente que ESTE operario dejó en espera. Orden: 410 primero de
    todo (regla 2026-08-25), después los clientes reservados por él, después
    afinidad, prioridad y fecha. `solo_cliente` = reclamar solo de ese cliente
    (botón Tomar)."""
    cur.execute(
        """
        UPDATE deposito.control_asignacion
        SET "asignadoA" = %(nombre)s, "nroOperarioAsignado" = %(op)s, "asignadoEn" = now()
        WHERE id = (
            SELECT ca.id FROM deposito.control_asignacion ca
            WHERE ca."asignadoEn" IS NULL
              AND (%(solo)s::int IS NULL OR ca."codCliente" = %(solo)s::int)
              AND NOT EXISTS (
                    SELECT 1 FROM deposito.control_reserva_cliente r
                    WHERE r."codCliente" = ca."codCliente"
                      AND r."vistoEn" >= now() - make_interval(mins => %(inact)s)
                      AND (r."nroOperario" <> %(op)s OR r.estado = 'espera')
                  )
            ORDER BY CASE WHEN ca."compCodigo" = 410 THEN 0 ELSE 1 END ASC,
                     EXISTS (
                        SELECT 1 FROM deposito.control_reserva_cliente r
                        WHERE r."codCliente" = ca."codCliente" AND r."nroOperario" = %(op)s
                     ) DESC,
                     COALESCE(ca."codCliente" = %(afin)s::int, FALSE) DESC,
                     COALESCE(ca."prioridad", 999) ASC, ca.fecha ASC
            FOR UPDATE OF ca SKIP LOCKED
            LIMIT 1
        )
        RETURNING id, "nroPedido", "nroRemito", fecha, "tipoPedido", cliente, "codCliente",
                  "prioridad", ubicacion, ot, "nroArmador", "nombreArmador",
                  "asignadoA", "asignadoEn"
        """,
        {"nombre": nombre, "op": nro_operario, "solo": solo_cliente,
         "inact": RESERVA_INACTIVO_MIN, "afin": cod_cliente_afin},
    )
    return cur.fetchone()


def _alta_reserva(cur, nro_operario: int, nombre: str, fila: dict) -> None:
    """Reserva el cliente de la fila recién entregada para este operario. Si
    ya era suyo, solo refresca el latido (no pisa "tomado"/"espera")."""
    cod = fila.get("codCliente")
    if cod is None:
        return
    cur.execute(
        """
        INSERT INTO deposito.control_reserva_cliente
            ("codCliente", "nroOperario", "asignadoA", cliente, estado, "listosAlDecidir")
        VALUES (%s, %s, %s, %s, 'nuevo', 0)
        ON CONFLICT ("codCliente") DO UPDATE
            SET "vistoEn" = now()
            WHERE deposito.control_reserva_cliente."nroOperario" = EXCLUDED."nroOperario"
        """,
        (cod, nro_operario, nombre, fila.get("cliente")),
    )


def grupo_de_cliente(nro_operario: int, cod_cliente) -> dict | None:
    """Resumen del grupo del cliente para ESTE operario (o None si no hay
    reserva suya para ese cliente)."""
    if cod_cliente is None:
        return None
    try:
        return evaluar_reservas(nro_operario).get(int(cod_cliente))
    except Exception:  # noqa: BLE001 — el grupo es informativo, no traba asignar
        return None


def estado_grupos(nro_operario: int) -> dict:
    """Polling del widget (cada ~30 s): latido + estado de TODAS las reservas
    del operario. Orden: primero las que piden decisión (oferta), después las
    que se auto-asignan, después el resto (más unidades listas primero)."""
    _tocar_operario(nro_operario)
    grupos = list(evaluar_reservas(nro_operario).values())
    grupos.sort(key=lambda g: (not g["oferta"], not g["autoAsignar"], -g["listos"], g["codCliente"]))
    return {"grupos": grupos}


def decidir_grupo(nro_operario: int, cod_cliente: int, accion: str) -> dict:
    """Botones Tomar / Esperar del widget.

    esperar: si la unidad activa del operario es de ese cliente y todavía no
      cerró, vuelve a la cola (reservada para él). La reserva pasa a "espera"
      con la cantidad de listas de ese momento como vara: cuando se sume una
      más, se le vuelve a preguntar.
    tomar: la reserva pasa a "tomado". Si el operario está libre, se le
      entrega YA la próxima unidad lista de ese cliente; si está con otro
      pedido, las del cliente le salen primero en el próximo Asignar."""
    if accion not in ("tomar", "esperar"):
        raise ValueError("Acción inválida")
    nombre = fetch_operario_nombre(nro_operario)
    if not nombre:
        raise ValueError(f"Operario {nro_operario} no encontrado")
    _asegurar_tabla_reserva()
    _tocar_operario(nro_operario)

    activa = _fetch_asignacion_activa(nro_operario)
    activa_abierta = activa is not None and not _fetch_asignacion_cerrada(activa)
    activa_es_del_cliente = activa_abierta and activa.get("codCliente") == cod_cliente

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (_LOCK_COLA,))
        cur.execute(
            'SELECT estado FROM deposito.control_reserva_cliente '
            'WHERE "codCliente" = %s AND "nroOperario" = %s FOR UPDATE',
            (cod_cliente, nro_operario),
        )
        if cur.fetchone() is None:
            conn.rollback()
            raise ValueError("Ese cliente ya no está reservado para vos")

        liberado = False
        asignado = None
        if accion == "esperar":
            if activa_es_del_cliente:
                cur.execute(
                    'UPDATE deposito.control_asignacion '
                    'SET "asignadoA" = NULL, "nroOperarioAsignado" = NULL, "asignadoEn" = NULL '
                    'WHERE id = %s AND "nroOperarioAsignado" = %s',
                    (activa["id"], nro_operario),
                )
                liberado = cur.rowcount > 0
            cur.execute(
                'UPDATE deposito.control_reserva_cliente '
                # Vara provisoria altísima: evaluar_reservas (abajo) la baja
                # sola a las listas reales de este momento (rama libres < vara).
                'SET estado = \'espera\', "listosAlDecidir" = 1000000, '
                '    "actualizadoEn" = now(), "vistoEn" = now() '
                'WHERE "codCliente" = %s',
                (cod_cliente,),
            )
        else:
            cur.execute(
                'UPDATE deposito.control_reserva_cliente '
                'SET estado = \'tomado\', "actualizadoEn" = now(), "vistoEn" = now() '
                'WHERE "codCliente" = %s',
                (cod_cliente,),
            )
            if not activa_abierta:
                row = _reclamar(cur, nro_operario, nombre, cod_cliente, solo_cliente=cod_cliente)
                if row:
                    asignado = _fila_json(row)
        conn.commit()
    finally:
        conn.close()

    grupo = grupo_de_cliente(nro_operario, cod_cliente)
    if asignado is not None:
        asignado["grupo"] = grupo
    return {
        "accion": accion,
        "liberado": liberado,
        "asignado": asignado,
        # Tomó pero está con otro pedido: las del cliente salen en el próximo Asignar.
        "despues": accion == "tomar" and activa_abierta and not activa_es_del_cliente,
        "grupo": grupo,
    }


def asignar_siguiente(nro_operario: int) -> dict:
    """Reclama, de forma atómica, el próximo pedido libre de la cola para
    `nro_operario` (resuelto a nombre igual que insert_error_mesa — no confía
    en lo que mande el cliente). Refresca la cola primero (agrega pedidos
    nuevos Cumplidos+Abiertos). Orden (2026-08-03): "prioridad" ascendente
    (1 = más urgente, NULL al final) y, dentro de cada prioridad, fecha
    ascendente — vacía los atrasados de cada prioridad antes de pasar a la
    siguiente (ver nota de ORDEN en el docstring del módulo).

    410 PRIMERO DE TODO (2026-08-25): antes que la afinidad
    y antes que la prioridad, la cola entrega los CompCodigo 410 (PED.NF.CEN,
    "pedido no facturable de centro"). Son los que no tienen que irse sin
    pasar por mesa, así que van al frente sin importar prioridad ni fecha.
    Entre varios 410 se desempata con el orden normal (afinidad, prioridad,
    fecha). El "410" sale de la columna "compCodigo" de la cola (ALTER en
    ever/sql/deposito_control_asignacion.sql) — en las filas viejas, cargadas
    antes de ese ALTER, viene NULL y se comportan como no-410.

    AFINIDAD POR CLIENTE (2026-08-25): después de eso,
    la cola prefiere un pedido del MISMO cliente que el último que reclamó
    ESE operario (`cod_cliente_afin`, dentro de AFINIDAD_CLIENTE_HORAS). Los 2
    pedidos de un mismo cliente le caen a la misma persona uno detrás del
    otro, en vez de repartirse entre 2 controladores. Es una preferencia, no
    un filtro: si no queda ningún pedido libre de ese cliente, sigue el orden
    normal de prioridad/fecha. Ojo: la afinidad pesa MÁS que la prioridad, así
    que un pedido prioridad 1 puede quedar un turno atrás del hermano del
    cliente anterior. Se eligió así a propósito — agrupar por cliente es lo
    que evita re-controlar el mismo mostrador dos veces.

    UN PEDIDO POR OPERARIO A LA VEZ (2026-07-31): antes de tocar la cola, se
    fija si `nro_operario` ya tiene una asignación activa todavía sin
    terminar — si es así, se le devuelve ESA MISMA fila (no cuenta como un
    reclamo nuevo). Solo si no tiene ninguna o la que tiene ya terminó se
    sigue con el flujo normal de reclamar la próxima libre.

    "Terminó" depende del tipo de fila (2026-08-21, ver
    _fetch_asignacion_cerrada): para acopio 70/75 la unidad es la VUELTA y
    termina cuando el remito pasó por mesa (FechaCierre > 0); para el resto
    es el pedido cerrado en Magnus, como siempre. Antes se usaba el gate del
    pedido para todo y un acopio dejaba al operario trabado para siempre.

    Concurrencia: el UPDATE con "SELECT ... FOR UPDATE SKIP LOCKED" hace que,
    si 2 operarios llaman a esto al mismo tiempo, cada uno se lleve una fila
    distinta (o uno de los dos se quede sin pedidos si la cola tiene 1 solo) —
    nunca el mismo pedido 2 veces.

    RESERVA POR CLIENTE (2026-09-23): la fila entregada reserva su cliente
    para este operario (ver bloque "RESERVA POR CLIENTE"). El reclamo nunca
    entrega filas de clientes reservados por otro operario ni de los que este
    dejó en "espera", y prioriza los clientes reservados por él (después de
    los 410). La respuesta trae "grupo" (resumen del cliente: listos, en
    preparación, si hay que preguntar Tomar/Esperar) o None.

    Lanza ValueError si el operario no existe o si no hay pedidos disponibles
    (cola vacía o todos ya asignados)."""
    nombre = fetch_operario_nombre(nro_operario)
    if not nombre:
        raise ValueError(f"Operario {nro_operario} no encontrado")

    _asegurar_tabla_reserva()
    _tocar_operario(nro_operario)

    activa = _fetch_asignacion_activa(nro_operario)
    if activa is not None and not _fetch_asignacion_cerrada(activa):
        # Sigue con lo suyo: se le devuelve LA MISMA fila. Para acopio "lo
        # suyo" es la vuelta (remito), no el pedido — ver
        # _fetch_asignacion_cerrada.
        activa["grupo"] = grupo_de_cliente(nro_operario, activa.get("codCliente"))
        return activa

    refrescar_cola()
    # Reservas por cliente (2026-09-23): vencer las inactivas, soltar las de
    # clientes sin unidades vivas y pasar a "tomado" las "espera" que ya
    # tienen todo listo — ANTES de reclamar, para que el orden de abajo las vea.
    try:
        evaluar_reservas()
    except Exception:  # noqa: BLE001 — sin reservas se asigna igual
        pass

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        # Cliente del ÚLTIMO pedido que reclamó este operario dentro de la
        # ventana de afinidad (None si no reclamó nada hace poco). Va aparte
        # y no dentro del UPDATE a propósito: mezclar un CTE con el
        # "FOR UPDATE SKIP LOCKED" del subquery es terreno resbaladizo en
        # Postgres, y que la afinidad quede un turno vieja no rompe nada.
        cur.execute(
            """
            SELECT "codCliente"
            FROM deposito.control_asignacion
            WHERE "nroOperarioAsignado" = %s
              AND "asignadoEn" IS NOT NULL
              AND "asignadoEn" > now() - (%s * interval '1 hour')
            ORDER BY "asignadoEn" DESC
            LIMIT 1
            """,
            (nro_operario, AFINIDAD_CLIENTE_HORAS),
        )
        _ult = cur.fetchone()
        cod_cliente_afin = _ult[0] if _ult else None

        # Todo lo que sigue va serializado: reclamo + alta de reserva. Sin el
        # lock, 2 operarios podrían llevarse 1 pedido cada uno del mismo
        # cliente antes de que exista la reserva.
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (_LOCK_COLA,))
        # Lo que tenía en "nuevo" y no contestó: ya lo controló, lo tomó.
        cur.execute(
            'UPDATE deposito.control_reserva_cliente SET estado = \'tomado\', '
            '"actualizadoEn" = now() WHERE "nroOperario" = %s AND estado = \'nuevo\'',
            (nro_operario,),
        )
        row = _reclamar(cur, nro_operario, nombre, cod_cliente_afin)
        out = _fila_json(row) if row else None
        if out is not None:
            _alta_reserva(cur, nro_operario, nombre, out)
        conn.commit()
    finally:
        conn.close()

    if out is None:
        raise ValueError("No hay pedidos disponibles para asignar")

    out["grupo"] = grupo_de_cliente(nro_operario, out.get("codCliente"))
    return out


# ── Historial: "Pedidos asignados" (vista /deposito/deposito → Mesas) ────────
# (2026-07-31, mismo día que se armó la cola): el "próximo
# paso" anotado en deposito_control_asignacion.sql ("listar qué se le asignó
# a X controlador") — vista de detalle, 1 fila por pedido YA reclamado
# ("asignadoEn" IS NOT NULL), para ver qué hizo cada operario.
#
# "Fecha"/"Hora" salen de "asignadoEn" (el momento real en que ESE operario
# reclamó el pedido), no de `fecha` (FechaPedido de Magnus, que puede ser
# muy anterior si el pedido esperó en la cola) — así son comparables contra
# "horaCierre" (mismo reloj).
#
# "horaCierre": no hay un cierre explícito por pedido (el widget no tiene un
# botón "Terminé"), así que se aproxima con la PRÓXIMA vez que ESE MISMO
# operario reclamó otro pedido (LEAD("asignadoEn") particionado por
# "nroOperarioAsignado", ordenado por "asignadoEn"). Es un proxy: si el
# operario todavía no reclamó uno nuevo (última fila de su partición),
# "horaCierre" viene NULL — se interpreta como "en curso" en la vista, no
# como dato faltante. Ver "UN PEDIDO POR OPERARIO A LA VEZ" arriba: mientras
# el pedido activo no cierra en Magnus, un reclamo repetido devuelve LA MISMA
# fila (no pisa "asignadoEn"), así que esta cuenta no se contamina con
# reclamos repetidos del mismo pedido.
#
# "cantidadItems": no vive en Postgres — se resuelve en un segundo paso contra
# Magnus (dbo.venfer_pedidoReng, mismo origen que mesa_control.py), COUNT(*)
# por NroMovVenta, en lote (IN) para toda la lista de pedidos del resultado.
def fetch_pedidos_asignados(desde: str | None = None, hasta: str | None = None) -> dict:
    """Historial de pedidos asignados (deposito.control_asignacion), con
    cantidad de ítems (Magnus) y "horaCierre" (próxima asignación del mismo
    operario). `desde`/`hasta` = 'YYYY-MM-DD', filtran por la FECHA de
    "asignadoEn". Sin ninguno de los dos: HOY. Excluye acopios (CompCodigo 75
    siempre; CompCodigo 70 salvo Prioridad 1/3, mismo criterio que
    SQL_MAGNUS_ABIERTOS_TODOS desde el FIX 2026-08-18) en vivo contra Magnus
    — ver comentario junto al filtro más abajo. Solo lectura."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        params: list = []
        if desde and hasta:
            cond = '"asignadoEn"::date BETWEEN %s AND %s'
            params = [desde, hasta]
        elif desde:
            cond = '"asignadoEn"::date >= %s'
            params = [desde]
        elif hasta:
            cond = '"asignadoEn"::date <= %s'
            params = [hasta]
        else:
            cond = '"asignadoEn"::date = CURRENT_DATE'
        cur.execute(
            f"""
            SELECT "nroPedido", "nroRemito", "codCliente", cliente,
                   "nroOperarioAsignado", "asignadoA", "asignadoEn",
                   LEAD("asignadoEn") OVER (
                       PARTITION BY "nroOperarioAsignado" ORDER BY "asignadoEn"
                   ) AS "horaCierre"
            FROM deposito.control_asignacion
            WHERE "asignadoEn" IS NOT NULL AND {cond}
            ORDER BY "asignadoEn" DESC
            """,
            params,
        )
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

    for r in rows:
        if r.get("asignadoEn") is not None:
            r["asignadoEn"] = r["asignadoEn"].isoformat()
        if r.get("horaCierre") is not None:
            r["horaCierre"] = r["horaCierre"].isoformat()

    # Excluye acopios (2026-08-03: CompCodigo 70 y 75 —
    # mismo criterio que SQL_MAGNUS_ABIERTOS_TODOS). Esa exclusión en la cola solo
    # frena pedidos NUEVOS al refrescar — pedidos que ya habían quedado
    # guardados en deposito.control_asignacion (de antes del fix, o insertados
    # por otra vía) seguían apareciendo acá porque este historial no
    # filtraba nada, solo leía la tabla. Se filtra en vivo contra
    # VenFer_PedidoCabecera.CompCodigo ANTES de calcular cantidadItems, así
    # ni "Desglose por operario" ni "Detalle por pedido" (ambos salen de
    # `rows`) lo cuentan — ej. pedido 748595 (CompCodigo 70, Flores Marcos).
    #
    # FIX 2026-08-18: CompCodigo 70 deja de excluirse
    # entero — ahora entra al historial si Prioridad IN (1, 3), mismo
    # criterio que SQL_MAGNUS_ABIERTOS_TODOS (ver ese comentario para el
    # motivo). CompCodigo 75 se sigue excluyendo siempre, sin cambios. Por
    # eso ahora también se trae Prioridad, no solo CompCodigo.
    nros = sorted({r["nroPedido"] for r in rows if r.get("nroPedido") is not None})
    meta_pedido: dict[int, tuple[int | None, int | None]] = {}  # nro -> (CompCodigo, Prioridad)
    items_por_pedido: dict[int, int] = {}
    if nros:
        conn = get_connection("EVERWEAR")
        try:
            cur = conn.cursor()
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
            CH = 1000
            for i in range(0, len(nros), CH):
                chunk = nros[i : i + CH]
                ph = ",".join("?" for _ in chunk)
                cur.execute(
                    f"SELECT NroMovVenta, CompCodigo, Prioridad FROM dbo.VenFer_PedidoCabecera "
                    f"WHERE NroMovVenta IN ({ph})",
                    chunk,
                )
                for nro, comp, prioridad in cur.fetchall():
                    meta_pedido[int(nro)] = (
                        int(comp) if comp is not None else None,
                        int(prioridad) if prioridad is not None else None,
                    )

            # 2026-08-21: una fila de acopio con "nroRemito" > 0 es una VUELTA
            # controlada de verdad (el operario la trabajó y la mesa la cerró)
            # — tiene que contar en el historial. Lo que se sigue excluyendo
            # es la basura vieja: filas de acopio SIN remito, que son las que
            # entraron por error antes del FIX 2026-08-04 y trababan el
            # puesto (ej. pedido 748595, CompCodigo 70, Flores Marcos). El
            # criterio "Prioridad 1/3" del FIX 2026-08-18 se descarta: era un
            # workaround de que el pedido de acopio no cierra nunca.
            def _es_acopio_sin_vuelta(r: dict) -> bool:
                comp, _prioridad = meta_pedido.get(r["nroPedido"], (None, None))
                if comp not in (70, 75):
                    return False
                return not (r.get("nroRemito") or 0)

            rows = [r for r in rows if not _es_acopio_sin_vuelta(r)]
            nros = sorted({r["nroPedido"] for r in rows if r.get("nroPedido") is not None})

            for i in range(0, len(nros), CH):
                chunk = nros[i : i + CH]
                ph = ",".join("?" for _ in chunk)
                cur.execute(
                    f"SELECT NroMovVenta, COUNT(*) FROM dbo.venfer_pedidoReng "
                    f"WHERE NroMovVenta IN ({ph}) GROUP BY NroMovVenta",
                    chunk,
                )
                for nro, cnt in cur.fetchall():
                    items_por_pedido[int(nro)] = int(cnt)
        finally:
            conn.close()

    for r in rows:
        r["cantidadItems"] = items_por_pedido.get(r["nroPedido"], 0)

    return {"pedidos": rows}


def fetch_cola_diag(limit: int = 20) -> dict:
    """Diagnóstico: cuántos pedidos libres/asignados hay en la cola ahora
    mismo + una muestra, para confirmar que el cruce WMS/Magnus está trayendo
    datos antes de que un operario se quede "Sin pedidos para asignar"."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            'SELECT COUNT(*) FILTER (WHERE "asignadoEn" IS NULL), '
            '       COUNT(*) FILTER (WHERE "asignadoEn" IS NOT NULL) '
            "FROM deposito.control_asignacion"
        )
        libres, asignados = cur.fetchone()
        cur.execute(
            'SELECT "nroPedido", "nroRemito", fecha, "prioridad", cliente, ubicacion, "asignadoA", "asignadoEn" '
            'FROM deposito.control_asignacion '
            'ORDER BY "createdAt" DESC LIMIT %s',
            (limit,),
        )
        cols = [c[0] for c in cur.description]
        muestra = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()
    for m in muestra:
        if m.get("fecha") is not None:
            m["fecha"] = m["fecha"].isoformat()
        if m.get("asignadoEn") is not None:
            m["asignadoEn"] = m["asignadoEn"].isoformat()
    return {"libres": libres, "asignados": asignados, "muestra": muestra}
