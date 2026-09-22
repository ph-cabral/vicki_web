"""
Registro DIARIO del faltante mensual — preparado.faltante_mes /
preparado.faltante_mes_existente.

Qué hace (2026-09-22, reescrito el mismo día para depender de la marca)
-------------------------------------------------------------------------
1. Backfill del detalle: trae de Magnus TODA la diferencia pedida vs cumplida
   del mes (pedidos Cerrados/Facturados, mismo criterio que
   /deposito/faltante-pedidos) y la upsertea en preparado.faltante_pedido.
   Esto garantiza que el detalle esté completo aunque nadie haya abierto
   /deposito/faltantes ese día — la vista solo persiste el ÚLTIMO día cerrado
   en cada carga, así que sin este paso un día sin visitas queda sin detalle.
2. Registro mensual: agrupa por artículo lo que la MESA marcó
   (preparado.faltante_existencia), cruzando contra el detalle del paso 1:
     existencia = false (sin existencia) → preparado.faltante_mes (faltante real)
     existencia = true  (en existencia)  → preparado.faltante_mes_existente
                                            (no se cumplió habiendo stock)
   Lo pendiente (sin marcar) y lo "mal facturado" no suman en ninguna.
   Es el mismo join que hace lib/deposito/faltanteMes.ts del lado Node — acá
   se repite en SQL puro porque este job corre standalone, sin pasar por la
   app.

Por qué se recalcula en vez de sumar
-------------------------------------
Sumar (unidades = unidades + x) no es idempotente: correr el job dos veces el
mismo día duplicaría, y una marca que se corrige después (de "sin" a "en
existencia", o se borra) seguiría sumando lo viejo para siempre. El job
recalcula el mes completo y pisa el total (UPSERT con SET =): mismo resultado
corra una vez o veinte, y los cambios de marca se reflejan solos.

Uso
---
    python faltante_mes_job.py                  # mes en curso (+ el anterior
                                                 # si estamos en los primeros
                                                 # días)
    python faltante_mes_job.py 2026-08           # un mes puntual
    python faltante_mes_job.py 2026-01 2026-09   # rango de meses (backfill)

Se corre DENTRO del contenedor de indicadores-api (es el único con las dos
conexiones), por ejemplo una vez por día:

    docker exec vicki_web-indicadores-api-1 python faltante_mes_job.py

Los primeros días del mes también recalcula el mes anterior: un pedido cerrado
a fin de mes puede facturarse o cancelarse después.
"""
import sys
from datetime import date, datetime, timedelta

from deposito import fetch_faltante_pedidos
from db_pg import get_pg_connection

# Durante estos primeros días del mes, además del mes en curso se recalcula el
# anterior (todavía se le pueden mover pedidos).
DIAS_REVISION_MES_ANTERIOR = 5
CHUNK = 500


def _mes_anterior(mes: str) -> str:
    a, m = (int(x) for x in mes.split("-"))
    return f"{a - 1}-12" if m == 1 else f"{a}-{m - 1:02d}"


def _mes_siguiente(mes: str) -> str:
    a, m = (int(x) for x in mes.split("-"))
    return f"{a + 1}-01" if m == 12 else f"{a}-{m + 1:02d}"


def _meses(argv: list[str]) -> list[str]:
    hoy = date.today()
    actual = hoy.strftime("%Y-%m")
    if not argv:
        meses = [actual]
        if hoy.day <= DIAS_REVISION_MES_ANTERIOR:
            meses.append(_mes_anterior(actual))
        return meses
    for a in argv:
        datetime.strptime(a, "%Y-%m")  # valida formato
    if len(argv) == 1:
        return [argv[0]]
    desde, hasta = sorted(argv[:2])
    out, cur = [], desde
    while cur <= hasta:
        out.append(cur)
        cur = _mes_siguiente(cur)
    return out


def _backfill_detalle(mes: str) -> int:
    """Trae de Magnus toda la diferencia del mes y la upsertea en
    preparado.faltante_pedido. Devuelve la cantidad de renglones traídos."""
    anio, mm = (int(x) for x in mes.split("-"))
    primer_dia = date(anio, mm, 1)
    a2, m2 = (int(x) for x in _mes_siguiente(mes).split("-"))
    ultimo_dia_mes = date(a2, m2, 1) - timedelta(days=1)
    hoy = date.today()
    if primer_dia > hoy:
        return 0
    # Tope al último día del mes pedido, o a hoy si el mes está en curso.
    # fetch_faltante_pedidos resuelve además 'hasta' hoy/futuro al último día
    # CERRADO antes de hoy (ver _rango_faltante_pedidos en deposito.py), así
    # que para el mes en curso no hace falta recortar más.
    hasta_str = min(ultimo_dia_mes, hoy).isoformat()

    data = fetch_faltante_pedidos(primer_dia.isoformat(), hasta_str)
    rows = data.get("rows") or []
    if not rows:
        return 0

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i:i + CHUNK]
            valores = []
            params: list = []
            for r in chunk:
                valores.append("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())")
                params += [
                    r["NroMovVenta"], r["Renglon"], r["Fecha"], r["CodArticulo"],
                    r.get("Nombre") or "", r.get("Cliente"), r.get("ClienteNombre"),
                    r.get("Vendedor") or "", r.get("Ubicacion") or "",
                    r.get("CompCodigo"), r.get("EstadoPedido"), r.get("EstadoRenglon"),
                    r["CantPedida"], r["CantCumplida"], r["Diferencia"], r["Importe"],
                ]
            cur.execute(f"""
                INSERT INTO preparado.faltante_pedido
                  ("nroMovVenta", "nroRenglon", fecha, "codArticulo", nombre,
                   cliente, "clienteNombre", vendedor, ubicacion, "compCodigo",
                   "estadoPedido", "estadoRenglon", "cantPedida", "cantCumplida",
                   diferencia, importe, "updatedAt")
                VALUES {','.join(valores)}
                ON CONFLICT ("nroMovVenta", "nroRenglon") DO UPDATE SET
                  fecha           = EXCLUDED.fecha,
                  nombre          = EXCLUDED.nombre,
                  "clienteNombre" = COALESCE(EXCLUDED."clienteNombre", preparado.faltante_pedido."clienteNombre"),
                  vendedor        = COALESCE(NULLIF(EXCLUDED.vendedor, ''), preparado.faltante_pedido.vendedor),
                  "estadoPedido"  = EXCLUDED."estadoPedido",
                  "estadoRenglon" = EXCLUDED."estadoRenglon",
                  "cantPedida"    = EXCLUDED."cantPedida",
                  "cantCumplida"  = EXCLUDED."cantCumplida",
                  diferencia      = EXCLUDED.diferencia,
                  importe         = EXCLUDED.importe,
                  "updatedAt"     = now()
            """, params)
        conn.commit()
    finally:
        conn.close()
    return len(rows)


