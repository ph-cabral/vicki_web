# -*- coding: utf-8 -*-
"""Verificación del alta de OT de reposición SIN base y SIN red.

Correr: `python indicadores-api/test_ot_reposicion.py`.

Este es el único módulo de la API que ESCRIBE en el WMS, así que lo que se
prueba acá es justamente lo que no se puede probar contra la base sin dejar
una OT de verdad: las validaciones que frenan un alta mala, la forma exacta de
los renglones (tipo 1 primero, tipo 2 después, numerados corridos) y los
valores literales del INSERT — el '1753-01-01' de las fechas vacías y el
PersonalId en OTUsuarioGUID_Repositor, que son las dos cosas que el nombre de
los campos esconde.

Se stubean `db` y `deposito` (pyodbc y pandas no hacen falta para esto);
`picking_disponible` se importa de verdad, porque de ahí salen las constantes
que el alta usa.
"""
import os, sys, types

_AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _AQUI)

# ── stubs de los módulos pesados ────────────────────────────────────────────
_db = types.ModuleType("db")
_db.get_connection = lambda *a, **k: None
sys.modules["db"] = _db

_dep = types.ModuleType("deposito")
_dep.OT_COL_PEDIDO = "OTNroMovVenta"
_dep.PATRONES_CANCELADO = ()
_dep.WMS_ESTADOS_VIVOS = (1, 5)
_dep.WMS_ESTADO_LABELS = {1: {"label": "Pendiente", "bucket": "espera"}}
_dep._es_operario_merca = lambda *a, **k: False
_dep.es_operario_ignorado = lambda *a, **k: False
_dep._info_articulos = lambda codigos: {}
_dep._info_pedidos_resumen = lambda *a, **k: {}
_dep._int = lambda v: int(v) if v is not None else None
_dep._safe = lambda v, colname="": v
_dep._txt = lambda v: str(v).strip() if v is not None else ""
sys.modules["deposito"] = _dep

import ot_reposicion as otr  # noqa: E402

ok = fail = 0


def check(nombre, got, want):
    global ok, fail
    if got == want:
        ok += 1
        print("  ok   %s" % nombre)
    else:
        fail += 1
        print("  FAIL %s\n       got=%r\n       want=%r" % (nombre, got, want))


def check_error(nombre, fn, fragmento):
    global ok, fail
    try:
        fn()
    except otr.OTReposicionError as e:
        if fragmento.lower() in str(e).lower():
            ok += 1
            print("  ok   %s" % nombre)
        else:
            fail += 1
            print("  FAIL %s\n       mensaje=%r\n       esperaba que contenga=%r"
                  % (nombre, str(e), fragmento))
    except Exception as e:
        fail += 1
        print("  FAIL %s — levantó %s en vez de OTReposicionError: %s"
              % (nombre, type(e).__name__, e))
    else:
        fail += 1
        print("  FAIL %s — no levantó nada" % nombre)


L_OK = [{"articulo": "CS109", "origen": "01-36-08-01-IZQ",
         "destino": "01-36-06-02", "cantidad": 200}]

# ── forma del payload ───────────────────────────────────────────────────────
print("\n=== validación de la forma del payload ===")
check("normaliza y redondea",
      otr._normalizar_lineas([{"articulo": " CS109 ", "origen": "01-36-08-01-izq",
                               "destino": "01-36-06-02", "cantidad": "200"}]),
      [{"articulo": "CS109", "origen": "01-36-08-01-IZQ",
        "destino": "01-36-06-02", "cantidad": 200.0}])
check_error("sin renglones", lambda: otr._normalizar_lineas([]), "no hay renglones")
check_error("sin artículo",
            lambda: otr._normalizar_lineas([{"origen": "A", "destino": "B", "cantidad": 1}]),
            "falta el artículo")
check_error("sin origen",
            lambda: otr._normalizar_lineas([{"articulo": "X", "destino": "B", "cantidad": 1}]),
            "ubicación de origen")
check_error("sin destino",
            lambda: otr._normalizar_lineas([{"articulo": "X", "origen": "A", "cantidad": 1}]),
            "posición de destino")
check_error("cantidad 0",
            lambda: otr._normalizar_lineas([{"articulo": "X", "origen": "A",
                                             "destino": "B", "cantidad": 0}]),
            "mayor que 0")
