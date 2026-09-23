"""
/deposito/repo/en-curso — OT de reposición (OT1R) vivas y todavía NO cumplidas,
para marcar en /picking los artículos que un picker pide y que ya tienen una
reposición en marcha.

"No cumplida" se mide sobre el renglón DESTINO (OTItemTipo = 2, el que deja la
mercadería en la posición de picking): la OT está viva (estado 0/1/5) y a ese
artículo le queda CantCumplida < CantPedida. Un artículo cuyo destino ya se
cumplió no se marca aunque la OT siga abierta por otros renglones.

Una sola consulta sobre WMS (unas pocas decenas de OT vivas → ~100 renglones):
la vista la pide completa y cruza por código en el navegador, así no hace falta
mandarle la lista de artículos ni repetir la consulta por cada evento.

Ventana `dias` (default 30): hay OT de reposición zombi en estado 5 desde abril
2026 que nunca se cerraron; sin la ventana aparecerían como "en camino".

Tipo 1 y tipo 2 NO vienen de a pares: una OT puede sacar el mismo artículo de
tres ubicaciones de guardado (3 renglones tipo 1) y dejarlo en un solo estante
(1 renglón tipo 2). Por eso se agrupa por artículo dentro de la OT: lista de
orígenes, lista de destinos, y pedido/cumplido tomados del destino.
"""
from db import get_connection
from deposito import WMS_ESTADO_LABELS, WMS_ESTADOS_VIVOS, _txt

VENTANA_DIAS = 30
FECHA_VACIA = "1753-01-01"

SQL_REPO_EN_CURSO = """
SELECT
    OT.OTId,
    OT.OTEstado,
    OT.OTFechaHoraRegist,
    OT.OTFechaHoraPickIni,
    LTRIM(RTRIM(OT.OTObservaciones))            AS obs,
    LTRIM(RTRIM(OT.OTUsuarioGUID_Repositor))    AS repositor_id,
    LTRIM(RTRIM(p.PersonalNombre))              AS repositor,
    i.OTItemNroRenglon,
    i.OTItemTipo,
    LTRIM(RTRIM(i.OTItemArticuloId))            AS art,
    LTRIM(RTRIM(i.OTItemUbicacionCodigo))       AS ubic,
    i.OTItemCantPedida,
    i.OTItemCantCumplida
FROM OT
INNER JOIN Codot   c ON c.CodotCodigo = OT.CodotCodigo
INNER JOIN OTItem  i ON i.OTId = OT.OTId
LEFT  JOIN Personal p ON LTRIM(RTRIM(p.PersonalId)) = LTRIM(RTRIM(OT.OTUsuarioGUID_Repositor))
WHERE c.CodotProcesoNegocio = 1                       -- Reposición
  AND OT.OTEstado IN ({vivos})
  AND OT.OTFechaHoraRegist >= DATEADD(day, -?, GETDATE())
  AND EXISTS (                                        -- algún destino pendiente
        SELECT 1 FROM OTItem d
        WHERE d.OTId = OT.OTId AND d.OTItemTipo = 2
          AND d.OTItemCantCumplida < d.OTItemCantPedida)
ORDER BY OT.OTId, i.OTItemNroRenglon
"""


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _fecha(v) -> str | None:
    """datetime del WMS → ISO; '1753-01-01' (fecha vacía del WMS) → None."""
    if v is None:
        return None
    s = v.isoformat(timespec="seconds") if hasattr(v, "isoformat") else str(v)
    return None if s.startswith(FECHA_VACIA) else s


def _nombre(v) -> str:
    # Varios legajos traen asteriscos adelante ("****Sanchez Evelyn").
    return _txt(v).lstrip("*").strip()


def fetch_repo_en_curso(dias: int = VENTANA_DIAS) -> dict:
    dias = max(1, int(dias or VENTANA_DIAS))
    vivos = ",".join(str(e) for e in WMS_ESTADOS_VIVOS)
    conn = get_connection("WMS")
    try:
        cur = conn.cursor()
        cur.execute(SQL_REPO_EN_CURSO.format(vivos=vivos), dias)
        filas = cur.fetchall()
    finally:
        conn.close()

    ots: dict[int, dict] = {}
    for (otid, estado, reg, pick_ini, obs, rep_id, rep, _ren, tipo,
         art, ubic, pedida, cumplida) in filas:
        otid = int(otid)
        ot = ots.get(otid)
        if ot is None:
            e = int(estado) if estado is not None else None
            ot = ots[otid] = {
                "OTId": otid,
                "Estado": e,
                "EstadoLabel": WMS_ESTADO_LABELS.get(e, {}).get("label", "Sin estado"),
                "Alta": _fecha(reg),
                "InicioPick": _fecha(pick_ini),
                "Observaciones": _txt(obs),
                "RepositorId": _txt(rep_id),
                "Repositor": _nombre(rep) or _txt(rep_id),
                "_arts": {},
            }
        art = _txt(art).upper()
        a = ot["_arts"].setdefault(art, {
            "Articulo": art, "Origenes": [], "Destinos": [],
            "Pedido": 0.0, "Cumplido": 0.0,
        })
        ped, cum = _num(pedida), _num(cumplida)
        linea = {"Ubicacion": _txt(ubic), "Pedido": ped, "Cumplido": cum}
        if int(tipo) == 1:
            a["Origenes"].append(linea)
        else:
            a["Destinos"].append(linea)
            a["Pedido"] += ped
            a["Cumplido"] += cum

    salida = []
    articulos: dict[str, list[int]] = {}
    for ot in ots.values():
        items = []
        for a in ot.pop("_arts").values():
            a["Pendiente"] = round(max(0.0, a["Pedido"] - a["Cumplido"]), 3)
            a["Cumplida"] = a["Pedido"] > 0 and a["Pendiente"] == 0
            items.append(a)
            if not a["Cumplida"] and a["Destinos"]:
                articulos.setdefault(a["Articulo"], []).append(ot["OTId"])
        ot["Items"] = items
        salida.append(ot)

    return {"dias": dias, "ots": salida, "articulos": articulos}
