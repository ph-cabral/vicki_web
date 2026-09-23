"""Verificación de picking_disponible.py SIN tocar Magnus/WMS.

Correr desde cualquier lado: `python indicadores-api/test_picking_disponible.py`.
Se stubean `db` y `deposito` (que arrastran pyodbc/psycopg) y se alimenta un
cursor falso que responde las tres consultas del módulo según el texto del SQL.
Lo que se prueba es la ARMADURA: el descuento de lo que piden las otras OT
sobre la misma posición, la clasificación en repo_pedida / reponer / faltante,
las ubicaciones que NO son guardado real y los descartes (pedido cancelado,
buzón de mercadería).
"""
import os, sys, types
from datetime import datetime, timedelta

_AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _AQUI)

# ── stubs ────────────────────────────────────────────────────────────────────
HOY = datetime.now()

DEMANDA_COLS = [
    "OTId", "NroMovVenta", "NroRemito", "OTEstado", "OTFechaHoraRegist", "OTClienteNombre",
    "Armador", "CodArticulo", "Posicion", "Pendiente",
]
# OT 1 (Molina)   → A-SOBRA ok · A-FALTA sin stock en ningún lado
# OT 2 (Carossio) → A-COMPET compite con la OT 3 por la misma posición
#                 · A-GUARD hay en guardado · A-REPO tiene OT de repo en camino
# OT 3 (Carossio) → A-COMPET (la otra mitad de la competencia)
# OT 4            → pedido CANCELADO en Magnus, se descarta entera
# OT 5            → buzón "Mercaderia X Llegar", se descarta entera
# OT 6            → todo OK, no tiene que aparecer
# OT 7            → PLAYA_PEDIDOS sin stock: faltante, nunca "reponer"
# OT 8            → A-PULMON sólo tiene material a granel: faltante, no "reponer"
# OT 9            → A-PARCIAL tiene en guardado MENOS de lo que falta: faltante,
#                   pero algo se puede bajar → tiene que seguir mostrándose
# OT 10           → A-OTRODEP sólo tiene guardado en el depósito 02: no cuenta
# OT 11           → A-REPOPARCIAL: la reposición en camino cubre SÓLO PARTE del
#                   faltante (30 de 50) → se resta, quedan 20, sigue "reponer"
# OT 12           → sin armador ("— Sin asignar"): DESDE 2026-09-23 ENTRA, en
#                   el último escalón del FIFO (anticipa el faltante)
# OT 13           → acopio 70 con remito vivo: entra
# OT 14           → acopio 75 con remito anulado: no entra
# OT 15           → acopio 70 con remito vivo pero de hace 30 días: no entra
# OT 16           → pedido cod.10 ya Cerrado en Magnus: no entra
# OT 17           → sin armador, MÁS VIEJA que la 2 y la 3, sobre A-COMPET: no
#                   les puede sacar el estante a las asignadas
# Pedido 900020   → abierto SIN OT: A-SINOT contra su posición de UbicacionItem
# Pedido 900021   → abierto SIN OT: A-SINPOS no tiene posición de picking
# Pedido 900022   → abierto "sin OT" en Magnus pero el WMS ya tiene su OT: afuera
DEMANDA = [
    (1, 900001, 0, 1, HOY, "CLIENTE UNO",  "Molina Martina", "A-SOBRA",  "01-10-01-01", 5),
    (1, 900001, 0, 1, HOY, "CLIENTE UNO",  "Molina Martina", "A-FALTA",  "01-10-01-02", 3),
    (2, 900002, 0, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-COMPET", "01-11-01-01", 60),
    (2, 900002, 0, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-GUARD",  "01-12-01-01", 40),
    (2, 900002, 0, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-GUARD",  "01-12-01-01", 10),  # mismo par, se agrupa
    (2, 900002, 0, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-REPO",   "01-13-01-01", 100),
    (3, 900003, 0, 5, HOY, "CLIENTE TRES", "Carossio Jose",  "A-COMPET", "01-11-01-01", 50),
    (4, 900004, 0, 1, HOY, "CLIENTE CUATRO", "Aramayo Marcelo", "A-FALTA", "01-10-01-02", 7),
    (5, 900005, 0, 1, HOY, "CLIENTE CINCO", "Mercaderia X Llegar", "A-FALTA", "01-10-01-02", 9),
    (6, 900006, 0, 1, HOY, "CLIENTE SEIS", "Molina Martina", "A-SOBRA",  "01-10-01-01", 1),
    (7, 900007, 0, 1, HOY, "CLIENTE SIETE", "Molina Martina", "A-PLAYA", "PLAYA_PEDIDOS", 4),
    (8, 900008, 0, 1, HOY, "CLIENTE OCHO", "Molina Martina", "A-PULMON", "01-14-01-01", 25),
    (9, 900009, 0, 1, HOY, "CLIENTE NUEVE", "Molina Martina", "A-PARCIAL", "01-15-01-01", 100),
    (10, 900010, 0, 1, HOY, "CLIENTE DIEZ", "Molina Martina", "A-OTRODEP", "01-16-01-01", 20),
    (11, 900011, 0, 1, HOY, "CLIENTE ONCE", "Molina Martina", "A-REPOPARCIAL", "01-17-01-01", 50),
    (12, 900012, 0, 1, HOY, "CLIENTE DOCE", None, "A-FALTA", "01-10-01-02", 6),
    (13, 900013, 555001, 1, HOY, "CLIENTE ACOPIO", "Molina Martina", "A-ACOPIO", "01-19-01-01", 10),
    (14, 900014, 555002, 1, HOY, "CLIENTE ACOPIO2", "Molina Martina", "A-FALTA", "01-10-01-02", 8),
    (15, 900015, 555003, 1, HOY - timedelta(days=30), "CLIENTE ACOPIO3", "Molina Martina", "A-FALTA", "01-10-01-02", 8),
    (16, 900016, 0, 1, HOY, "CLIENTE CERRADO", "Molina Martina", "A-FALTA", "01-10-01-02", 8),
    (17, 900017, 0, 1, HOY - timedelta(days=1), "CLIENTE VIEJO", None, "A-COMPET", "01-11-01-01", 50),
    (18, 900018, 0, 1, HOY, "CLIENTE APARTADO", None, "A-FALTA", "01-10-01-02", 5),
]
# (art, ubic, cant, es_pick, es_guard)
STOCK = [
    ("A-SOBRA",  "01-10-01-01", 500, 1, 0),
    ("A-COMPET", "01-11-01-01", 80,  1, 0),   # 80 para 110 pedidos entre 2 OT
    ("A-COMPET", "01-11-01-01-DER", 900, 0, 1),
    ("A-GUARD",  "01-12-01-01", 10,  1, 0),
    ("A-GUARD",  "01-12-01-01-IZQ", 400, 0, 1),
    ("A-REPO",   "01-13-01-01", 20,  1, 0),
    ("A-REPO",   "01-13-01-01-DER", 5, 0, 1),  # no alcanza: lo que salva es la repo
    ("A-PULMON", "01-14-01-01", 0,   1, 0),
    ("A-PULMON", "PULMON_INGRESO", 9000, 0, 1),   # a granel: NO es reposición
    ("A-PULMON", "NO_CONFORME",    500,  0, 1),   # tampoco
    ("A-PLAYA",  "01-40-01-01", 300, 1, 0),       # tiene en un estante, pero el pedido es de playa
    ("A-PARCIAL", "01-15-01-01", 0,  1, 0),
    ("A-PARCIAL", "01-15-01-01-DER", 30, 0, 1),   # 30 para 100: alcanza para un viaje
    ("A-OTRODEP", "01-16-01-01", 0,  1, 0),
    ("A-OTRODEP", "02-22-06-04-izq", 500, 0, 1),  # otro depósito: no se baja acá
    ("A-REPOPARCIAL", "01-17-01-01", 0, 1, 0),
    ("A-REPOPARCIAL", "01-17-01-01-DER", 100, 0, 1),  # guardado de sobra
    ("A-ACOPIO", "01-19-01-01", 4, 1, 0),
    ("A-ACOPIO", "01-19-01-01-DER", 100, 0, 1),
    ("A-SINOT", "01-18-01-01", 2, 1, 0),
    ("A-SINOT", "01-18-02-01-IZQ", 50, 0, 1),
    ("A-SINPOS", "01-20-01-01-DER", 20, 0, 1),     # hay guardado pero no hay estante
]
# Magnus: (CompCodigo, EstadoPedido) por pedido. Todo 10/Abierto salvo:
PEDIDOS = {n: (10, 2) for n in range(900001, 900030)}
PEDIDOS[900004] = (10, 7)     # cancelado / baja
PEDIDOS[900016] = (10, 4)     # cerrado
PEDIDOS[900013] = (70, 4)     # acopio: cabecera en 4 con la vuelta viva
PEDIDOS[900014] = (75, 4)
PEDIDOS[900015] = (70, 4)
APARTADOS = {900018}          # Magnus: CodArmador 239 aunque la OT no lo tenga
REMITOS_OK = {555001, 555003}  # el 555002 está anulado
SIN_OT_COLS = ["NroMovVenta", "CompCodigo", "FechaPedido", "HoraRegistracion",
               "Cliente", "CodArticulo", "Pendiente"]
SIN_OT = [
    (900020, 10, 82449, 3185540, "CLIENTE VEINTE", "A-SINOT", 7),
    (900021, 10, 82449, 3200000, "CLIENTE VEINTIUNO", "A-SINPOS", 3),
    (900022, 10, 82449, 3300000, "CLIENTE VEINTIDOS", "A-SOBRA", 1),
]
CON_OT = {900022}
# (art, ubic, StkMaximo) — sólo ubicaciones EsPicking
POS_PICK = [
    ("A-SINOT", "01-18-01-01", 500),
    ("A-SINOT", "01-18-09-09", 10),     # secundaria, menor capacidad
]
# (art, ubic, en_camino)
REPO = [
    ("A-REPO", "01-13-01-01", 200),
    ("A-REPOPARCIAL", "01-17-01-01", 30),   # cubre 30 de los 50 que faltan
]


class FakeCursor:
    def __init__(self):
        self.description = None
        self._rows = []

    def execute(self, sql, params=None):
        if "SELECT DISTINCT OT." in sql:
            self.description = None
            self._rows = [(n,) for n in (params or []) if n in CON_OT]
        elif "UbicacionItem" in sql:
            arts = set(params or [])
            self.description = None
            self._rows = [r for r in POS_PICK if r[0] in arts]
        elif "VenFer_PedidoReng" in sql:
            self.description = [(c,) for c in SIN_OT_COLS]
            self._rows = list(SIN_OT)
        elif "VenFer_RmtoCabecera" in sql:
            self.description = None
            self._rows = [(n,) for n in (params or []) if n in REMITOS_OK]
        elif "VenFer_PedidoCabecera" in sql:
            self.description = None
            self._rows = [(n, *PEDIDOS[n], 1 if n in APARTADOS else 0)
                          for n in (params or []) if n in PEDIDOS]
        elif "CodotProcesoNegocio = 4" in sql:
            self.description = [(c,) for c in DEMANDA_COLS]
            self._rows = list(DEMANDA)
        elif "UbicacionDetalle" in sql:
            pedidos = set(params or [])
            self.description = None
            self._rows = [r for r in STOCK if r[0] in pedidos]
        elif "CodotProcesoNegocio = 1" in sql:
            pedidos = set(params or [])
            self.description = None
            self._rows = [r for r in REPO if r[0] in pedidos]
        else:
            self._rows = []

    def fetchall(self):
        return self._rows


class FakeConn:
    def cursor(self):
        return FakeCursor()

    def close(self):
        pass


db = types.ModuleType("db")
db.get_connection = lambda *a, **k: FakeConn()
sys.modules["db"] = db

dep = types.ModuleType("deposito")
dep.OT_COL_PEDIDO = "OTNroMovVenta"
dep.PATRONES_CANCELADO = ("CANCEL",)
dep.WMS_ESTADOS_VIVOS = (0, 1, 5)
dep.WMS_ESTADO_LABELS = {
    0: {"label": "Pendiente", "bucket": "espera"},
    1: {"label": "Pendiente", "bucket": "espera"},
    5: {"label": "En proceso", "bucket": "proceso"},
}
dep._es_operario_merca = lambda n: str(n or "").strip().lower().startswith("mercaderia x llegar")
# picking_disponible.py pasó a usar es_operario_ignorado() (buzón + lista de
# OPERARIOS_IGNORADOS) en vez de _es_operario_merca(); este stub se había
# quedado atrás y rompía el import. Se mapea sólo al buzón (no a la lista de
# ignorados de producción) porque este corpus de prueba usa "Carossio Jose"
# como armador real de varias OT (A-COMPET, A-GUARD, A-REPO...).
dep.es_operario_ignorado = dep._es_operario_merca
dep._txt = lambda v: str(v).strip() if v is not None else ""
dep._safe = lambda v, c="": v
dep._int = lambda v: int(v) if v is not None else None
dep._info_articulos = lambda cods: {c: {"Nombre": f"ART {c}"} for c in cods}
dep._info_pedidos_resumen = lambda peds: {900004: {"CompCodigo": 10, "Estado": "Cancelado"}}
sys.modules["deposito"] = dep

import picking_disponible as pd  # noqa: E402

ok = fail = 0


def check(nombre, got, want):
    global ok, fail
    if got == want:
        ok += 1
        print(f"  ok   {nombre}")
    else:
        fail += 1
        print(f"  FAIL {nombre}\n       got={got!r}\n       want={want!r}")


data = pd.fetch_picking_disponible()
ots = {o["OTId"]: o for o in data["ots"]}
def fila(otid, cod):
    return next((r for r in ots[otid]["rows"] if r["CodArticulo"] == cod), None)

print("\n=== qué OT entran ===")
check("OT con problema", sorted(ots),
      [-900021, -900020, 1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 17])
check("OT 4 (pedido cancelado) descartada", 4 in ots, False)
check("OT 5 (buzón mercadería) descartada", 5 in ots, False)
check("OT 6 (todo ok) no aparece", 6 in ots, False)
check("renglones descartados (cancelado + cerrado)", data["resumen"]["renglonesDescartados"], 2)
check("OT 16 (pedido cerrado) descartada", 16 in ots, False)
check("renglones apartados (buzón WMS + apartado en Magnus)",
      data["resumen"]["renglonesEsperaMercaderia"], 2)
check("OT 18 (apartada en Magnus, sin armador en WMS) descartada", 18 in ots, False)
check("OT 12 (sin asignar) ENTRA", 12 in ots, True)
check("OT 12 marcada sin asignar", ots[12]["Asignada"], False)
check("renglones sin asignar (OT 12, OT 17, 2 pedidos sin OT)",
      data["resumen"]["renglonesSinAsignar"], 4)
check("A-FALTA de la asignada no se ve afectada", fila(1, "A-FALTA")["AReponer"], 3.0)
check("A-FALTA de la OT 12 anticipa su faltante", fila(12, "A-FALTA")["AReponer"], 6.0)

print("\n=== acopio 70/75: sólo la vuelta con remito vivo ===")
check("OT 13 (acopio con remito) entra", 13 in ots, True)
check("OT 13 marcada acopio", ots[13]["Acopio"], True)
check("A-ACOPIO a reponer 10 - 4", fila(13, "A-ACOPIO")["AReponer"], 6.0)
check("OT 14 (remito anulado) no entra", 14 in ots, False)
check("OT 15 (vuelta vieja) no entra", 15 in ots, False)
check("contador acopio sin remito", data["resumen"]["renglonesAcopioSinRemito"], 1)
check("contador acopio fuera de ventana", data["resumen"]["renglonesAcopioFueraVentana"], 1)
check("vueltas de acopio", data["resumen"]["vueltasAcopio"], 1)

print("\n=== escalones del FIFO: lo asignado consume primero ===")
c17 = fila(17, "A-COMPET")
check("OT 17 (sin armador, más vieja) no le saca el estante a las asignadas",
      c17["Disponible"], 0.0)
check("OT 17 a reponer 50", c17["AReponer"], 50.0)
check("OT 17 ve lo ya comprometido (80)", c17["OtrasOT"], 80.0)

print("\n=== pedidos abiertos que todavía no tienen OT ===")
so = fila(-900020, "A-SINOT")
check("pedido sin OT usa la posición de UbicacionItem de mayor capacidad", so["Posicion"], "01-18-01-01")
check("A-SINOT a reponer 7 - 2", so["AReponer"], 5.0)
check("A-SINOT reponer", so["Situacion"], "reponer")
check("pedido sin OT marcado", ots[-900020]["SinOT"], True)
check("pedido sin OT trae su NroMovVenta", ots[-900020]["NroMovVenta"], 900020)
check("hora de registro en centésimas", ots[-900020]["Registrada"], "2026-09-23 08:50")
sp = fila(-900021, "A-SINPOS")
check("A-SINPOS sin posición", sp["Posicion"], pd.SIN_POSICION)
check("A-SINPOS faltante (no hay estante al que reponer)", sp["Situacion"], "faltante")
check("A-SINPOS se oculta del widget", sp["SinRepo"], True)
check("A-SINPOS flag", sp["SinPosicion"], True)
check("pedido que ya tiene OT en el WMS no se duplica", -900022 in ots, False)
check("resumen pedidos sin OT", data["resumen"]["pedidosSinOT"], 2)

print("\n=== solo_problemas: la fila OK no viaja ===")
check("OT 1 trae 1 fila", len(ots[1]["rows"]), 1)
check("OT 1 tiene 2 renglones", ots[1]["Renglones"], 2)
check("A-SOBRA no está", fila(1, "A-SOBRA"), None)

print("\n=== faltante real ===")
f = fila(1, "A-FALTA")
check("A-FALTA situación", f["Situacion"], "faltante")
check("A-FALTA disponible", f["Disponible"], 0.0)
check("A-FALTA a reponer", f["AReponer"], 3.0)
check("A-FALTA sin guardado", f["EnGuardado"], 0.0)
check("A-FALTA no hay de dónde reponer", f["SinRepo"], True)

print("\n=== dos OT compitiendo por la misma posición (reparto FIFO) ===")
# 80 en el estante, la OT 2 (más vieja) pide 60 y la OT 3 pide 50. La primera
# se lleva las 60 y SÓLO la segunda queda corta: marcar a las dos contaría el
# faltante dos veces (60 a reponer cuando en realidad faltan 30).
c2, c3 = fila(2, "A-COMPET"), fila(3, "A-COMPET")
check("la OT vieja no queda corta", c2, None)
check("A-COMPET en la posición", c3["EnPosicion"], 80.0)
check("A-COMPET ya comprometido antes", c3["OtrasOT"], 60.0)
check("A-COMPET disponible = 80 - 60", c3["Disponible"], 20.0)
check("A-COMPET a reponer = 50 - 20", c3["AReponer"], 30.0)
check("A-COMPET hay en guardado", c3["Situacion"], "reponer")

print("\n=== agrupado de renglones repetidos ===")
g = fila(2, "A-GUARD")
check("A-GUARD pedido agrupado 40+10", g["Pedido"], 50.0)
check("A-GUARD situación", g["Situacion"], "reponer")
check("A-GUARD a reponer", g["AReponer"], 40.0)

print("\n=== reposición ya generada: cubre TODO el faltante ===")
r = fila(2, "A-REPO")
check("A-REPO situación", r["Situacion"], "repo_pedida")
check("A-REPO se neutraliza del todo (a reponer neto)", r["AReponer"], 0.0)
check("A-REPO en camino (informativo, sin descontar)", r["RepoEnCamino"], 200.0)
check("A-REPO no toca el guardado (no hizo falta)", r["EnGuardado"], 5.0)

print("\n=== reposición ya generada: cubre SÓLO PARTE del faltante ===")
# Faltaban 50, hay una OT de reposición viva por 30 → quedan 20 por resolver
# (no 50 de nuevo) y con guardado de sobra se resuelve como "reponer".
rp = fila(11, "A-REPOPARCIAL")
check("A-REPOPARCIAL resta lo que ya está en camino (50 - 30 = 20)", rp["AReponer"], 20.0)
check("A-REPOPARCIAL en camino", rp["RepoEnCamino"], 30.0)
check("A-REPOPARCIAL sigue mostrándose (no se oculta)", rp["Situacion"], "reponer")
check("A-REPOPARCIAL guardado de sobra, sin consumir en el detalle", rp["EnGuardado"], 100.0)

print("\n=== PLAYA_PEDIDOS nunca ofrece reposición ===")
p = fila(7, "A-PLAYA")
check("A-PLAYA marcada", p["EsPlaya"], True)
check("A-PLAYA situación", p["Situacion"], "faltante")
check("A-PLAYA no cuenta el estante como disponible", p["Disponible"], 0.0)
check("A-PLAYA ve el otro picking", p["OtroPicking"], 300.0)

print("\n=== pulmón y ubicaciones especiales no son guardado ===")
u = fila(8, "A-PULMON")
check("A-PULMON situación", u["Situacion"], "faltante")
check("A-PULMON guardado en cero", u["EnGuardado"], 0.0)
check("A-PULMON a granel informado", u["EnPulmon"], 9000.0)
check("A-PULMON no se puede reponer", u["SinRepo"], True)

print("\n=== faltante que SÍ se puede reponer en parte ===")
pa = fila(9, "A-PARCIAL")
check("A-PARCIAL situación", pa["Situacion"], "faltante")
check("A-PARCIAL a reponer", pa["AReponer"], 100.0)
check("A-PARCIAL hay 30 en guardado", pa["EnGuardado"], 30.0)
check("A-PARCIAL no se oculta", pa["SinRepo"], False)

print("\n=== el guardado de otro depósito no cuenta ===")
od = fila(10, "A-OTRODEP")
check("A-OTRODEP situación", od["Situacion"], "faltante")
check("A-OTRODEP guardado del 02 ignorado", od["EnGuardado"], 0.0)
check("A-OTRODEP se oculta", od["SinRepo"], True)
check("deposito_de 01-15-01-01", pd.deposito_de("01-15-01-01"), 1)
check("deposito_de 02-22-06-04-izq", pd.deposito_de("02-22-06-04-izq"), 2)
check("deposito_de 010-09-04-04-24-01 (0 de más)", pd.deposito_de("010-09-04-04-24-01"), 1)
check("deposito_de SE01-09-04-02-10-02", pd.deposito_de("SE01-09-04-02-10-02"), 1)
check("deposito_de PLAYA_PEDIDOS", pd.deposito_de("PLAYA_PEDIDOS"), None)
check("deposito_de vacío", pd.deposito_de(""), None)

print("\n=== resumen ===")
check("faltantes reales", data["resumen"]["faltanteReal"], 7)
check("faltantes sin nada para reponer", data["resumen"]["faltanteSinRepo"], 6)
check("para bajar de guardado (A-COMPET x2, A-GUARD, A-REPOPARCIAL, A-ACOPIO, A-SINOT)",
      data["resumen"]["hayParaReponer"], 6)
check("repo pedida", data["resumen"]["repoPedida"], 1)
check("artículos ocultos en la vista por pasillo",
      data["resumen"]["articulosOcultosSinRepo"], 5)
check("orden: primero las que tienen faltante", data["ots"][0]["Faltantes"] > 0, True)

print("\n=== pasillo_de: el 2º segmento, con las trampas de la base ===")
casos = [
    ("01-36-10-04", "36"),          # rack normal
    ("01-07-01-01-DER", "07"),      # con lado
    ("01-16-08-O", "16"),           # nivel con letra
    ("01-34-04--03-DER", "34"),     # doble guión
    ("01-09-04-06-15-02", "SOBRESTOCK"),     # zona de sobrestock, no pasillo 09
    ("01-09-04-05-06-04-D", "SOBRESTOCK"),   # sobrestock con lado
    ("010-09-04-04-24-01", "SOBRESTOCK"),    # un 0 de más
    ("SE01-09-04-02-10-02", "SOBRESTOCK"),   # prefijo de letras
    ("01-06-13-01-TRAMO", "06"),
    ("PLAYA_PEDIDOS", "PLAYA_PEDIDOS"),      # con nombre: su propio grupo
    ("PULMON_INGRESO", "PULMON_INGRESO"),
    ("CARRO25", "CARRO25"),
    ("", "?"),
]
for ubic, esperado in casos:
    check("%-22s" % (ubic or "(vacío)"), pd.pasillo_de(ubic), esperado)
check("orden: los numéricos antes que los con nombre",
      sorted(["SOBRESTOCK", "07", "36", "PLAYA_PEDIDOS", "02"], key=pd._orden_pasillo),
      ["02", "07", "36", "PLAYA_PEDIDOS", "SOBRESTOCK"])

print("\n=== vista por pasillo: sólo lo que se puede reponer ===")
pas = {g["Pasillo"]: g for g in data["porPasillo"]}
check("pasillos con algo que reponer", sorted(pas), ["11", "12", "15", "17", "18", "19"])
check("SIN_POSICION nunca viaja", pd.SIN_POSICION in pas, False)
check("A-SINOT: 1 pedido sin asignar", pas["18"]["rows"][0]["SinAsignar"], 1)
check("A-FALTA (nada en ningún lado) no viaja", "10" in pas, False)
check("PLAYA_PEDIDOS nunca viaja", "PLAYA_PEDIDOS" in pas, False)
check("A-PULMON (sólo granel) no viaja", "14" in pas, False)
check("A-OTRODEP (guardado en otro depósito) no viaja", "16" in pas, False)
check("A-REPO (neutralizado del todo por la reposición en camino) no viaja",
      "13" in pas, False)
check("A-PARCIAL sí viaja", pas["15"]["rows"][0]["AReponer"], 100.0)
check("A-REPOPARCIAL viaja con el faltante YA reducido", pas["17"]["AReponer"], 20.0)
check("A-REPOPARCIAL sigue en 'reponer', no desaparece del todo",
      pas["17"]["rows"][0]["Situacion"], "reponer")

g11 = pas["11"]["rows"][0]
check("A-COMPET: una sola fila aunque la pidan 2 OT", len(pas["11"]["rows"]), 1)
check("A-COMPET OTs", g11["OTs"], 3)
check("A-COMPET de esas, sin asignar", g11["SinAsignar"], 1)
check("A-COMPET hay (sin contar 2 veces la misma posición)", g11["Hay"], 80.0)
check("A-COMPET pedido total 60+50+50", g11["Pedido"], 160.0)
check("A-COMPET a reponer (30 de la 3ª + 50 anticipados de la 17)", g11["AReponer"], 80.0)

g12 = pas["12"]["rows"][0]
check("A-GUARD suma los 2 renglones de la misma OT", g12["Pedido"], 50.0)
check("A-GUARD una sola OT", g12["OTs"], 1)

check("pasillos ordenados", [g["Pasillo"] for g in data["porPasillo"]],
      ["11", "12", "15", "17", "18", "19"])

print("\n=== todos los renglones (cartel de una OT) ===")
uno = pd.fetch_picking_disponible_ot(6)["ot"]
check("OT 6 aparece con solo_con_problema=False", uno is not None and uno["OTId"], 6)
check("OT 6 trae su fila OK", uno["rows"][0]["Situacion"], "ok")


print("\n=== armado de la OT de reposición: elección del origen ===")
# _elegir_origenes es pura: recibe los candidatos ya filtrados y reparte.
def cands(*t):
    return [{"ubic": u, "pasillo": p, "libre": float(c), "desde": d} for u, p, c, d in t]

uno = cands(("01-37-17-03-DER", "37", 50, "2026-01-01"))
r = pd._elegir_origenes("37", 3, uno)
check("un solo origen alcanza", [(x["Ubicacion"], x["Cantidad"]) for x in r],
      [("01-37-17-03-DER", 3.0)])
check("descuenta lo ya tomado del candidato", uno[0]["libre"], 47.0)

# Mismo pasillo primero aunque el de otro pasillo sea más viejo: el repositor
# ya está parado ahí.
c2 = cands(("01-09-04-01-01-01", "SOBRESTOCK", 100, "2020-01-01"),
           ("01-37-17-03-DER", "37", 100, "2026-05-05"))
check("gana el mismo pasillo", pd._elegir_origenes("37", 10, c2)[0]["Ubicacion"],
      "01-37-17-03-DER")
check("marca si es del mismo pasillo", pd._elegir_origenes("37", 1, c2)[0]["MismoPasillo"], True)

# Entre dos del mismo pasillo manda el FIFO (lo más viejo sale antes).
c3 = cands(("01-37-01-01-DER", "37", 100, "2026-08-08"),
           ("01-37-02-01-DER", "37", 100, "2026-02-02"))
check("FIFO: sale lo más viejo", pd._elegir_origenes("37", 5, c3)[0]["Ubicacion"],
      "01-37-02-01-DER")

# Si una no cubre, se parte en varios renglones.
c4 = cands(("01-37-01-01-DER", "37", 4, "2026-02-02"),
           ("01-37-02-01-DER", "37", 30, "2026-03-03"))
r4 = pd._elegir_origenes("37", 10, c4)
check("parte el renglón en dos ubicaciones", [(x["Ubicacion"], x["Cantidad"]) for x in r4],
      [("01-37-01-01-DER", 4.0), ("01-37-02-01-DER", 6.0)])

# Guardado insuficiente: devuelve lo que hay (el viaje sirve igual) y el
# llamador lo reporta en sinOrigen.
c5 = cands(("01-37-01-01-DER", "37", 7, "2026-02-02"))
check("cubre parcial", sum(x["Cantidad"] for x in pd._elegir_origenes("37", 100, c5)), 7.0)
check("sin candidatos no inventa renglones", pd._elegir_origenes("37", 5, []), [])

print(f"\n{ok} ok / {fail} fail")
sys.exit(1 if fail else 0)