check_error("origen == destino",
            lambda: otr._normalizar_lineas([{"articulo": "X", "origen": "A",
                                             "destino": "A", "cantidad": 1}]),
            "misma ubicación")
# El duplicado es el que más duele: cada mitad pasa la validación de stock por
# separado y entre las dos se llevan el doble de lo que hay.
check_error("(artículo, origen) repetido",
            lambda: otr._normalizar_lineas(L_OK + L_OK), "aparece dos veces")
check_error("más de 99 artículos",
            lambda: otr._normalizar_lineas(
                [{"articulo": "A%d" % i, "origen": "U%d" % i, "destino": "D%d" % i,
                  "cantidad": 1} for i in range(100)]),
            "máximo 99")

# ── cursor falso para las validaciones contra la base ───────────────────────
UBIC_OK = {
    # ubic: (guardado, abastecedora, picking, estado)
    "01-36-08-01-IZQ": (1, 1, 0, 1),
    "01-36-06-02":     (0, 0, 1, 1),
}


class CursorFalso:
    """Devuelve lo que pida cada consulta según por dónde va el alta."""

    def __init__(self, ubic=None, stock=None, tomado=None, repo_viva=None,
                 personal=("289", "Perez Rodolfo", "guid-289", 1)):
        self.ubic = UBIC_OK if ubic is None else ubic
        self.stock = {("CS109", "01-36-08-01-IZQ"): (500, "2026-08-26")} if stock is None else stock
        self.tomado = tomado or {}
        self.repo_viva = repo_viva or {}
        self.personal = personal
        self.ejecutadas = []
        self._pendiente = None
        self._ultimo = None

    def execute(self, sql, params=None):
        self.ejecutadas.append((sql, list(params or [])))
        s = " ".join(sql.split())
        if "FROM Personal WHERE" in s:
            self._ultimo = ("personal", None)
        elif "FROM Ubicacion u" in s:
            self._pendiente = [(u, g, a, p, e) for u, (g, a, p, e) in self.ubic.items()]
        elif "FROM UbicacionDetalle d" in s:
            self._pendiente = [(a, u, c, f) for (a, u), (c, f) in self.stock.items()]
        elif "i.OTItemTipo = 1" in s:
            self._pendiente = [(a, u, t) for (a, u), t in self.tomado.items()]
        elif "i.OTItemTipo = 2" in s:
            self._pendiente = [(a, u, t) for (a, u), t in self.repo_viva.items()]
        elif "SCOPE_IDENTITY" in s:
            self._ultimo = ("identity", None)
        return self

    def fetchone(self):
        if self._ultimo and self._ultimo[0] == "personal":
            return self.personal
        if self._ultimo and self._ultimo[0] == "identity":
            return (149999,)
        return None

    def fetchall(self):
        out, self._pendiente = self._pendiente or [], None
        return out

    def inserts(self, tabla):
        return [(s, p) for s, p in self.ejecutadas if ("INSERT INTO %s " % tabla) in s]


class ConnFalsa:
    def __init__(self, cur):
        self._cur = cur
        self.commits = 0
        self.rollbacks = 0
        self.cerrada = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.cerrada = True


def con(cur):
    """Parchea get_connection para que crear_ot use el cursor falso."""
    c = ConnFalsa(cur)
    otr.get_connection = lambda *a, **k: c
    return c


# ── validaciones contra la base ─────────────────────────────────────────────
print("\n=== validaciones contra la base ===")
check_error("origen que no existe",
            lambda: otr.crear_ot("36", "289",
                                 [{**L_OK[0], "origen": "01-99-99-99-DER"}],
                                 simular=True) if con(CursorFalso()) else None,
            "no existe")
check_error("origen inactivo",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(ubic={**UBIC_OK, "01-36-08-01-IZQ": (1, 1, 0, 0)})) else None,
            "inactiva")
check_error("origen que no es de guardado",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(ubic={**UBIC_OK, "01-36-08-01-IZQ": (0, 0, 1, 1)})) else None,
            "no es una ubicación de guardado")
check_error("destino que no es de picking",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(ubic={**UBIC_OK, "01-36-06-02": (1, 0, 0, 1)})) else None,
            "no es una posición de picking")