def _registrar_tabla(cur, tabla: str, existencia: bool, primer_dia: date, hasta_excl: date, corte) -> dict:
    """Agrupa por artículo lo marcado `existencia` en el rango, upsertea en
    `tabla` y borra lo que quedó viejo. tabla es un literal fijo (no viene de
    afuera), así que el f-string es seguro."""
    cur.execute(f"""
        SELECT fp."codArticulo",
               MAX(fp.nombre)                     AS nombre,
               SUM(fp.diferencia)                 AS unidades,
               SUM(fp.importe)                    AS importe,
               COUNT(*)                            AS renglones,
               COUNT(DISTINCT fp."nroMovVenta")    AS pedidos
        FROM preparado.faltante_existencia fe
        JOIN preparado.faltante_pedido fp
          ON fp."nroMovVenta" = fe.nro_ped_origen
         AND fp."nroRenglon"  = fe.nro_reng_origen
        WHERE fe.existencia = %s
          AND fp.fecha >= %s AND fp.fecha < %s
        GROUP BY fp."codArticulo"
    """, (existencia, primer_dia, hasta_excl))
    filas = cur.fetchall()

    if filas:
        valores, params = [], []
        for cod, nombre, unidades, importe, renglones, pedidos in filas:
            valores.append("(%s,%s,%s,%s,%s,%s,%s,now())")
            params += [primer_dia, cod, nombre or "", unidades or 0, importe or 0,
                       renglones or 0, pedidos or 0]
        cur.execute(f"""
            INSERT INTO preparado.{tabla}
              (mes, "codArticulo", nombre, unidades, importe, renglones, pedidos, "updatedAt")
            VALUES {','.join(valores)}
            ON CONFLICT (mes, "codArticulo") DO UPDATE SET
              nombre      = EXCLUDED.nombre,
              unidades    = EXCLUDED.unidades,
              importe     = EXCLUDED.importe,
              renglones   = EXCLUDED.renglones,
              pedidos     = EXCLUDED.pedidos,
              "updatedAt" = now()
        """, params)

    cur.execute(
        f'DELETE FROM preparado.{tabla} WHERE mes = %s AND "updatedAt" < %s',
        (primer_dia, corte),
    )
    borradas = cur.rowcount

    unidades_tot = sum(float(f[2] or 0) for f in filas)
    importe_tot = sum(float(f[3] or 0) for f in filas)
    return {"articulos": len(filas), "unidades": round(unidades_tot, 3),
            "importe": round(importe_tot, 2), "borradas": borradas}


def registrar(mes: str) -> dict:
    traidos = _backfill_detalle(mes)

    anio, mm = (int(x) for x in mes.split("-"))
    primer_dia = date(anio, mm, 1)
    a2, m2 = (int(x) for x in _mes_siguiente(mes).split("-"))
    hasta_excl = date(a2, m2, 1)

    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT now()")
        corte = cur.fetchone()[0]

        sin = _registrar_tabla(cur, "faltante_mes", False, primer_dia, hasta_excl, corte)
        con = _registrar_tabla(cur, "faltante_mes_existente", True, primer_dia, hasta_excl, corte)
        conn.commit()
    finally:
        conn.close()

    return {"mes": mes, "detalle_traido": traidos, "sinExistencia": sin, "enExistencia": con}


def main() -> int:
    try:
        meses = _meses(sys.argv[1:])
    except ValueError:
        print("Formato de mes inválido. Uso: faltante_mes_job.py [YYYY-MM [YYYY-MM]]")
        return 2

    fallo = 0
    for mes in meses:
        try:
            r = registrar(mes)
            sin, con = r["sinExistencia"], r["enExistencia"]
            print(
                f"{r['mes']}: detalle {r['detalle_traido']} renglón/es traídos de Magnus · "
                f"sin existencia {sin['articulos']} art. / {sin['unidades']} u. / ${sin['importe']} "
                f"({sin['borradas']} baja/s) · "
                f"en existencia {con['articulos']} art. / {con['unidades']} u. / ${con['importe']} "
                f"({con['borradas']} baja/s)"
            )
        except Exception as e:  # noqa: BLE001 — job: un mes que falla no corta el resto
            fallo = 1
            print(f"{mes}: ERROR {e}", file=sys.stderr)
    return fallo


if __name__ == "__main__":
    raise SystemExit(main())
