"""
Remitos de ingreso de mercadería (Magnus, SOLO LECTURA).

Reproduce el reporte de remitos de compra del mes (el que usa el sector para
controlar lo que entró): remitos de compra ya concretados, de cualquiera de los
tipos de comprobante de ingreso, no solo los ligados a una OC.

CAMBIO 2026-09-03 — universo ampliado
-------------------------------------
Antes la consulta exigía `NroOrdCompra <> 0` (solo el remito impreso
"RMTO. ING. MERCAD. x O.CPA"). Con eso se perdían todos los remitos que no
cuelgan de una orden de compra, que en el reporte de agosto 2026 son ~4 de cada
10 renglones. Ahora el recorte es por TIPO DE COMPROBANTE
(`CODIGOS_REMITO_INGRESO`), que es el criterio del reporte de Magnus:

    59  RMTOxCPA.D   remito por compra directa
    60  RMTOxORD     remito por orden de compra
    61  REM AV S.F   remito a valorizar sin factura
    160 (sin detalle de código en el reporte)
    590 REM IN LIL   remito de ingreso

El nombre de la columna que guarda ese código en `Com_RemitoCabecera` NO está
documentado, así que se DETECTA por INFORMATION_SCHEMA entre los candidatos de
`CAND_COL_COMPROBANTE` y se cachea a nivel proceso (`_col_comprobante`, corre
una sola vez, no una por request). Si no aparece ninguno, la consulta NO filtra
por tipo (trae todos los remitos TERMINADOS/FACTURADOS del rango) y la respuesta avisa con
`comprobanteWarn: true` — las vistas lo muestran en amarillo.

`solo_oc=True` vuelve al recorte viejo (`NroOrdCompra <> 0`) por si alguna
vista necesita puntualmente el remito x OC.

Consumidores
------------
· /compras/metricas y /compras/detalle-mes → card "Ingresados ese mes" y Excel.
· /compras/faltantes (faltantes-consumo) → columna "Ingresado" por artículo.
· /ventas/faltantes ("Tabla 2" — listos para vender): confirma que un renglón
  con fecha de arribo cargada YA llegó físicamente. Se cruza por CodArticulo
  contra preparado.faltante_control (fechaArribo + clienteQuiere), del lado de
  `ever` (app/api/ventas/faltantes/route.ts).

Tablas (EVERWEAR, confirmadas por ingresos_extraccion.py):
  · Com_RemitoCabecera  → NroMovRemito, CompCentro, CompNumero,
                           FecComprobante (int base-1800), NroOrdCompra,
                           CodProveed, Estado, <código de comprobante>
  · Com_RemitoRenglones → NroMovRemito, NroRenglon, CodArticulo, Cantidad
  · Com_Proveedores     → CodProveed, RazonSocial

Performance
-----------
· Las fechas van SIEMPRE como enteros literales días-Magnus en el WHERE (base
  1800-12-28), nunca fecha calculada vs parámetro (el driver viejo filtra mal).
· El recorte de tipo de comprobante va EN EL SQL (IN con literales enteros).
· READ UNCOMMITTED: no bloquea a Magnus.
· La agregación por artículo se hace en Python sobre las filas del rango (un
  mes ≈ 1.100 renglones), no con GROUP BY, porque hace falta la lista de
  remitos por artículo.
"""
from datetime import datetime, date, timedelta
from decimal import Decimal
from db import get_connection

BASE_DATE = date(1800, 12, 28)  # Magnus guarda fechas como días desde esta base

# Ventana por defecto si no viene `desde`: no traer todo el histórico.
INGRESOS_DIAS_DEFAULT = 60

# Tipos de comprobante que cuentan como INGRESO de mercadería (ver docstring).
CODIGOS_REMITO_INGRESO = (59, 60, 61, 160, 590)

# Candidatos para la columna del código de comprobante en Com_RemitoCabecera.
# 2026-09-08 — FIX: la columna REAL es `CompCodigo` (smallint) y no estaba en la
# lista, así que _detectar_col_comprobante devolvía "" y el filtro por
# CODIGOS_REMITO_INGRESO NUNCA se aplicaba: la respuesta salía con
# comprobanteWarn=True y contaba TODO renglón de Com_RemitoRenglones del rango,
# devoluciones a proveedor incluidas (71 REMITO DEVOLUCION, 73 REM DEV FABRICA,
# 96). En agosto 2026 no cambiaba el número de casualidad —los únicos
# comprobantes del mes eran 59/60/61/160/590, justo los válidos— pero cualquier
# mes con una devolución la contaba como ingreso.
CAND_COL_COMPROBANTE = (
    "CompCodigo",
    "CodComprobante", "CodComp", "Comprobante", "CodTipoComprobante",
    "TipoComprobante", "CodTipoComp", "TipoComp", "CodMovimiento", "CodMov",
)