check_error("origen de otro depósito",
            lambda: otr.crear_ot("36", "289",
                                 [{**L_OK[0], "origen": "02-22-06-04-IZQ"}], simular=True)
            if con(CursorFalso(ubic={**UBIC_OK, "02-22-06-04-IZQ": (1, 1, 0, 1)})) else None,
            "depósito central")
check_error("origen que no es un rack (playa)",
            lambda: otr.crear_ot("36", "289",
                                 [{**L_OK[0], "origen": "PLAYA_PEDIDOS"}], simular=True)
            if con(CursorFalso(ubic={**UBIC_OK, "PLAYA_PEDIDOS": (1, 1, 0, 1)})) else None,
            "no es un rack")

print("\n=== stock: el pozo se relee en el alta ===")
check_error("no alcanza el stock",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(stock={("CS109", "01-36-08-01-IZQ"): (150, None)})) else None,
            "quedan 150 disponibles")
# Este es el caso que motiva releer: hay 500 en la ubicación pero otra OT viva
# ya se comprometió a sacar 400.
check_error("otra OT ya se lleva ese stock",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(tomado={("CS109", "01-36-08-01-IZQ"): 400})) else None,
            "quedan 100 disponibles")

print("\n=== no duplicar una reposición viva ===")
check_error("ya hay repo hacia ese estante",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(repo_viva={("CS109", "01-36-06-02"): 200})) else None,
            "ya tiene una reposición viva")
cur = CursorFalso(repo_viva={("CS109", "01-36-06-02"): 200})
con(cur)
plan = otr.crear_ot("36", "289", L_OK, simular=True, forzar=True)
check("con Forzar pasa igual", plan["articulos"], 1)

print("\n=== operario ===")
check_error("operario inexistente",
            lambda: otr.crear_ot("36", "999", L_OK, simular=True)
            if con(CursorFalso(personal=None)) else None,
            "no existe en el wms")
check_error("operario dado de baja",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(personal=("289", "Perez Rodolfo", "guid-289", 2))) else None,
            "dado de baja")
check_error("operario sin usuario del WMS",
            lambda: otr.crear_ot("36", "289", L_OK, simular=True)
            if con(CursorFalso(personal=("289", "Perez Rodolfo", "", 1))) else None,
            "no tiene usuario del wms")
check_error("sin operario", lambda: otr.crear_ot("36", "", L_OK, simular=True),
            "elegir el operario")

# ── el plan: forma de los renglones ─────────────────────────────────────────
print("\n=== forma de los renglones ===")
DOS = [
    {"articulo": "CS109", "origen": "01-36-08-01-IZQ", "destino": "01-36-06-02",
     "cantidad": 200},
    {"articulo": "3001", "origen": "01-36-09-01-DER", "destino": "01-36-10-03",
     "cantidad": 150},
]
UBIC2 = {
    "01-36-08-01-IZQ": (1, 1, 0, 1), "01-36-06-02": (0, 0, 1, 1),
    "01-36-09-01-DER": (1, 1, 0, 1), "01-36-10-03": (0, 0, 1, 1),
}
STOCK2 = {("CS109", "01-36-08-01-IZQ"): (500, "2026-08-26"),
          ("3001", "01-36-09-01-DER"): (1000, "2026-09-15")}
cur = CursorFalso(ubic=UBIC2, stock=STOCK2)
con(cur)
plan = otr.crear_ot("36", "289", DOS, simular=True)
check("simulado", plan["simulado"], True)
check("no crea OT", plan["OTId"], None)
check("unidades", plan["unidades"], 350)
# Primero TODOS los tipo 1, después TODOS los tipo 2, numerados corridos: es el
# orden con el que los deja la pantalla del WMS (verificado sobre la OT 149525).
check("orden y numeración",
      [(r["Renglon"], r["Tipo"], r["Articulo"], r["Ubicacion"]) for r in plan["renglones"]],
      [(1, 1, "CS109", "01-36-08-01-IZQ"),
       (2, 1, "3001", "01-36-09-01-DER"),
       (3, 2, "CS109", "01-36-06-02"),
       (4, 2, "3001", "01-36-10-03")])
