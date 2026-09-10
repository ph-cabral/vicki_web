import pandas as pd
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from db import get_connection
from utils import construir_timestamps, calcular_tiempos, COLUMNAS_TIEMPO
from deposito import (
    fetch_wms, fetch_tiempo, fetch_ingresados, fetch_pedidos_hora, fetch_faltantes,
    fetch_faltantes_fechas, fetch_vivo, fetch_faltantes_ot, fetch_faltantes_ot_diag,
    fetch_ot_diferencias,
    fetch_wms_estados, fetch_wms_estados_diag,
    fetch_articulo_ubicaciones, fetch_articulos_multi_ubicacion,
    fetch_stock_deposito1, fetch_stock_por_articulos, fetch_stock_export,
    fetch_contenedor,
    guardar_snapshot_abiertos, guardar_snapshot_wms_estados,
    fetch_pick_heatmap, fetch_pick_ots, fetch_pick_ot_items,
    PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN,
)
from compras import (
    fetch_ordenes_pendientes, fetch_ordenes_articulos_rango, fetch_ordenes_detalle_rango,
    fetch_compras_valorizado,
    fetch_consumo_articulo, fetch_consumo_articulos, fetch_consumo_lineas,
    fetch_lineas, fetch_lineas_por_articulos,
)
from oc_areas import fetch_oc_por_area, fetch_oc_detalle_area
from ingresos import fetch_remitos_ingreso
from embolsado import fetch_embolsado, buscar_usuario as buscar_usuario_embolsado
from ventas import (
    fetch_pedidos_mes, fetch_ventas_por_linea, fetch_vendedores,
    fetch_top_clientes, fetch_top_lineas, fetch_clientes_por_linea,
)
# /ventas/bulones — misma vista que /ventas/vendedor pero acotada a la línea
# BULONERÍA, con el corte por CÓDIGO PATRÓN y un ranking extra de vendedores
# (2026-08-26). Ver bulones.py.
# /ventas/presupuestos — presupuestos de bulonería (CodComp 45) separados por
# estado. El ranking de VENTAS del pie de esa vista reusa los endpoints de
# /ventas/bulones, acá sólo van los presupuestos. Ver presupuestos.py.
from presupuestos import fetch_presupuestos_bulones

# Bonificaciones: notas de crédito por CONCEPTO (sin artículo, y por lo tanto
# sin línea) que las vistas de ventas nunca restaron. Son de toda la empresa;
# para /ventas/bulones se prorratean por la participación de la línea. Ver
# bonificaciones.py.
from bonificaciones import fetch_bonificacion_bulones

from bulones import (
    fetch_top_clientes as fetch_bulones_top_clientes,
    fetch_top_patrones as fetch_bulones_top_patrones,
    fetch_top_vendedores as fetch_bulones_top_vendedores,
    fetch_clientes_por_patron as fetch_bulones_clientes_por_patron,
    fetch_clientes_por_vendedor as fetch_bulones_clientes_por_vendedor,
    fetch_patrones_por_cliente as fetch_bulones_patrones_por_cliente,
)
from finanza import (
    fetch_facturacion_dia,
    fetch_descubrir,
    fetch_descubrir_presupuestos,
    fetch_verificar_presupuestos,
    fetch_pedidos_sin_facturar,
    insert_ajuste_manual,
    fetch_ajuste_manual_list,
)
from clientes import fetch_cliente, fetch_clientes_search
from cartera import fetch_cartera_codigos
from vendedores import codigos_de, invalidar_cache as invalidar_cache_vendedores
from mesa_control import (
    fetch_mesa_control, fetch_mesa_control_diag,
    fetch_mesa_control_sp_definicion, fetch_mesa_control_tablas_diag,
    fetch_mesa_control_recontroles_diag,
)
from errores_mesa import (
    fetch_pedido_lookup, insert_error_mesa, opciones as errores_mesa_opciones,
    fetch_ubicacion_diag, fetch_errores_mesa_list, fetch_operario_nombre,
    insert_error_calidad, update_observacion, fetch_controlador_diag,
    fetch_articulos_pedido, insert_error_mesa_items,
    opciones_calidad as errores_mesa_opciones_calidad, insert_error_calidad_items,
)
from control_asignacion import asignar_siguiente, fetch_cola_diag, fetch_pedidos_asignados
from rrhh import fetch_cvs_por_mes
from datetime import date, datetime, timedelta
import threading
import time

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Snapshot periódico de "Abiertos" (Magnus) para /deposito/pedidos-hora ────
# 2026-07-23: reconstruir el backlog abierto desde
# FechaPedido/FechaCierre quedaba plano (no una serie de tiempo real). En vez
# de reconstruir el pasado, se saca una FOTO real cada
# PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN minutos y se guarda en Postgres (ver
# deposito.py::guardar_snapshot_abiertos, tabla deposito.pedidos_abiertos_snapshot
# — falta correr sql/deposito_pedidos_abiertos_snapshot.sql antes del deploy).
# uvicorn corre sin --workers (1 solo proceso, ver Dockerfile), así que este
# thread corre una única vez; si el día de mañana se agregan workers, mover
# esto a un proceso/cron aparte para no duplicar filas.
def _loop_snapshot_abiertos():
    while True:
        try:
            guardar_snapshot_abiertos()
        except Exception as e:
            print(f"[snapshot abiertos] error: {e}")
        # Misma cadencia: foto de los estados del WMS (gráfico "OT en cada estado
        # por hora"), así el gráfico coincide con las tarjetas KPI.
        try:
            guardar_snapshot_wms_estados()
        except Exception as e:
            print(f"[snapshot wms-estados] error: {e}")
        time.sleep(PEDIDOS_ABIERTOS_SNAPSHOT_INTERVALO_MIN * 60)


@app.on_event("startup")
def _iniciar_snapshot_abiertos():
    threading.Thread(target=_loop_snapshot_abiertos, daemon=True).start()

# ── Constantes de filtro ──────────────────────────────────────────────────────
ESTADOS_VALIDOS = ['Facturados', 'Cerrados']
# ESTADOS_VALIDOS  = ['Abiertos', 'Facturados', 'Cerrados']
COMP_VALIDOS     = [10, 70, 100, 210, 310]
COMPROBANTE_DESC = 'PED.MAYOR'

BASE_DATE = date(1800, 12, 28)