# Cuántos remitos como máximo se detallan por artículo (el resto suma en la
# cantidad pero no infla la respuesta).
MAX_REMITOS_DETALLE = 25

# Cache a nivel proceso de la detección de columna: None = todavía no se miró,
# "" = se miró y no existe ninguna de las candidatas.
_col_comprobante = None


def _safe(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "ignore")
    return value


def _fecha_comprobante(v):
    """FecComprobante = int (días Magnus) → ISO yyyy-mm-dd o None."""
    if v is None:
        return None
    if isinstance(v, (date, datetime)):
        return v.date().isoformat() if v.year >= 1901 else None
    try:
        dias = int(v)
    except (TypeError, ValueError):
        return None
    if dias <= 0:
        return None
    return (BASE_DATE + timedelta(days=dias)).isoformat()


def _nro_remito(centro, numero):
    """Formatea como Magnus: '0002-00071407' (CompCentro-CompNumero)."""
    try:
        c = int(centro) if centro is not None else 0
    except (TypeError, ValueError):
        c = 0
    try:
        n = int(numero) if numero is not None else 0
    except (TypeError, ValueError):
        n = 0
    return f"{c:04d}-{n:08d}"


def _detectar_col_comprobante(cur):
    """Nombre real de la columna del código de comprobante en
    Com_RemitoCabecera, o "" si no está ninguna de las candidatas.
    Se cachea a nivel proceso: corre una sola vez por instancia."""
    global _col_comprobante
    if _col_comprobante is not None:
        return _col_comprobante
    lista = ", ".join(f"'{c}'" for c in CAND_COL_COMPROBANTE)
    cur.execute(
        "SELECT COLUMN_NAME FROM EVERWEAR.INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_NAME = 'Com_RemitoCabecera' "
        f"AND COLUMN_NAME IN ({lista})"
    )
    encontradas = {str(r[0]).strip() for r in cur.fetchall()}
    # respeta el orden de preferencia de CAND_COL_COMPROBANTE
    _col_comprobante = next((c for c in CAND_COL_COMPROBANTE if c in encontradas), "")
    return _col_comprobante


