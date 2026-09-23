"""Tests de repo_en_curso.py — sin base (conexión falsa)."""
import sys
import types
from datetime import datetime

import repo_en_curso as m

F = datetime(2026, 9, 21, 13, 55, 32)
V = datetime(1753, 1, 1)


class _Cur:
    def __init__(self, filas):
        self.filas, self.args = filas, None

    def execute(self, sql, *a):
        self.sql, self.args = sql, a

    def fetchall(self):
        return self.filas


class _Conn:
    def __init__(self, filas):
        self.c = _Cur(filas)

    def cursor(self):
        return self.c

    def close(self):
        pass


def _run(filas, dias=30):
    conn = _Conn(filas)
    m.get_connection = lambda db: conn
    return m.fetch_repo_en_curso(dias), conn.c


def test_agrupa_origenes_y_toma_pedido_del_destino():
    r, cur = _run([
        (149428, 1, F, V, "", "283", "Guisiano Lucas", 1, 1, "1/2z30e ", "01-09-04-01-19-01-D", 90, 0),
        (149428, 1, F, V, "", "283", "Guisiano Lucas", 2, 1, "1/2Z30E", "01-09-04-03-09-01-D", 90, 0),
        (149428, 1, F, V, "", "283", "Guisiano Lucas", 3, 2, "1/2Z30E", "01-17-01-04", 180, 0),
    ])
    ot = r["ots"][0]
    assert ot["Alta"] == "2026-09-21T13:55:32" and ot["InicioPick"] is None
    assert ot["EstadoLabel"] == "Pendiente"
    it = ot["Items"][0]
    assert it["Articulo"] == "1/2Z30E" and len(it["Origenes"]) == 2
    assert it["Pedido"] == 180 and it["Pendiente"] == 180
    assert r["articulos"] == {"1/2Z30E": [149428]}
    assert cur.args == (30,)


def test_destino_cumplido_no_marca_el_articulo():
    r, _ = _run([
        (1, 5, F, F, "REPO", "7", "****Sanchez Evelyn", 1, 1, "A", "X", 10, 10),
        (1, 5, F, F, "REPO", "7", "****Sanchez Evelyn", 2, 1, "B", "Y", 5, 0),
        (1, 5, F, F, "REPO", "7", "****Sanchez Evelyn", 3, 2, "A", "P1", 10, 10),
        (1, 5, F, F, "REPO", "7", "****Sanchez Evelyn", 4, 2, "B", "P2", 5, 2),
    ])
    assert r["articulos"] == {"B": [1]}
    assert r["ots"][0]["Repositor"] == "Sanchez Evelyn"
    a = {i["Articulo"]: i for i in r["ots"][0]["Items"]}
    assert a["A"]["Cumplida"] and a["B"]["Pendiente"] == 3


def test_mismo_articulo_en_dos_ots():
    r, _ = _run([
        (1, 1, F, V, "", "", None, 1, 2, "A", "P", 4, 0),
        (2, 1, F, V, "", "9", None, 1, 2, "A", "P", 6, 0),
    ])
    assert r["articulos"] == {"A": [1, 2]}
    assert r["ots"][1]["Repositor"] == "9"


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f(); print("ok", k)