SQL_QUERY = """
SELECT
    p.NroMovVenta,
    p.FechaPedido,        p.HoraRegistracion,
    p.FechaSuspendido,    p.HoraSuspendido,
    p.FechaConfirmacion,  p.HoraConfirmacion,
    p.FechaArmado,        p.HoraArmado,
    p.FechaCierre,        p.HoraCierre,
    p.EstadoPedido,
    e.Ped_EstadoDescripcion        AS Estado_Desc,
    p.CodCliente,
    c.Cliente_Nombre,
    c.Clasif_EstCliente            AS Categoria,
    p.Zona                         AS CodZona,
    z.ZonaNombre                   AS Zona_Desc,
    p.Vendedor                     AS CodVendedor,
    u.Usu_Arma_Nombre               AS Vendedor_Nombre,
    p.CompCodigo,
    cc.DetalleCorto                AS Comprobante_Desc,
    p.PedOrigenCodigo,
    COALESCE(or1.VtaOrigenDetalle, or2.PedOrigenDetalle) AS Origen_Desc,
    p.Prioridad
FROM EVERWEAR.dbo.VenFer_PedidoCabecera p
LEFT JOIN MAGNUS_SITD.dbo.Pedido_Estados         e   ON p.EstadoPedido    = e.Ped_Estado
LEFT JOIN MAGNUS_SITD.dbo.Clientes               c   ON p.CodCliente      = c.CodCliente
LEFT JOIN MAGNUS_SITD.dbo.Zonas                  z   ON p.Zona            = z.ZonaCodigo
LEFT JOIN MAGNUS_SITD.dbo.Ped_Usu_Arma           u   ON p.Vendedor        = u.Usu_Arma_Codigo
LEFT JOIN MAGNUS_SITD.dbo.Ven_CodComprobante     cc  ON p.CompCodigo      = cc.CompCodigo
LEFT JOIN MAGNUS_SITD.dbo.Vta_OrigenRegistracion or1 ON p.PedOrigenCodigo = or1.VtaOrigenCodigo
LEFT JOIN MAGNUS_SITD.dbo.Ped_OrigenRegistracion or2 ON p.PedOrigenCodigo = or2.PedOrigenCodigo
WHERE p.CompCodigo NOT IN (9, 49, 208, 410)
  AND p.FechaPedido >= {corte_dias}
ORDER BY p.NroMovVenta DESC
"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def cargar_df(meses: int = 7) -> pd.DataFrame:
    corte_fecha = pd.Timestamp.now() - pd.DateOffset(months=meses)
    corte_dias  = (corte_fecha.date() - BASE_DATE).days

    conn   = get_connection()
    df_raw = pd.read_sql(SQL_QUERY.format(corte_dias=corte_dias), conn)
    conn.close()

    df = construir_timestamps(df_raw)
    df = calcular_tiempos(df)

    for col in ['Estado_Desc', 'Comprobante_Desc', 'Zona_Desc', 'Vendedor_Nombre']:
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()

    df['fecha'] = df['ts_Registro'].dt.normalize()
    df['mes']   = df['ts_Registro'].dt.to_period('M').astype(str)
    df['año']   = df['ts_Registro'].dt.year

    return df

def filtrar(df: pd.DataFrame, meses: int = 7) -> pd.DataFrame:
    return df[
        df['CompCodigo'].isin(COMP_VALIDOS)
        & df['Estado_Desc'].isin(ESTADOS_VALIDOS)
        & (df['Comprobante_Desc'] == COMPROBANTE_DESC)
    ].copy()

def promedio_seguro(serie: pd.Series) -> float:
    validos = serie.dropna()
    return round(float(validos.mean()), 2) if len(validos) > 0 else 0.0

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}

# ── Depósito (reemplazo de los Excel de /deposito) ────────────────────────────

def _parse_rango(desde: str | None, hasta: str | None):
    """desde/hasta = 'YYYY-MM-DD'. Default: últimos 6 meses hasta hoy."""
    hoy = date.today()
    h = datetime.strptime(hasta, "%Y-%m-%d") if hasta else datetime(hoy.year, hoy.month, hoy.day)
    d = datetime.strptime(desde, "%Y-%m-%d") if desde else (h - timedelta(days=180))
    d = d.replace(hour=0, minute=0, second=0, microsecond=0)
    h = h.replace(hour=23, minute=59, second=59, microsecond=0)
    return d, h

@app.get("/deposito/wms")
def deposito_wms(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    todos: bool = Query(default=False),
):
    """Productividad de Operarios (WMS) por rango de OTFechaHoraEjecucion."""
    try:
        d, h = _parse_rango(desde, hasta)
        rows = fetch_wms(d, h, todos=todos)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {
        "desde": d.date().isoformat(),
        "hasta": h.date().isoformat(),
        "total": len(rows),
        "rows": rows,
    }

@app.get("/deposito/wms-estados")
def deposito_wms_estados(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Tablero por rango: OT (Picking) por estado + carga por preparador
    desglosada por estado. Sin params → último día con OT ejecutada."""
    try:
        return fetch_wms_estados(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/wms-estados/diag")
def deposito_wms_estados_diag():
    """Diagnóstico: OTEstado reales (Picking) + tablas de descripción de estado +
    columnas de fecha de OT. Para confirmar el mapeo de /deposito/wms."""
    try:
        return fetch_wms_estados_diag()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/tiempo")
def deposito_tiempo():
    """Tiempo de Pedidos = EVERWEAR.dbo.TMP_TiempoDePedidos (snapshot ~90 días)."""
    try:
        rows = fetch_tiempo()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {"total": len(rows), "rows": rows}

@app.get("/deposito/ingresados")
def deposito_ingresados(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Pedidos registrados por día (lo que ingresó) en el rango."""
    try:
        d, h = _parse_rango(desde, hasta)
        rows = fetch_ingresados(d, h)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {
        "desde": d.date().isoformat(),
        "hasta": h.date().isoformat(),
        "total": sum(r["pedidos"] for r in rows),
        "rows": rows,
    }

@app.get("/deposito/pedidos-hora")
def deposito_pedidos_hora(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Pedidos ingresados, backlog de abiertos y cerrados por hora (8-18h) de
    UN día. Fuente Magnus (VenFer_PedidoCabecera). Sin desde/hasta → HOY en
    vivo (no proyecta horas futuras). Con desde/hasta (mismos filtros que
    /deposito/wms-estados) → usa `hasta` (o `desde`) como el día a mostrar;
    si no es hoy, se devuelve el 8-18h completo de ese día."""
    dia = date.today()
    if hasta or desde:
        try:
            dia = date.fromisoformat((hasta or desde).strip()[:10])
        except ValueError:
            raise HTTPException(status_code=400, detail="Fecha inválida (usar YYYY-MM-DD)")
    try:
        rows = fetch_pedidos_hora(dia)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {"fecha": dia.isoformat(), "rows": rows}

@app.get("/deposito/vivo")
def deposito_vivo():
    """Tablero EN VIVO: pedidos (OT) en espera / en proceso y carga por operario AHORA."""
    try:
        return fetch_vivo()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/faltantes")
def deposito_faltantes(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    historico: bool = Query(default=False),
):
    """Faltantes (renglones pendientes 'sin existencia' por controlar).
    · Sin params  → último snapshot con registro < hoy (comportamiento original).
    · desde/hasta → todos los snapshots del rango, deduplicados por renglón, con
      'PrimerDia' (primera aparición) para poder restar la OC por día.
    · historico=true (con rango) → incluye además los faltantes ya entregados/
      cubiertos a mitad del rango; cada fila trae 'Vivo' (1 vivo / 0 histórico)."""
    try:
        return fetch_faltantes(desde, hasta, historico)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/faltantes/fechas")
def deposito_faltantes_fechas():
    """Snapshots disponibles (fechas con registro < hoy) para el selector de la vista."""
    try:
        return fetch_faltantes_fechas()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/articulo/ubicaciones")
def deposito_articulo_ubicaciones(articulo: str = Query(...)):
    """Ubicaciones (sin filtrar) de un artículo con >1 unidad: ubicacion + cantidad."""
    try:
        return fetch_articulo_ubicaciones(articulo)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/articulos/multi-ubicacion")
def deposito_articulos_multi_ubicacion():
    """Artículos con más de una ubicación asignada (rack), para depurar el maestro."""
    try:
        return fetch_articulos_multi_ubicacion()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/contenedor")
def deposito_contenedor(tag: str = Query(...)):
    """Contenedor por TAG (WMS): info general (maestro Contenedor), contenido
    actual (ContenedorItem) e historial de movimientos (KmovContenedor), con
    el usuario REAL (Personal) además del usuario de "Registro", que muchas
    veces es la cuenta genérica del sistema ("User Anonymous")."""
    try:
        return fetch_contenedor(tag)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/stock")
def deposito_stock(
    page: int = Query(default=1),
    page_size: int = Query(default=50),
    q: str | None = Query(default=None),
):
    """Stock paginado por depósito (1/2/3) + total: código, nombre, stock por
    depósito, proveedor."""
    try:
        return fetch_stock_deposito1(page, page_size, q)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/stock/export")
def deposito_stock_export():
    """Stock COMPLETO (sin paginar, todos los artículos) por depósito 1/2/3 +
    total. Para el botón 'Exportar Excel' de /deposito/stock."""
    try:
        return fetch_stock_export()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/stock-por-articulos")
def deposito_stock_por_articulos(codigos: str = Query(...)):
    """Stock del depósito 1 (central) para una lista puntual de códigos
    (separados por coma), sin paginar. Usado por /compras/faltantes para
    mostrar la existencia real al lado de lo marcado 'sin existencia'."""
    try:
        lista = [c for c in codigos.split(",") if c.strip()]
        return fetch_stock_por_articulos(lista)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/embolsado")
def deposito_embolsado(
    meses_venta: int = Query(default=6),
    meses_cobertura: int = Query(default=4),
    incluir_cubiertos: bool = Query(default=True),
):
    """Recomendación de embolsado, ordenada por menor cobertura.

    Cobertura = stock ya embolsado en CENTRAL / venta máxima mensual de los
    últimos `meses_venta` meses. Se recomienda llevar el stock a
    `meses_cobertura` meses, topeado por lo que haya en el pulmón de ingreso.
    Ver el docstring de embolsado.py (universo, fuentes y gotchas)."""
    try:
        return fetch_embolsado(meses_venta, meses_cobertura, incluir_cubiertos)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/embolsado/usuario")
def deposito_embolsado_usuario(q: str = Query(...)):
    """Resuelve quién es el que va a embolsar contra el maestro de usuarios de
    Magnus (`Gen_Usuarios`): número exacto, o nombre por palabras sin acentos.

    Siempre 200: el cuerpo trae `ok` y, si el nombre es ambiguo, la lista de
    `candidatos` para que la pantalla los ofrezca. Un 4xx acá obligaría al
    proxy a distinguir "no encontrado" de "se cayó Magnus"."""
    try:
        return buscar_usuario_embolsado(q)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/faltantes-ot")
def deposito_faltantes_ot(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Faltantes agrupados por OT (NUEVA fuente de /deposito/faltantes): por cada
    OT de Picking, renglones cumplidos (recolectados) vs faltantes (sin recolectar).
    Excluye pedidos descartados/anulados por estado de Magnus.
    · Sin params  → último día con armado.
    · desde/hasta → ese rango por OTFechaHoraEjecucion."""
    try:
        return fetch_faltantes_ot(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/faltantes-ot/diag")
def deposito_faltantes_ot_diag():
    """Diagnóstico: columnas reales de OT/OTItem (WMS) para confirmar OT_COL_PEDIDO
    y los estados de pedido presentes (para ajustar ESTADOS_VALIDOS)."""
    try:
        return fetch_faltantes_ot_diag()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/ot-diferencias")
def deposito_ot_diferencias(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Renglones de OT Picking Cumplidas (WMS) con cantidad pedida != cumplida.
    Fuente NUEVA de /deposito/faltantes (reemplaza Ven_PedRenPendientes de Magnus).
    Sin params → último día Cumplido antes de hoy."""
    try:
        return fetch_ot_diferencias(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: OC pendientes de recibir por artículo (lo que "va a llegar") ─────
@app.get("/compras/ordenes-pendientes")
def compras_ordenes_pendientes(
    desde: str | None = Query(default=None),
    fabril: int = Query(default=0),
):
    """OC abiertas, pendiente de recibir (Pedida - Recibida) agregado por artículo.
    Solo lectura sobre Magnus; se cruza con faltantes en /compras/faltantes.
    `desde`='YYYY-MM-DD' (default OC_DESDE_DEFAULT): solo OC con FecMovim >= desde,
    para que las OC viejas no cubran faltantes actuales."""
    try:
        return fetch_ordenes_pendientes(desde, incluir_fabril=bool(fabril))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: remitos de ingreso ya concretados (lo que "ya llegó") ───────────
@app.get("/compras/ingresos")
def compras_ingresos(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    soloOc: int = Query(default=0),
):
    """Remitos de ingreso de mercadería ya concretados (Com_RemitoCabecera/
    Renglones), agregado por artículo. Desde 2026-09-03 entran TODOS los tipos
    de comprobante de ingreso (CODIGOS_REMITO_INGRESO = 59/60/61/160/590), no
    solo los ligados a una OC — es el universo del reporte de remitos del mes.
    `soloOc=1` vuelve al recorte viejo (NroOrdCompra <> 0).
    Consumidores: /compras (card Ingresados), /compras/faltantes (columna
    Ingresado) y /ventas/faltantes ("Tabla 2": confirma que un renglón con
    fecha de arribo YA llegó físicamente).
    `desde`='YYYY-MM-DD' (default: hoy-60). `hasta`='YYYY-MM-DD' opcional
    (para /compras/metricas: acotar a un mes calendario)."""
    try:
        return fetch_remitos_ingreso(desde, hasta, solo_oc=bool(soloOc))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: artículos con OC hecha en un rango (funnel /compras/metricas) ───
@app.get("/compras/ordenes-mes")
def compras_ordenes_mes(
    desde: str = Query(...),
    hasta: str = Query(...),
    fabril: int = Query(default=0),
):
    """Artículos (CodArticulo distintos) con al menos un renglón de OC hecho
    en [desde, hasta] por FecMovim de la cabecera — sin importar si ya se
    recibió o sigue pendiente (a diferencia de /compras/ordenes-pendientes).
    Para /compras/metricas: funnel faltantes del mes → con OC ese mes."""
    try:
        return fetch_ordenes_articulos_rango(desde, hasta, incluir_fabril=bool(fabril))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: detalle por artículo de las OC del mes (export a Excel) ─────────
@app.get("/compras/ordenes-detalle")
def compras_ordenes_detalle(
    desde: str = Query(...),
    hasta: str = Query(...),
    fabril: int = Query(default=0),
):
    """Mismo recorte que /compras/ordenes-mes, pero una fila por artículo con
    los NÚMEROS de OC ('0001-00014700'), proveedor, descripción y fecha de la
    última OC. Para el export a Excel de /compras."""
    try:
        return fetch_ordenes_detalle_rango(desde, hasta, incluir_fabril=bool(fabril))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: unidades y $ (a precio de VENTA, no de OC) de las OC hechas ─────
# en un rango de fechas libre — selector independiente del mes de
# /compras/metricas (2026-08-04).
@app.get("/compras/compras-valorizado")
def compras_compras_valorizado(
    desde: str = Query(...),
    hasta: str = Query(...),
    fabril: int = Query(default=0),
):
    """Artículos con OC hecha en [desde, hasta]: unidades totales (Cantidad de
    Com_OrdCompRenglones) y $ valorizado al último PrecioVenta visto en
    cualquier pedido (Ven_PedRenPendientes) — NO al costo de la OC."""
    try:
        return fetch_compras_valorizado(desde, hasta, incluir_fabril=bool(fabril))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: consumo mensual de un artículo + stock por depósito ─────────────
# Para /compras/consumo (2026-08-11): vendido por mes en un
# rango de MESES (YYYY-MM), total/promedio/máximo/mínimo>0 y stock 1/2/3.
@app.get("/compras/consumo-articulo")
def compras_consumo_articulo(
    codigo: str = Query(...),
    desde: str = Query(...),
    hasta: str = Query(...),
):
    """Vendido (CantidadPedida de pedidos válidos, mismo criterio que
    /ventas/pedidos-mes) por mes calendario para UN CodArticu, con un bucket
    por cada mes del rango aunque la venta sea 0, + stock por depósito."""
    try:
        return fetch_consumo_articulo(codigo, desde, hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: consumo mensual de TODOS los artículos + stock (vista "Tabla") ──
# Para el botón "Tabla" de /compras/consumo (2026-08-11):
# mismo cálculo que /compras/consumo-articulo pero sin filtrar por código.
# Ordenado y paginado EN EL SERVIDOR (2026-08-12: la v1 devolvía el catálogo
# completo y tiraba abajo el proceso con catálogos grandes — ver NOTA en
# fetch_consumo_articulos).
@app.get("/compras/consumo-articulos")
def compras_consumo_articulos(
    desde: str = Query(...),
    hasta: str = Query(...),
    sort: str = Query("totalVendido"),
    sortDir: str = Query("desc"),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    q: str | None = Query(None),
    linea: str | None = Query(None),
    lineaExacta: int = Query(0),
    fresh: int = Query(0),
):
    """Vendido/promedio/máximo/mínimo>0 y stock por artículo, para los
    artículos que matchean `q` (código) y/o `linea` (nombre de Stk_Nivel1) — al menos uno
    de los dos es obligatorio (2026-08-12, ver NOTA en
    fetch_consumo_articulos): sin filtro se agregaría TODO el catálogo.

    `lineaExacta=1` compara la línea por igualdad en vez de substring — lo usa
    el drill-down de la vista, donde el nombre sale de una fila real.

    `fresh=1` fuerza recalcular ignorando el cache de métricas — lo manda el
    botón "Refrescar"; ordenar y paginar reusan el cálculo."""
    try:
        return fetch_consumo_articulos(
            desde, hasta, sort=sort, sort_dir=sortDir, page=page, page_size=pageSize,
            q=q, linea=linea, linea_exacta=bool(lineaExacta), fresh=bool(fresh),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: export a Excel de la tabla de consumo (TODOS los artículos, sin
# paginar) — botón "Exportar Excel" de /compras/consumo (
# 2026-08-12). Requiere `linea`: no se puede exportar sin elegir una línea
# (ver NOTA en fetch_consumo_articulos, gateado también acá con Query(...)).
@app.get("/compras/consumo-articulos/export")
def compras_consumo_articulos_export(
    desde: str = Query(...),
    hasta: str = Query(...),
    sort: str = Query("totalVendido"),
    sortDir: str = Query("desc"),
    q: str | None = Query(None),
    linea: str = Query(...),
    lineaExacta: int = Query(0),
):
    """Igual que /compras/consumo-articulos pero sin paginar: TODOS los
    artículos de la línea (y opcionalmente código) elegida, para volcar a
    Excel."""
    try:
        return fetch_consumo_articulos(
            desde, hasta, sort=sort, sort_dir=sortDir,
            q=q, linea=linea, linea_exacta=bool(lineaExacta), export=True,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: consumo mensual por LÍNEA (pantalla de entrada de /compras/consumo)
# 2026-09-07: mismas métricas que /compras/consumo-articulos
# pero agregadas por línea (Stk_Nivel1) en vez de por artículo. Como el resto
# de la vista, suma SOLO artículos nacionales.
#
# SIN filtro obligatorio, a diferencia de /compras/consumo-articulos: es la
# pantalla que abre la vista, tiene que listar las 48 líneas de una. Lo que
# viaja de SQL a Python es chico y no crece con el catálogo (ver docstring de
# fetch_consumo_lineas).
@app.get("/compras/consumo-lineas")
def compras_consumo_lineas(
    desde: str = Query(...),
    hasta: str = Query(...),
    sort: str = Query("totalVendido"),
    sortDir: str = Query("desc"),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    q: str | None = Query(None),
    linea: str | None = Query(None),
    lineaExacta: int = Query(0),
    fresh: int = Query(0),
):
    """Vendido/promedio/máximo/mínimo>0 y stock por LÍNEA, sobre artículos
    nacionales. `q`/`linea` son opcionales: sin filtro devuelve todas.

    `fresh=1` ignora el cache de métricas (botón "Refrescar")."""
    try:
        return fetch_consumo_lineas(
            desde, hasta, sort=sort, sort_dir=sortDir, page=page, page_size=pageSize,
            q=q, linea=linea, linea_exacta=bool(lineaExacta), fresh=bool(fresh),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: export a Excel de la tabla por línea (sin paginar) ──────────────
@app.get("/compras/consumo-lineas/export")
def compras_consumo_lineas_export(
    desde: str = Query(...),
    hasta: str = Query(...),
    sort: str = Query("totalVendido"),
    sortDir: str = Query("desc"),
    q: str | None = Query(None),
    linea: str | None = Query(None),
    lineaExacta: int = Query(0),
):
    """Igual que /compras/consumo-lineas pero sin paginar, para volcar a Excel."""
    try:
        return fetch_consumo_lineas(
            desde, hasta, sort=sort, sort_dir=sortDir,
            q=q, linea=linea, linea_exacta=bool(lineaExacta), export=True,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: líneas del catálogo con cantidad de artículos ───────────────────
# Para el datalist del input "línea" de /compras/consumo (
# 2026-08-12): saber cuántos artículos hay por línea antes de decidir cómo
# dejar el filtro (dropdown vs texto libre) — con datos reales, no a ciegas.
@app.get("/compras/lineas")
def compras_lineas():
    try:
        return fetch_lineas()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: OC agregadas por ÁREA (tipo de comprobante) y estado ───────────
# Alimenta la pestaña "Presupuestos" de /finanza, que dejó de armarse del
# Excel financiero y ahora lee la base en vivo (2026-09-01). Ver oc_areas.py.
@app.get("/compras/oc-por-area")
def compras_oc_por_area(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    forzar: int = Query(default=0),
):
    """OC de [desde, hasta] (meses 'YYYY-MM', default mes en curso) agrupadas
    por tipo de comprobante y estado, con importes pesificados a la cotización
    de cada OC. Las canceladas van aparte, fuera de los totales."""
    try:
        return fetch_oc_por_area(desde, hasta, forzar=bool(forzar))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: DETALLE de las OC de un área (modal de /finanza) ───────────────
# Una fila por OC (cabecera) del área, agrupadas por mes: número de movimiento,
# fecha, importe pesificado y observación. Ver oc_areas.fetch_oc_detalle_area.
@app.get("/compras/oc-detalle-area")
def compras_oc_detalle_area(
    codigo: int = Query(...),
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    forzar: int = Query(default=0),
):
    """OC del área `codigo` (tipo de comprobante) en [desde, hasta] (meses
    'YYYY-MM'), una fila por OC y agrupadas por mes. Canceladas afuera, mismo
    criterio que /compras/oc-por-area para que los totales cierren."""
    try:
        return fetch_oc_detalle_area(codigo, desde, hasta, forzar=bool(forzar))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Ventas: total pedido del mes (denominador del % en /compras/metricas) ───
@app.get("/ventas/pedidos-mes")
def ventas_pedidos_mes(
    desde: str = Query(...),
    hasta: str = Query(...),
):
    """Total de unidades y $ de TODOS los pedidos válidos (Cerrado/Facturado)
    del rango [desde, hasta], por FechaPedido de VenFer_PedidoCabecera — no
    filtra por artículo. Para /compras/metricas: qué % del total pedido ese
    mes representan los faltantes."""
    try:
        return fetch_pedidos_mes(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Finanza: facturación del día (calculadora) ───────────────────────────────
@app.get("/finanza/facturacion-dia")
def finanza_facturacion_dia(fecha: str | None = Query(default=None)):
    """Facturación del día: ENTRA (cód 11) − SALE (cód 22/23/24/25).
    Devuelve neto con y sin IVA (21%). `fecha`='YYYY-MM-DD' (default: hoy).
    Solo lectura sobre Magnus."""
    try:
        return fetch_facturacion_dia(fecha)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/finanza/descubrir")
def finanza_descubrir():
    """Introspección de Magnus para ubicar la tabla de facturación (códigos,
    tablas candidatas y tablas con código+importe+fecha). Apoyo para configurar
    finanza.py. Ver también descubrir_facturacion.sql."""
    try:
        return fetch_descubrir()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Finanza: ajuste manual (ventas reales sin comprobante en Magnus) ─────────
# Ver ever/sql/finanza_ajuste_manual.sql — caso real que lo disparó: Todo Goma
# (CodCliente 5226), presupuesto Ctrl. A 0002-00041879 del 30/07/2026, que no
# existe en ningún lado de Magnus. fetch_facturacion_dia ya lo suma solo
# (Postgres finanza.ajuste_manual); estos endpoints son para cargar/listar.
class AjusteManualIn(BaseModel):
    fecha: str                        # 'YYYY-MM-DD'
    neto: float
    iva: float | None = None
    total: float | None = None
    codCliente: int | None = None
    clienteNombre: str | None = None
    comprobante: str | None = None
    motivo: str | None = None
    usuario: str | None = None

@app.post("/finanza/ajuste")
def finanza_ajuste_crear(body: AjusteManualIn):
    """Alta de un ajuste manual — suma a neto_sin_iva/neto_con_iva del día
    indicado en /finanza/facturacion-dia."""
    try:
        return insert_ajuste_manual(
            body.fecha, body.neto, body.iva, body.total,
            body.codCliente, body.clienteNombre, body.comprobante,
            body.motivo, body.usuario,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.get("/finanza/ajuste")
def finanza_ajuste_listar(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Lista de ajustes manuales cargados (finanza.ajuste_manual), filtro
    opcional por rango de fecha."""
    try:
        return fetch_ajuste_manual_list(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

# ── Finanza: presupuestos "fantasma" (caso Todo Goma, 2026-07-31) ───────────
@app.get("/finanza/descubrir-presupuestos")
def finanza_descubrir_presupuestos():
    """Pre_PresupCab no tuvo el comprobante 41879 (caso Todo Goma) — busca
    dónde vive realmente la pantalla 'COMPROBANTES (Facturas / Créditos
    Devolución)' cuando Código Comprobante = 11 (PRESUP.)."""
    try:
        return fetch_descubrir_presupuestos()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


class VerificarPresupuestoIn(BaseModel):
    comprobante: str | None = None
    cod_cliente: int
    fecha: str          # 'YYYY-MM-DD'
    total: float


@app.post("/finanza/verificar-presupuestos")
def finanza_verificar_presupuestos(items: list[VerificarPresupuestoIn]):
    """Chequea una lista de presupuestos (cliente+fecha+total) contra
    Ven_CompCabecera y VenFer_PedidoCabecera — mismo método que confirmó el
    caso Todo Goma (41879) como huérfano. No busca por número impreso (no
    correlaciona con ninguna columna conocida). Los que den
    huerfano_probable=true son candidatos a cargar en POST /finanza/ajuste."""
    try:
        return fetch_verificar_presupuestos([i.dict() for i in items])
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/finanza/pedidos-sin-facturar")
def finanza_pedidos_sin_facturar(fecha: str = Query(...)):
    """100% automático (no requiere pegar nada a mano): pedidos de `fecha`
    que WMS ya despachó (Picking ejecutado) pero que no tienen contraparte en
    Ven_CompCabecera — venta real confirmada por depósito, factura atrasada.
    Distinto de /finanza/verificar-presupuestos (ahí no hay forma de saber si
    era plata real o una cotización que no se cerró)."""
    try:
        return fetch_pedidos_sin_facturar(fecha)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Clientes: lookup por número desde Magnus (para /manguera/corte) ───────────
@app.get("/clientes/{numero}")
def clientes_get(numero: int):
    """Cliente por número desde Magnus (CodCliente, Cliente_Nombre).
    Solo lectura. 404 si no existe."""
    try:
        cli = fetch_cliente(numero)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return cli


@app.get("/clientes")
def clientes_buscar(
    q: str = Query(..., min_length=1),
    vendedor: int | None = Query(default=None, description="Filtra a clientes de este vendedor (no-admin)"),
):
    """Búsqueda de clientes por código o nombre (substring) — para el filtro
    de /ventas/vendedor (2026-08-14). Solo lectura, Magnus.
    `vendedor`: acceso por vendedor — Next.js lo resuelve del usuario
    logueado y lo manda SOLO para no-admins (nunca confiar en un valor que
    venga directo del navegador sin pasar por esa resolución de sesión)."""
    try:
        return {"clientes": fetch_clientes_search(q, vendedor=vendedor)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


# ── Ventas por línea de un cliente — /ventas/vendedor ──────────────────────
@app.get("/ventas/vendedor")
def ventas_vendedor(
    cliente: int = Query(..., description="CodCliente (Magnus)"),
    vendedor: int | None = Query(default=None, description="Exige que este sea el vendedor principal del cliente (no-admin)"),
):
    """Ventas (cantidad y monto, netas de nota de crédito) de un cliente,
    agrupadas por línea de artículo y por año actual/anterior, con desglose
    mensual — para /ventas/vendedor (2026-08-14). Ver
    docstring de fetch_ventas_por_linea (ventas.py) para la fuente y para el
    chequeo de `vendedor` (devuelve permitido=false + nada de datos si el
    cliente no es de ese vendedor)."""
    try:
        return fetch_ventas_por_linea(cliente, vendedor=vendedor)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/vendedor/top-clientes")
def ventas_vendedor_top_clientes(
    vendedor: int | None = Query(default=None, description="Filtra a clientes de este vendedor (no-admin)"),
    # Antes default=10, le=50, y después default=10000, le=10000: seguía
    # siendo un tope, aunque alto. se aclaró (2026-08-19): "no tiene que
    # tener límite, todo lo que entre en el rango de fecha debe ser
    # traído". Sin `le` = sin tope superior; el default alto es solo para
    # que un caller que no mande `limit` (como el proxy Next) igual reciba
    # todo. No hay costo extra en SQL: la query ya trae el resultset
    # completo (sin TOP/LIMIT), `limit` solo recortaba la lista en Python
    # después de tenerla toda en memoria.
    limit: int = Query(default=1_000_000, ge=1),
    desde: str | None = Query(default=None, description="Mes desde, 'YYYY-MM' (default: enero del año en curso)"),
    hasta: str | None = Query(default=None, description="Mes hasta, 'YYYY-MM' (default: mes anterior al actual)"),
):
    """Top clientes por MONTO (venta neta, $) en un rango de meses — para el
    ranking debajo de la tabla de /ventas/vendedor. Por defecto
    (2026-09-04), los meses TRANSCURRIDOS del año en curso (Enero → mes
    anterior), y cada cliente trae aparte `montoMes` con lo del MES EN CURSO
    — que en la tabla es una columna propia a la derecha. Trae TODOS los
    clientes que entran en ese rango (2026-08-19, no un top
    recortado) y `totalClientes`: cuántos clientes distintos entran en la
    filtración (con el límite alto, coincide con len(porMonto) salvo casos
    extremos). Ver docstring de fetch_top_clientes (ventas.py) para el
    criterio de acceso por vendedor (mismo que /clientes y
    /ventas/vendedor) y para el formato de `desde`/`hasta`.

    Desde 2026-09-07 trae además `ajuste` / `ajusteMes`: las bonificaciones y
    ajustes de saldo del mismo rango y la misma cartera (notas de crédito por
    concepto, sin artículo — ver bonificaciones.py). Vienen con signo y NO
    están prorrateadas adentro de las filas: cada cliente sigue siendo venta
    bruta, y el pie de la tabla arma bruto → ajuste → neto."""
    try:
        return fetch_top_clientes(vendedor=vendedor, limit=limit, desde=desde, hasta=hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/vendedor/top-lineas")
def ventas_vendedor_top_lineas(
    vendedor: int | None = Query(default=None, description="Filtra a clientes de este vendedor (no-admin)"),
    # Mismo cambio que top-clientes (2026-08-19): traer
    # TODAS las líneas del rango, sin tope superior — ver el comentario en
    # ventas_vendedor_top_clientes.
    limit: int = Query(default=1_000_000, ge=1),
    desde: str | None = Query(default=None, description="Mes desde, 'YYYY-MM' (default: enero del año en curso)"),
    hasta: str | None = Query(default=None, description="Mes hasta, 'YYYY-MM' (default: mes anterior al actual)"),
):
    """Top líneas por UNIDADES compradas en un rango de meses — gemelo de
    /ventas/vendedor/top-clientes (2026-08-18: "agregamos
    vista de líneas, al igual que el top, traemos el total de líneas y acá
    dejamos ver solo unidades compradas"). Mismo rango por defecto (año en
    curso hasta el mes anterior) y mismas columnas `unidadesMes`/`montoMes`
    del mes en curso. Desde 2026-08-19, TODAS las líneas que entran en ese rango
    (no un top recortado). Mismo criterio de acceso por vendedor. Devuelve
    las DOS métricas — `porUnidades` (ordenado por unidades) y `porMonto`
    (ordenado por $), cada item con `unidades` y `monto` — más
    `totalLineas` / `totalLineasMonto` (2026-08-26: el
    ranking de líneas ahora tiene botón $ | Unidades como el modal). Ver
    fetch_top_lineas (ventas.py).

    Desde 2026-09-07 trae además `ajuste` / `ajusteMes`, igual que
    top-clientes. Sólo mueven $: el concepto de una nota de crédito no tiene
    cantidad, así que el ranking por unidades no se toca."""
    try:
        return fetch_top_lineas(vendedor=vendedor, limit=limit, desde=desde, hasta=hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/vendedor/clientes-por-linea")
def ventas_vendedor_clientes_por_linea(
    linea: str = Query(..., min_length=1, description="Nombre de línea (Stk_Nivel1.Detalle), o '(Sin línea)'"),
    vendedor: int | None = Query(default=None, description="Filtra a clientes de este vendedor (no-admin)"),
    # Antes default=100, le=500, y después default=10000, le=10000: con
    # líneas grandes (ej. línea 44, 385 clientes) el modal se cortaba.
    # Mismo cambio que top-clientes/top-lineas (2026-08-19,
    # aclarado el mismo día: "no tiene que tener límite"): sin tope
    # superior — traer TODOS los clientes que compraron esa línea en el
    # rango; el front agrupa de a 50 en acordeones colapsables en pantalla.
    limit: int = Query(default=1_000_000, ge=1),
):
    """Clientes que compraron una línea de artículo, con el MISMO desglose
    que la tabla línea×año del modo "cliente": año anterior y año actual,
    cada uno con total y los 12 meses, en cantidad y monto (
    2026-08-20, para que el modal de línea tenga los mismos toggles
    $/Unidades y por mes/por año). Ordenados por monto total de mayor a
    menor. Trae TODOS los clientes de esa línea (
    2026-08-19), no un recorte a 100.

    Ya NO recibe desde/hasta: el filtro YTD/Meses lo hace el front sobre el
    desglose mensual ya traído, igual que en modo "cliente" — así el toggle
    no vuelve a pegarle al back. Ver fetch_clientes_por_linea (ventas.py)."""
    try:
        return fetch_clientes_por_linea(linea, vendedor=vendedor, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/vendedor/cartera")
def ventas_vendedor_cartera(
    vendedor: int = Query(..., description="VendedorCodigo (maestro Vendedores)"),
):
    """CodCliente de la cartera de un vendedor (zona ∪ historial), incluida
    la de sus ANTECESORES — ver cartera.py y vendedores.py. Lo usa
    /ventas/faltantes para recortar los faltantes a los clientes del vendedor
    logueado (el recorte no se puede hacer con el JOIN de cartera porque esos
    renglones vienen de otra consulta).

    Ojo: acá la cartera sigue siendo el criterio, y está bien — un faltante es
    un pedido PENDIENTE, no una venta facturada, así que no tiene un
    "vendedor del comprobante" con el que cortarlo. Lo que cambió el
    2026-09-08 es que la cartera se resuelve sobre todos los códigos del
    vendedor, así el que heredó una cartera ve también esos faltantes."""
    try:
        clientes = fetch_cartera_codigos(vendedor)
        return {
            "vendedor": vendedor,
            "codigos": list(codigos_de(vendedor)),
            "total": len(clientes),
            "clientes": clientes,
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.post("/ventas/vendedor/antecesores/invalidar")
def ventas_vendedor_antecesores_invalidar():
    """Tira abajo el cache del mapeo de sucesión (TTL 5', ver vendedores.py).
    Lo llama /admin/usuarios al dar de alta o borrar un antecesor, para que el
    cambio se vea en la vista al toque en vez de esperar el TTL."""
    invalidar_cache_vendedores()
    return {"ok": True}


# ── /ventas/bulones ────────────────────────────────────────────────────────
# Todo acá abajo es el gemelo de /ventas/vendedor/* pero SOLO bulonería, y
# con "línea" reemplazada por "código patrón". El modal del front es de UN
# SOLO nivel, así que estos endpoints se llaman siempre desde el ranking del
# pie y nunca uno desde otro. Ver bulones.py.
@app.get("/ventas/bulones/top-clientes")
def bulones_top_clientes(
    vendedor: int | None = Query(default=None, description="Filtra a clientes de este vendedor (no-admin)"),
    limit: int = Query(default=1_000_000, ge=1),
    desde: str | None = Query(default=None, description="Mes desde, 'YYYY-MM'"),
    hasta: str | None = Query(default=None, description="Mes hasta, 'YYYY-MM'"),
):
    """Clientes que compraron BULONERÍA en el rango, por $ vendidos."""
    try:
        return fetch_bulones_top_clientes(vendedor=vendedor, limit=limit, desde=desde, hasta=hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/top-patrones")
def bulones_top_patrones(
    vendedor: int | None = Query(default=None),
    limit: int = Query(default=1_000_000, ge=1),
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Ranking de códigos patrón de bulonería — reemplaza al top de líneas
    (la línea es una sola). Trae porUnidades y porMonto ya ordenadas."""
    try:
        return fetch_bulones_top_patrones(vendedor=vendedor, limit=limit, desde=desde, hasta=hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/top-vendedores")
def bulones_top_vendedores(
    vendedor: int | None = Query(default=None, description="No-admin: sólo se ve a sí mismo"),
    limit: int = Query(default=1_000_000, ge=1),
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Ranking de vendedores por bulonería facturada, tomando el vendedor del
    comprobante tal cual está en la base: incluye los canales que no son
    personas (MOSTRADOR, ECOMMERCE …) y los dados de baja. Ver bulones.py."""
    try:
        return fetch_bulones_top_vendedores(vendedor=vendedor, limit=limit, desde=desde, hasta=hasta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/bonificacion")
def bulones_bonificacion(
    desde: str | None = Query(default=None, description="Mes desde, 'YYYY-MM'"),
    hasta: str | None = Query(default=None, description="Mes hasta, 'YYYY-MM'"),
    forzar: bool = Query(default=False, description="Saltea el cache de 15 min"),
):
    """Bonificación de la empresa y la parte que le toca a BULONERÍA.

    Las bonificaciones y los ajustes de saldo son notas de crédito/débito por
    concepto: no tienen artículo, así que no tienen línea y no se pueden
    restar de un ranking acotado a una. Acá van prorrateadas por la
    participación de bulonería en la venta con artículo del mismo rango
    (~0,32%), y se muestran APARTE — los rankings de clientes, patrones y
    vendedores no las descuentan.

    Desde 2026-09-07 el universo se define por COMPROBANTE
    (ventas.COMPROBANTES_AJUSTE) y no por concepto; la respuesta trae
    `porComprobante` además de `porConcepto`.

    NO toma `vendedor`: es un número de empresa, acotarlo a una cartera no
    significaría nada. Ver bonificaciones.py."""
    try:
        return fetch_bonificacion_bulones(desde=desde, hasta=hasta, forzar=forzar)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


# ── /ventas/presupuestos ───────────────────────────────────────────────────
@app.get("/ventas/presupuestos/bulones")
def presupuestos_bulones(
    vendedor: int | None = Query(default=None, description="No-admin: sólo los presupuestos que cargó él"),
    desde: str | None = Query(default=None, description="Mes desde, 'YYYY-MM' (default: mes en curso)"),
    hasta: str | None = Query(default=None, description="Mes hasta, 'YYYY-MM' (default: = desde)"),
    forzar: bool = Query(default=False, description="Saltea el cache de 5 min"),
):
    """Presupuestos de BULONERÍA (Ven_CodCom 45) del rango, con renglones y
    resumen por estado. Default: mes en curso (a diferencia de los rankings de
    ventas, que usan la ventana fija de 12 meses cerrados). Ver
    presupuestos.py."""
    try:
        return fetch_presupuestos_bulones(vendedor=vendedor, desde=desde, hasta=hasta,
                                          forzar=forzar)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/clientes-por-patron")
def bulones_clientes_por_patron(
    patron: str = Query(..., min_length=1, description="ArticuloPatron (StkFer_Articulos)"),
    vendedor: int | None = Query(default=None),
    limit: int = Query(default=1_000_000, ge=1),
):
    """Clientes que compraron ese código patrón, con los 2 años y desglose
    mensual (el front filtra YTD/Meses sin refetch)."""
    try:
        return fetch_bulones_clientes_por_patron(patron, vendedor=vendedor, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/clientes-por-vendedor")
def bulones_clientes_por_vendedor(
    codigo: int = Query(..., description="VendedorCodigo (Ven_CompCabecera.vendedor)"),
    limit: int = Query(default=1_000_000, ge=1),
):
    """Clientes que ese vendedor FACTURÓ en bulonería (por vc.vendedor, igual
    que el ranking — no por cartera), mismo desglose año/mes."""
    try:
        return fetch_bulones_clientes_por_vendedor(codigo, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/ventas/bulones/patrones-por-cliente")
def bulones_patrones_por_cliente(
    cliente: int = Query(..., description="CodCliente (Magnus)"),
    vendedor: int | None = Query(default=None),
    limit: int = Query(default=1_000_000, ge=1),
):
    """Códigos patrón de bulonería que compró un cliente + el vendedor
    asignado a ese cliente (se muestra arriba del modal)."""
    try:
        return fetch_bulones_patrones_por_cliente(cliente, vendedor=vendedor, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


@app.get("/vendedores")
def vendedores_listar():
    """Catálogo de vendedores (Magnus, maestro `Vendedores`) — alimenta el
    selector de /admin/usuarios y el filtro de vendedor de /ventas/vendedor.
    Devuelve el maestro COMPLETO con banderas `activo` y `persona`; filtrar
    es cosa de quien consume (ver fetch_vendedores en ventas.py). Migrado
    2026-08-27 desde `Ped_Usu_Arma` — ver cartera.py. Solo lectura."""
    try:
        return {"vendedores": fetch_vendedores()}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/indicadores/tiempos")
def get_tiempos(meses: int = Query(default=7, ge=1, le=12)):
    try:
        df_full = cargar_df(meses)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

    df = filtrar(df_full, meses)

    if df.empty:
        return {
            "total": 0, "meses": meses,
            "metricas_mensuales": [], "por_zona": [],
            "por_vendedor": [], "por_prioridad": []
        }

    # ── Métricas mensuales ────────────────────────────────────────────────────
    metricas_mensuales = (
        df.groupby('mes')
          .agg(
              cantidad           = ('NroMovVenta',                  'count'),
              t_reg_susp         = ('Tiempo_Reg_Suspension_min',    promedio_seguro),
              t_susp_confirm     = ('Tiempo_Susp_Confirmacion_min', promedio_seguro),
              t_reg_confirm      = ('Tiempo_Reg_Confirmacion_min',  promedio_seguro),
              t_confirm_armado   = ('Tiempo_Confirm_Armado_min',    promedio_seguro),
              t_armado_cierre    = ('Tiempo_Armado_Cierre_min',     promedio_seguro),
              t_confirm_cierre   = ('Tiempo_Confirm_Cierre_min',    promedio_seguro),
          )
          .reset_index()
          .sort_values('mes')
          .to_dict(orient='records')
    )

    # ── Por zona ──────────────────────────────────────────────────────────────
    por_zona = (
        df.groupby('Zona_Desc')
          .agg(
              cantidad         = ('NroMovVenta',               'count'),
              t_confirm_cierre = ('Tiempo_Confirm_Cierre_min', promedio_seguro),
          )
          .reset_index()
          .sort_values('cantidad', ascending=False)
          .to_dict(orient='records')
    )

    # ── Por vendedor ──────────────────────────────────────────────────────────
    por_vendedor = (
        df.groupby('Vendedor_Nombre')
          .agg(
              cantidad         = ('NroMovVenta',               'count'),
              t_confirm_cierre = ('Tiempo_Confirm_Cierre_min', promedio_seguro),
          )
          .reset_index()
          .sort_values('cantidad', ascending=False)
          .head(15)
          .to_dict(orient='records')
    )

    # ── Por prioridad ─────────────────────────────────────────────────────────
    por_prioridad = (
        df.groupby('Prioridad')
          .agg(
              cantidad         = ('NroMovVenta',               'count'),
              t_confirm_cierre = ('Tiempo_Confirm_Cierre_min', promedio_seguro),
          )
          .reset_index()
          .sort_values('Prioridad')
          .to_dict(orient='records')
    )

    return {
        "total":              len(df),
        "meses":              meses,
        "mes_reciente":       df['mes'].max(),
        "metricas_mensuales": metricas_mensuales,
        "por_zona":           por_zona,
        "por_vendedor":       por_vendedor,
        "por_prioridad":      por_prioridad,
    }

@app.get("/debug/timestamps")
def debug_timestamps():
    """Verificar que la conversión de fechas/horas es correcta."""
    try:
        conn = get_connection()
        df_raw = pd.read_sql(
            "SELECT TOP 10 NroMovVenta, FechaPedido, HoraRegistracion, "
            "FechaSuspendido, HoraSuspendido, FechaConfirmacion, HoraConfirmacion, "
            "FechaArmado, HoraArmado, FechaCierre, HoraCierre "
            "FROM EVERWEAR.dbo.VenFer_PedidoCabecera "
            "WHERE CompCodigo NOT IN (9,49,208,410) "
            "ORDER BY NroMovVenta DESC",
            conn
        )
        conn.close()
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    if df_raw.empty:
        return {"error": "query vacio", "filas": 0}

    df = construir_timestamps(df_raw)
    df = calcular_tiempos(df)

    result = []
    for _, row in df.iterrows():
        result.append({
            "NroMovVenta":               int(row['NroMovVenta']),
            "FechaPedido_raw":           int(row['FechaPedido']),
            "HoraRegistracion_raw":      int(row['HoraRegistracion']),
            "ts_Registro":               str(row['ts_Registro']),
            "ts_Suspendido":             str(row['ts_Suspendido']),
            "ts_Confirmacion":           str(row['ts_Confirmacion']),
            "ts_Armado":                 str(row['ts_Armado']),
            "ts_Cierre":                 str(row['ts_Cierre']),
            "Tiempo_Reg_Suspension_min": row['Tiempo_Reg_Suspension_min'],
            "Tiempo_Susp_Confirm_min":   row['Tiempo_Susp_Confirmacion_min'],
            "Tiempo_Confirm_Armado_min": row['Tiempo_Confirm_Armado_min'],
            "Tiempo_Armado_Cierre_min":  row['Tiempo_Armado_Cierre_min'],
            "Tiempo_Confirm_Cierre_min": row['Tiempo_Confirm_Cierre_min'],
        })

    return {"filas": len(result), "datos": result}


@app.get("/deposito/resumen-ot")
def deposito_resumen_ot(desde: str | None = None, hasta: str | None = None):
    try:
        return deposito.fetch_resumen_ot(desde, hasta)
    except Exception as e:
        raise HTTPException(503, f"SQL Error: {str(e)}")
    
    
@app.get("/deposito/mesa-control")
def deposito_mesa_control(meses: str = Query(..., description="Meses 'YYYY-MM' separados por coma")):
    """Productividad por Controlador (SP RPT_V325_ProductividadPorControlador),
    uno o más meses para comparar. `meses`='2026-05,2026-06,2026-07'.
    Solo lectura sobre EVERWEAR. Ver mesa_control.py."""
    lista = [m.strip() for m in meses.split(",") if m.strip()]
    if not lista:
        raise HTTPException(status_code=400, detail="Falta el parámetro 'meses'")
    try:
        return fetch_mesa_control(lista)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/mesa-control/diag")
def deposito_mesa_control_diag(mes: str | None = Query(default=None)):
    """Diagnóstico: columnas reales devueltas por el SP de productividad por
    controlador, para confirmar el mapeo de mesa_control.py."""
    try:
        return fetch_mesa_control_diag(mes)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/mesa-control/sp-definicion")
def deposito_mesa_control_sp_definicion():
    """Texto T-SQL real del SP RPT_V325_ProductividadPorControlador (sólo
    lectura de metadata). Sirve para ubicar la tabla fuente de control
    (columnas de factura/pedido/renglón) y así poder armar un conteo EXACTO
    de items controlados (sin duplicar por doble controlador) — ver pedido
    de contaduría sobre la pestaña Mesas de Control."""
    try:
        return fetch_mesa_control_sp_definicion()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/mesa-control/tablas-diag")
def deposito_mesa_control_tablas_diag():
    """Columnas reales de Ven_PedImpresoCP y venfer_pedidoReng (tablas fuente
    del SP de mesa de control), para armar el conteo EXACTO (sin duplicar)."""
    try:
        return fetch_mesa_control_tablas_diag()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/mesa-control/recontroles-diag")
def deposito_mesa_control_recontroles_diag(mes: str | None = Query(default=None)):
    """Cuántos pedidos tienen más de 1 fila en Ven_PedImpresoCP para el mismo
    (NroMovVenta, CodCentroPrep) en el mes — confirma el recontrol/reimpresión
    que explica la diferencia contra la planilla de contaduría."""
    try:
        return fetch_mesa_control_recontroles_diag(mes)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/ubicacion-columnas/diag")
def diag_ubicacion_cols():
    conn = get_connection("WMS")
    cur = conn.cursor()
    cur.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='UbicacionDetalle'")
    return {"columnas": [r[0] for r in cur.fetchall()]}


# ── Errores de Mesa de Control (widget de escritorio) ─────────────────────────
class ErrorMesaIn(BaseModel):
    nroPedido: int
    nroOperario: int
    detalleError: str
    articulos: list[str] | None = None

# Alta en lote (REDISEÑO 2026-08-04): 1 error por artículo, ver
# insert_error_mesa_items en errores_mesa.py.
class ErrorMesaItem(BaseModel):
    codArticulo: str
    detalleError: str

class ErrorMesaItemsIn(BaseModel):
    nroPedido: int
    nroOperario: int
    items: list[ErrorMesaItem]

class ErrorCalidadIn(BaseModel):
    nroPedido: int
    nroOperario: int
    detalleError: str
    observacion: str | None = None
    articulos: list[str] | None = None

# Alta en lote para Calidad (REDISEÑO 2026-08-20): 1 error por artículo,
# mismo patrón que ErrorMesaItem/ErrorMesaItemsIn arriba — ver
# insert_error_calidad_items en errores_mesa.py.
#
# CAMBIO 2026-08-20, 2da vuelta: se sacó el input único
# de Observaciones del widget — `observacion` ya NO va a nivel de
# ErrorCalidadItemsIn (compartido para todo el lote), ahora es un campo
# opcional POR ÍTEM (nota distinta por artículo, tipeada justo después de
# elegir su error).
class ErrorCalidadItem(BaseModel):
    codArticulo: str
    detalleError: str
    observacion: str | None = None

class ErrorCalidadItemsIn(BaseModel):
    nroPedido: int
    nroOperario: int
    items: list[ErrorCalidadItem]

class ObservacionIn(BaseModel):
    observacion: str

class AsignarIn(BaseModel):
    nroOperario: int

@app.get("/deposito/pedido/{nro}")
def deposito_pedido(nro: int):
    """Lookup por Nro Pedido (NroMovVenta): Fecha (registracion) + fechaArmado
    (OT) + fechaControl (Mesa de Control) + Tipo Pedido (Magnus) + OT +
    N Armador/Nombre (WMS). Solo lectura. 404 si no existe en Magnus."""
    try:
        info = fetch_pedido_lookup(nro)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    if info is None:
        raise HTTPException(status_code=404, detail="Pedido no encontrado")
    return info

@app.get("/deposito/pedido/{nro}/articulos")
def deposito_pedido_articulos(nro: int):
    """Artículos de la OT de Picking del pedido (WMS), para el selector
    multiple-choice de los widgets de Mesa de Control/Calidad. [] (no 404)
    si el pedido no tiene OT todavía — no es un error bloqueante."""
    try:
        return fetch_articulos_pedido(nro)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/errores-mesa")
def deposito_errores_mesa_listar(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    limit: int = Query(default=1000, le=5000),
):
    """Lista de registros de deposito.errores_mesa (alta desde el widget de
    escritorio), para la vista de depósito. Filtro opcional por rango de
    fecha; Controlador/Preparador se filtran en el cliente."""
    try:
        return fetch_errores_mesa_list(desde, hasta, limit)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.get("/deposito/errores-mesa/opciones")
def deposito_errores_mesa_opciones():
    """Opciones fijas del select de Detalle Error (widget de Mesa de
    Control). Ver errores_mesa.py — DETALLE_ERROR_OPCIONES."""
    return errores_mesa_opciones()

@app.get("/deposito/errores-mesa/calidad/opciones")
def deposito_errores_mesa_calidad_opciones():
    """Opciones fijas del select de Detalle Error PARA CALIDAD (REDISEÑO
    2026-08-20) — lista propia, distinta de Mesa. Ver
    errores_mesa.py — DETALLE_ERROR_OPCIONES_CALIDAD."""
    return errores_mesa_opciones_calidad()

@app.get("/deposito/errores-mesa/operario")
def deposito_errores_mesa_operario(nro: int = Query(...)):
    """Nombre del operario/controlador por N° de Personal (WMS), para la
    pantalla inicial del widget (se pide 1 vez al abrir, no por pedido)."""
    try:
        nombre = fetch_operario_nombre(nro)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    if not nombre:
        raise HTTPException(status_code=404, detail="Operario no encontrado")
    return {"nroOperario": nro, "nombre": nombre}

@app.post("/deposito/errores-mesa")
def deposito_errores_mesa_crear(body: ErrorMesaIn):
    """Alta de un registro de error (Postgres deposito.errores_mesa). Re-resuelve
    fecha/tipo/OT/armador del pedido + nombre del controlador (nroOperario,
    WMS.Personal) del lado del server (no confía en el cliente)."""
    try:
        return insert_error_mesa(
            body.nroPedido, body.nroOperario, body.detalleError, body.articulos
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.post("/deposito/errores-mesa/items")
def deposito_errores_mesa_crear_items(body: ErrorMesaItemsIn):
    """Botón "Finalizar" del widget de Mesa de Control (REDISEÑO 2026-08-04):
    alta en lote, 1 fila en deposito.errores_mesa por artículo (cada uno con
    su propio detalleError, elegido artículo por artículo en el widget) — ver
    insert_error_mesa_items."""
    try:
        return insert_error_mesa_items(
            body.nroPedido, body.nroOperario,
            [i.model_dump() for i in body.items],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.post("/deposito/errores-mesa/calidad")
def deposito_errores_mesa_calidad_crear(body: ErrorCalidadIn):
    """Alta desde el widget de Calidad (endpoint viejo, 1 solo detalleError
    para todo el pedido): controlador se resuelve solo (Magnus,
    Ven_PedImpresoCP), no lo pide el widget. `observacion` es opcional (nota
    libre tipeada en el widget). Ver insert_error_calidad. Sigue vivo por
    compatibilidad (mismo criterio que /errores-mesa sin /items para Mesa),
    pero el widget de Calidad (REDISEÑO 2026-08-20) ya usa
    /errores-mesa/calidad/items en su lugar."""
    try:
        return insert_error_calidad(
            body.nroPedido, body.nroOperario, body.detalleError, body.observacion, body.articulos
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.post("/deposito/errores-mesa/calidad/items")
def deposito_errores_mesa_calidad_crear_items(body: ErrorCalidadItemsIn):
    """Botón "Finalizar" del widget de Calidad (REDISEÑO 2026-08-20: mismo patrón que /errores-mesa/items para Mesa de Control):
    alta en lote, 1 fila en deposito.errores_mesa por artículo, cada uno con
    su propio detalleError Y su propia observación (elegidos artículo por
    artículo en el widget, sin input de Observaciones único) — ver
    insert_error_calidad_items."""
    try:
        return insert_error_calidad_items(
            body.nroPedido, body.nroOperario,
            [i.model_dump() for i in body.items],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.patch("/deposito/errores-mesa/{error_id}")
def deposito_errores_mesa_actualizar_observacion(error_id: int, body: ObservacionIn):
    """Nota libre (columna observacion), editable desde la vista web /deposito
    (no desde el widget de escritorio)."""
    try:
        return update_observacion(error_id, body.observacion)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.get("/deposito/errores-mesa/ubicacion-diag")
def deposito_errores_mesa_ubicacion_diag(nro: int | None = Query(default=None)):
    """Diagnóstico: columna de OT detectada para 'Observaciones'/ubicación
    (LIKE '%OBSERV%') y, con `nro`, el lookup completo de ese pedido."""
    try:
        return fetch_ubicacion_diag(nro)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/errores-mesa/controlador-diag")
def deposito_errores_mesa_controlador_diag(nro: int = Query(...)):
    """Diagnóstico: TODAS las filas de Ven_PedImpresoCP para `nro` (sin el
    filtro de fetch_controlador_pedido) + lo que resuelve esa función. Usar
    cuando un pedido con control confirmado en Magnus igual da "sin
    controlador registrado" en el widget de Calidad."""
    try:
        return fetch_controlador_diag(nro)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.post("/deposito/errores-mesa/asignar")
def deposito_errores_mesa_asignar(body: AsignarIn):
    """Botón "Asignar" del widget de Mesa de Control: reclama el próximo
    pedido de la cola (Cumplido en WMS + Abierto en Magnus, cruce por Nro de
    movimiento — ver control_asignacion.py) para `nroOperario`. Atómico
    (SKIP LOCKED): nunca se asigna el mismo pedido a 2 operarios aunque
    llamen al mismo tiempo. 404 si el operario no existe o si no hay pedidos
    disponibles para asignar."""
    try:
        return asignar_siguiente(body.nroOperario)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error: {str(e)}")

@app.get("/deposito/errores-mesa/cola-diag")
def deposito_errores_mesa_cola_diag(limit: int = Query(default=20, le=200)):
    """Diagnóstico: cuántos pedidos libres/asignados hay ahora en
    deposito.control_asignacion + una muestra reciente."""
    try:
        return fetch_cola_diag(limit)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

@app.get("/deposito/control-asignacion/pedidos")
def deposito_control_asignacion_pedidos(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Historial de pedidos ASIGNADOS (deposito.control_asignacion) para la
    vista "Pedidos asignados" (detalle, dentro de /deposito/deposito →
    Mesas): quién controló cada pedido, cuándo, cuántos ítems tenía, y
    "horaCierre" (próxima asignación del MISMO operario, proxy de tiempo de
    control — ver fetch_pedidos_asignados). Sin desde/hasta: HOY."""
    try:
        return fetch_pedidos_asignados(desde, hasta)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


# ── RRHH: Reclutamiento ────────────────────────────────────────────────────
@app.get("/rrhh/cvs-por-mes")
def rrhh_cvs_por_mes(meses: int = Query(default=12, ge=1, le=36)):
    """CVs recibidos por mes (Postgres rag_system.documento_aprobado,
    tipo='CV'). Ver rrhh.py."""
    try:
        return fetch_cvs_por_mes(meses)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")

# ── Compras: línea (Stk_Nivel1) de una lista puntual de artículos ───────────
# Para la sección "Faltantes por línea" del dashboard /compras (2026-08-26). Es POST y no GET porque la lista de faltantes de un mes
# puede ser de varios cientos de códigos y no entra cómoda en la URL.
class LineasArticulosIn(BaseModel):
    codigos: list[str]


@app.post("/compras/lineas-articulos")
def compras_lineas_articulos(body: LineasArticulosIn):
    """{CodArticulo: nombre de línea} para los códigos pedidos. Los que no
    resuelven a una línea no vienen en el dict (ver fetch_lineas_por_articulos)."""
    try:
        return fetch_lineas_por_articulos(body.codigos)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")


# ── Depósito: tiempos de picking (tab "Tiempos de Picking") ─────────────────
# Tres endpoints con la misma fuente (WMS.dbo.OTItem, PickIni/PickFin por
# renglón) y distinto grano: el heatmap agregado, las cabeceras de OT y el
# detalle de una OT. Ver deposito.py :: SQL_PICK_*.
@app.get("/deposito/picking-horas")
def deposito_picking_horas(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Pickeos por fecha x operario x hora. El front arma con estas filas los
    tres ejes del heatmap (operario, día de semana, día del mes)."""
    try:
        d, h = _parse_rango(desde, hasta)
        rows = fetch_pick_heatmap(d, h)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {"desde": d.date().isoformat(), "hasta": h.date().isoformat(),
            "total": len(rows), "rows": rows}


@app.get("/deposito/picking-ots")
def deposito_picking_ots(
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
):
    """Una fila por OT de picking: hora de inicio, hora de fin, ítems y tiempos."""
    try:
        d, h = _parse_rango(desde, hasta)
        rows = fetch_pick_ots(d, h)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {"desde": d.date().isoformat(), "hasta": h.date().isoformat(),
            "total": len(rows), "rows": rows}


@app.get("/deposito/picking-ot-items")
def deposito_picking_ot_items(ot: int = Query(...)):
    """Renglones de una OT con artículo, ubicación, inicio, fin y segundos."""
    try:
        rows = fetch_pick_ot_items(ot)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"SQL Error: {str(e)}")
    return {"ot": ot, "total": len(rows), "rows": rows}