def fetch_remitos_ingreso(desde=None, hasta=None, solo_oc=False):
    """Agrega por artículo los remitos de ingreso ya concretados.

    desde = 'YYYY-MM-DD' (o None → hoy - INGRESOS_DIAS_DEFAULT): solo remitos
    con FecComprobante >= esa fecha. /ventas/faltantes pasa la fecha del
    faltante (regla: el artículo "llegó" si hay remito con fecha >= a cuando
    se detectó el faltante).
    hasta = 'YYYY-MM-DD' opcional: acota también por arriba (FecComprobante
    <= hasta). Usado por /compras/metricas para acotar a un mes calendario
    exacto (sin esto, un remito de un mes futuro también contaría).
    solo_oc = True: recorte viejo, solo remitos ligados a una OC."""
    if desde:
        try:
            corte = datetime.strptime(str(desde)[:10], "%Y-%m-%d").date()
        except ValueError:
            corte = date.today() - timedelta(days=INGRESOS_DIAS_DEFAULT)
    else:
        corte = date.today() - timedelta(days=INGRESOS_DIAS_DEFAULT)
    corte_dias = (corte - BASE_DATE).days

    hasta_dias = None
    if hasta:
        try:
            hasta_date = datetime.strptime(str(hasta)[:10], "%Y-%m-%d").date()
            hasta_dias = (hasta_date - BASE_DATE).days
        except ValueError:
            hasta_dias = None
    _hasta_cond = f"AND cab.FecComprobante <= {hasta_dias}" if hasta_dias is not None else ""
    _oc_cond = "AND cab.NroOrdCompra <> 0" if solo_oc else ""

    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute("SET DATEFORMAT ymd; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")

        col_comp = _detectar_col_comprobante(cur)
        if col_comp:
            codigos = ", ".join(str(int(c)) for c in CODIGOS_REMITO_INGRESO)
            _comp_sel = f"cab.[{col_comp}]"
            _comp_cond = f"AND cab.[{col_comp}] IN ({codigos})"
        else:
            _comp_sel = "NULL"
            _comp_cond = ""

        sql = f"""
        SELECT
            cab.NroMovRemito             AS NroMovRemito,
            cab.CompCentro               AS CompCentro,
            cab.CompNumero               AS CompNumero,
            cab.FecComprobante           AS FecComprobante,
            cab.NroOrdCompra             AS NroOrdCompra,
            {_comp_sel}                  AS CodComprobante,
            LTRIM(RTRIM(r.CodArticulo))  AS CodArticu,
            r.Cantidad                   AS Cantidad,
            pr.RazonSocial               AS Proveedor
        FROM EVERWEAR.dbo.Com_RemitoRenglones r
        INNER JOIN EVERWEAR.dbo.Com_RemitoCabecera cab ON cab.NroMovRemito = r.NroMovRemito
        LEFT  JOIN EVERWEAR.dbo.Com_Proveedores    pr  ON pr.CodProveed   = cab.CodProveed
        WHERE cab.FecComprobante >= {corte_dias}
          {_hasta_cond}
          {_comp_cond}
          {_oc_cond}
          AND cab.Estado = 0
          AND cab.EstadoDeRegistracion IN (0, 2)
        """
        # Estado del remito (regla del reporte de Magnus, SP RPT_ConsultaRemitosCompras):
        #   Estado=1 → ANULADO · EstadoDeRegistracion 0 → TERMINADO · 1 → GUARDADO · 2 → FACTURADO.
        # Solo cuentan como "arribado" los TERMINADOS y FACTURADOS (no anulados ni guardados).
        # El filtro anterior (LTRIM(RTRIM(cab.Estado)) <> 'Anulado') comparaba un tinyint
        # contra texto y no filtraba nada.

        cur.execute(sql)
        cols = [c[0] for c in cur.description]

        agg: dict[str, dict] = {}
        remitos_vistos: set[tuple[str, str]] = set()  # (artículo, nro) para no duplicar detalle
        comprobantes_totales: dict[str, int] = {}     # código → renglones (diagnóstico)
        for row in cur.fetchall():
            d = dict(zip(cols, row))
            cod = (str(d.get("CodArticu") or "")).strip()
            if not cod:
                continue
            fecha = _fecha_comprobante(d.get("FecComprobante"))
            if fecha is None:
                continue
            cant = float(_safe(d.get("Cantidad")) or 0)
            nro = _nro_remito(d.get("CompCentro"), d.get("CompNumero"))
            prov = (str(d.get("Proveedor") or "")).strip() or None
            comp = d.get("CodComprobante")
            comp = None if comp is None else str(comp).strip()
            if comp:
                comprobantes_totales[comp] = comprobantes_totales.get(comp, 0) + 1
            con_oc = bool(_safe(d.get("NroOrdCompra")) or 0)

            a = agg.get(cod)
            if not a:
                a = {
                    "CodArticulo": cod,
                    "CantidadIngresada": 0.0,
                    "Proveedor": prov,
                    "FechaUltimoIngreso": fecha,
                    "NroRemitos": [],
                    "Remitos": [],
                    "ConOC": False,
                }
                agg[cod] = a
            a["CantidadIngresada"] += cant
            if prov and not a["Proveedor"]:
                a["Proveedor"] = prov
            if fecha > a["FechaUltimoIngreso"]:
                a["FechaUltimoIngreso"] = fecha
            if con_oc:
                a["ConOC"] = True
            clave = (cod, nro)
            if nro and clave not in remitos_vistos:
                remitos_vistos.add(clave)
                a["NroRemitos"].append(nro)
                if len(a["Remitos"]) < MAX_REMITOS_DETALLE:
                    a["Remitos"].append(
                        {"nro": nro, "fecha": fecha, "cant": cant, "cod": comp, "prov": prov}
                    )
            elif nro:
                # mismo remito, otro renglón del mismo artículo: suma la cantidad
                for det in a["Remitos"]:
                    if det["nro"] == nro:
                        det["cant"] = round(det["cant"] + cant, 2)
                        break

        rows = sorted(agg.values(), key=lambda x: -x["CantidadIngresada"])
        for r in rows:
            r["CantidadIngresada"] = round(r["CantidadIngresada"], 2)
        return {
            "total": len(rows),
            "rows": rows,
            "desde": corte.isoformat(),
            "hasta": (BASE_DATE + timedelta(days=hasta_dias)).isoformat() if hasta_dias is not None else None,
            # diagnóstico del recorte (lo consumen las vistas para el aviso)
            "soloOc": bool(solo_oc),
            "colComprobante": col_comp or None,
            "comprobanteWarn": not col_comp,
            "comprobantes": CODIGOS_REMITO_INGRESO if col_comp else [],
            "renglonesPorComprobante": comprobantes_totales,
        }
    finally:
        conn.close()
