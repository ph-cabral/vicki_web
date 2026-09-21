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
    "OTId", "NroMovVenta", "OTEstado", "OTFechaHoraRegist", "OTClienteNombre",
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
DEMANDA = [
    (1, 900001, 1, HOY, "CLIENTE UNO",  "Molina Martina", "A-SOBRA",  "01-10-01-01", 5),
    (1, 900001, 1, HOY, "CLIENTE UNO",  "Molina Martina", "A-FALTA",  "01-10-01-02", 3),
    (2, 900002, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-COMPET", "01-11-01-01", 60),
    (2, 900002, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-GUARD",  "01-12-01-01", 40),
    (2, 900002, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-GUARD",  "01-12-01-01", 10),  # mismo par, se agrupa
    (2, 900002, 1, HOY, "CLIENTE DOS",  "Carossio Jose",  "A-REPO",   "01-13-01-01", 100),
    (3, 900003, 5, HOY, "CLIENTE TRES", "Carossio Jose",  "A-COMPET", "01-11-01-01", 50),
    (4, 900004, 1, HOY, "CLIENTE CUATRO", "Aramayo Marcelo", "A-FALTA", "01-10-01-02", 7),
    (5, 900005, 1, HOY, "CLIENTE CINCO", "Mercaderia X Llegar", "A-FALTA", "01-10-01-02", 9),
    (6, 900006, 1, HOY, "CLIENTE SEIS", "Molina Martina", "A-SOBRA",  "01-10-01-01", 1),
    (7, 900007, 1, HOY, "CLIENTE SIETE", "Molina Martina", "A-PLAYA", "PLAYA_PEDIDOS", 4),
    (8, 900008, 1, HOY, "CLIENTE OCHO", "Molina Martina", "A-PULMON", "01-14-01-01", 25),
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
]
# (art, ubic, en_camino)
REPO = [("A-REPO", "01-13-01-01", 200)]


class FakeCursor:
    def __init__(self):
        self.description = None
        self._rows = []

    def execute(self, sql, params=None):
        if "CodotProcesoNegocio = 4" in sql:
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
check("OT con problema", sorted(ots), [1, 2, 3, 7, 8])
check("OT 4 (pedido cancelado) descartada", 4 in ots, False)
check("OT 5 (buzón mercadería) descartada", 5 in ots, False)
check("OT 6 (todo ok) no aparece", 6 in ots, False)
check("renglones descartados por cancelado", data["resumen"]["renglonesDescartados"], 1)
check("renglones del buzón", data["resumen"]["renglonesEsperaMercaderia"], 1)

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

print("\n=== reposición ya generada ===")
r = fila(2, "A-REPO")
check("A-REPO situación", r["Situacion"], "repo_pedida")
check("A-REPO en camino", r["RepoEnCamino"], 200.0)
check("A-REPO guardado no alcanzaba", r["EnGuardado"], 5.0)

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

print("\n=== resumen ===")
check("faltantes reales", data["resumen"]["faltanteReal"], 3)
check("para bajar de guardado", data["resumen"]["hayParaReponer"], 2)
check("repo pedida", data["resumen"]["repoPedida"], 1)
check("orden: primero las que tienen faltante", data["ots"][0]["Faltantes"] > 0, True)

print("\n=== todos los renglones (cartel de una OT) ===")
uno = pd.fetch_picking_disponible_ot(6)["ot"]
check("OT 6 aparece con solo_con_problema=False", uno is not None and uno["OTId"], 6)
check("OT 6 trae su fila OK", uno["rows"][0]["Situacion"], "ok")

print(f"\n{ok} ok / {fail} fail")
sys.exit(1 if fail else 0)