check("la fecha FIFO del origen se copia al destino",
      [r["Fec"] for r in plan["renglones"]],
      ["2026-08-26", "2026-09-15", "2026-08-26", "2026-09-15"])
check("la simulación no escribió", (cur.inserts("OT"), cur.inserts("OTItem")), ([], []))
check("observaciones con la marca", plan["observaciones"], "VICKI pasillo 36")
check("operario resuelto", plan["operario"],
      {"Id": "289", "Nombre": "Perez Rodolfo", "Guid": "guid-289"})

# ── el alta de verdad ───────────────────────────────────────────────────────
print("\n=== alta real: qué se inserta ===")
cur = CursorFalso(ubic=UBIC2, stock=STOCK2)
c = con(cur)
plan = otr.crear_ot("36", "289", DOS, observaciones="urgente")
check("devuelve el número de OT", plan["OTId"], 149999)
check("una sola cabecera", len(cur.inserts("OT")), 1)
check("dos renglones por artículo", len(cur.inserts("OTItem")), 4)
check("commit", c.commits, 1)
check("sin rollback", c.rollbacks, 0)
check("conexión cerrada", c.cerrada, True)

par_ot = cur.inserts("OT")[0][1]
# [OTLastRenglon, OTEstado, CodotCodigo, Regist, Repositor, FechaEjec, Obs,
#  CantTiempoPick, PickIni, PickFin]
check("OTLastRenglon = total de renglones (tipo 1 + tipo 2)", par_ot[0], 4)
check("estado pendiente", par_ot[1], 1)
check("código de OT de reposición", par_ot[2], "OT1R")
check("OTUsuarioGUID_Regist = el GUID de gam.User", par_ot[3], "guid-289")
# La trampa: pese al nombre, acá va el PersonalId, no un GUID.
check("OTUsuarioGUID_Repositor = PersonalId", par_ot[4], "289")
check("fechas vacías = 1753-01-01", par_ot[5:6] + par_ot[7:], ["1753-01-01"] * 4)
check("la marca va adelante de la observación", par_ot[6], "VICKI pasillo 36 urgente")

par_item = cur.inserts("OTItem")[0][1]
# [OTId, Renglon, CantPedida, Estado, Ubicacion, DepositoId, Articulo, Tipo,
#  Fec, PickFin, PickIni]
check("el renglón lleva el OTId devuelto", par_item[0], 149999)
check("cantidad", par_item[2], 200)
check("estado del renglón", par_item[3], 1)
check("depósito como texto", par_item[5], "1")
check("tipo 1 = recolección", par_item[7], 1)
check("fechas de pickeo vacías", par_item[9:], ["1753-01-01", "1753-01-01"])
check("el renglón 3 es el destino del primer artículo",
      cur.inserts("OTItem")[2][1][4:8], ["01-36-06-02", "1", "CS109", 2])

print("\n=== si algo falla no queda media OT ===")


class CursorRompe(CursorFalso):
    def execute(self, sql, params=None):
        if "INSERT INTO OTItem" in sql:
            raise RuntimeError("cayó la conexión")
        return super().execute(sql, params)


cur = CursorRompe(ubic=UBIC2, stock=STOCK2)
c = con(cur)
try:
    otr.crear_ot("36", "289", DOS)
except RuntimeError:
    pass
check("rollback", c.rollbacks, 1)
check("sin commit", c.commits, 0)
check("conexión cerrada igual", c.cerrada, True)

# ── utilidades ──────────────────────────────────────────────────────────────
print("\n=== utilidades ===")
# Varios legajos de WMS.Personal vienen con asteriscos adelante.
check("nombre con asteriscos", otr._limpiar_nombre("****Sanchez Evelyn"), "Sanchez Evelyn")
check("nombre normal", otr._limpiar_nombre(" Perez Rodolfo "), "Perez Rodolfo")
check("fecha FIFO de un datetime",
      otr._fecha_fifo(__import__("datetime").datetime(2026, 8, 26, 11, 56)), "2026-08-26")
check("sin fecha usa hoy", len(otr._fecha_fifo(None)), 10)
check("formato entero", otr._fmt(200.0), "200")
check("formato con decimales", otr._fmt(12.5), "12.50")

print("\n%d ok / %d fail" % (ok, fail))
sys.exit(1 if fail else 0)
