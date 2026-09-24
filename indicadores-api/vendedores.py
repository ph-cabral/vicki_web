"""
Códigos de Magnus que le corresponden a un vendedor (propio + heredados).

EL EJE DE LA PLATA ES EL COMPROBANTE
Desde 2026-09-08 todas las vistas de venta por vendedor cortan por
`Ven_CompCabecera.vendedor` — el mismo eje del pivot `Ventas_Debitos_Creditos`
y de `ventas_subempresa_mensual.sql`. Antes cortaban por CARTERA del cliente
(zona ∪ historial, ver cartera.py) y eso rompía dos cosas:

  · un vendedor se llevaba la venta emitida con OTRO código sobre sus mismos
    clientes (el vendedor anterior de la zona, mostrador, canales);
  · un cliente que caía en la cartera de DOS vendedores sumaba en las dos
    pantallas, así que la suma de todas las vistas daba MÁS que el total de
    la empresa.

Medido el 2026-09-08 (Ene–Ago 2026, MAGNUS con renglón de artículo): la vista
de BUTTUSSI se llevaba 386,7M emitidos por BOTTERO, la de BLANCO mostraba
242,4M emitidos por BRITEZ, y la de UBALDO sumaba los 51,5M de ROSSETTI.

QUÉ HACE ESTE MÓDULO
El eje comprobante solo no alcanza: cuando un vendedor se va, su cartera
queda a cargo de otro y esa venta vieja tiene que seguir contando para el
que la heredó. Ese mapeo es EXPLÍCITO y se administra en /admin/usuarios —
tabla `everwear.vendedor_antecesor` (ver sql/vendedor_antecesor.sql).

`codigos_de(801)` -> (794, 801): Buttussi suma lo suyo y lo de Bottero.

La cadena se resuelve TRANSITIVA: si Bottero ya había heredado a alguien,
Buttussi se lleva la cadena entera. `antecesor_codigo` es UNIQUE en la base,
así que ningún código puede pertenecer a dos vendedores y la suma de todas
las vistas sigue dando el total exacto de la empresa.

CÓMO SE ENCHUFA EN LAS CONSULTAS
Los códigos se INLINEAN en el SQL (son enteros validados con int(), no hay
inyección posible) en vez de ir como parámetros. Es a propósito:

  · la cantidad de códigos cambia por vendedor, así que como parámetros
    habría que recalcular el orden de los `?` en cada consulta — justo el
    tipo de acople que ya había roto el JOIN de cartera;
  · las consultas de este proyecto se construyen a nivel de módulo y se
    transforman para la sub-empresa PRUEBA (subempresas.sql_prueba); un
    literal viaja intacto por esa transformación y los `?` quedan en el
    mismo orden en las dos copias;
  · SQL Server cachea un plan por lista de códigos, que son pocas y
    estables.

El recorte es rápido: `Ven_CompCabecera` tiene el índice
`V_CAB_Cla_VendedorFecha (Vendedor, FecMovim)`, así que un `vendedor IN
(...)` + rango de fechas es un seek por código. Es MENOS trabajo que el JOIN
de cartera que reemplaza (que armaba una tabla derivada con UNION sobre
Clientes + Vendedor_Zona + las dos cabeceras en cada consulta).

Uso típico en un módulo de consultas:

    SQL_X = _solo_venta(f\"\"\"
    SELECT ...
    FROM Ven_CompCabecera vc
    ...
    WHERE cc.EvitaInformesYListados <> 1
      AND vc.FecMovim BETWEEN ? AND ?
    {MARCA}
    GROUP BY ...
    \"\"\")

    # en el fetch:
    sql = aplicar(SQL_X, vendedor)          # vendedor None -> saca la marca
    cur.execute(sql, params)                # params NO cambian

La cartera (cartera.py) NO desaparece: sigue siendo el criterio de PERMISOS
(qué clientes puede buscar y abrir un vendedor, y qué faltantes ve), pero
calculada sobre TODOS estos códigos, no sobre uno solo.
"""
import time

# Marca que se reemplaza por el recorte de vendedor. Es un comentario SQL a
# propósito: si una consulta se ejecuta sin pasar por `aplicar()` (caso
# admin / "toda la empresa"), la marca es inofensiva y la query corre igual.
MARCA = "/*@@VENDEDOR@@*/"

# La tabla es de una decena de filas y sólo cambia cuando un admin edita el
# mapeo, pero se lee en CADA consulta de venta: sin cache serían dos o tres
# viajes a Postgres por request. TTL corto para que un alta en
# /admin/usuarios se vea enseguida.
_CACHE: dict[int, tuple[float, tuple[int, ...]]] = {}
_TTL_SEG = 5 * 60

_SQL_MAPA = """
SELECT sucesor_codigo, antecesor_codigo
FROM everwear.vendedor_antecesor
"""


def _mapa() -> dict[int, list[int]]:
    """{sucesor: [antecesores directos]} leído de Postgres. Si Postgres no
    está disponible devuelve {} — sin mapeo cada vendedor ve sólo su propio
    código, que es el comportamiento correcto por defecto (nunca ve de más).
    """
    try:
        from db_pg import get_pg_connection

        conn = get_pg_connection()
        try:
            cur = conn.cursor()
            cur.execute(_SQL_MAPA)
            out: dict[int, list[int]] = {}
            for suc, ant in cur.fetchall():
                if suc is None or ant is None:
                    continue
                out.setdefault(int(suc), []).append(int(ant))
            return out
        finally:
            conn.close()
    except Exception:
        return {}


def codigos_de(vendedor) -> tuple[int, ...]:
    """Códigos de Magnus que suma `vendedor`: el propio más los de sus
    antecesores, en cadena. Siempre incluye el propio, siempre ordenado y sin
    repetidos (así la lista es estable y el plan de SQL Server se reusa)."""
    v = int(vendedor)
    ahora = time.time()
    hit = _CACHE.get(v)
    if hit and (ahora - hit[0]) < _TTL_SEG:
        return hit[1]

    mapa = _mapa()
    vistos = {v}
    pendientes = [v]
    while pendientes:                      # BFS; `vistos` corta cualquier ciclo
        actual = pendientes.pop()
        for ant in mapa.get(actual, ()):
            if ant not in vistos:
                vistos.add(ant)
                pendientes.append(ant)

    codigos = tuple(sorted(vistos))
    _CACHE[v] = (ahora, codigos)
    return codigos


_CACHE_DUENO: dict[str, tuple[float, dict[int, int]]] = {}


def mapa_dueno() -> dict[int, int]:
    """{codigo_heredado: codigo_del_que_lo_hereda} ya resuelto en cadena.

    Lo usa el ranking de VENDEDORES (bulones.py), que agrupa por
    `Ven_CompCabecera.vendedor` y por lo tanto sacaría una fila propia para
    BOTTERO, ROSSETTI o BLANCO. Con este mapa esas filas se colapsan en la
    del sucesor: el ranking muestra una fila por persona que hoy vende, y la
    suma de las filas sigue siendo el total de la empresa."""
    ahora = time.time()
    hit = _CACHE_DUENO.get("m")
    if hit and (ahora - hit[0]) < _TTL_SEG:
        return hit[1]

    mapa = _mapa()
    # Sólo los sucesores FINALES arman el mapa. En una cadena A->B->C, `B` es
    # sucesor de C pero antecesor de A: si se lo tomara como dueño, `C`
    # terminaría apuntando a B en vez de a A según el orden del recorrido.
    heredados = {ant for ants in mapa.values() for ant in ants}
    finales = [suc for suc in mapa if suc not in heredados]

    out: dict[int, int] = {}
    for suc in finales:
        for cod in codigos_de(suc):
            if cod != suc:
                out[cod] = suc
    _CACHE_DUENO["m"] = (ahora, out)
    return out


def dueno_de(codigo) -> int:
    """El vendedor que se queda con lo emitido bajo `codigo` — él mismo si
    nadie lo heredó."""
    c = int(codigo)
    return mapa_dueno().get(c, c)


def clave(vendedor):
    """Lo que tiene que ir en la clave de CUALQUIER cache de resultados que
    dependa del recorte por vendedor: los CÓDIGOS que suma, no el código del
    vendedor solo.

    Con el vendedor pelado en la clave, el resultado cacheado (15 min en
    ventas.py / bulones.py / bonificaciones.py) sobrevivía a un alta o baja de
    antecesor en /admin/usuarios: el mapeo se invalidaba, pero la vista
    seguía devolviendo lo calculado con los códigos viejos hasta que vencía
    su propio TTL — el que heredaba no veía la venta del antecesor. Con la
    tupla de códigos en la clave, cambiar el mapeo cambia la clave y la
    próxima consulta se recalcula sola. `codigos_de` está cacheado, no suma
    viajes a Postgres. None (admin / toda la empresa) queda None."""
    if vendedor is None:
        return None
    return codigos_de(vendedor)


def invalidar_cache() -> None:
    """Se llama al editar el mapeo (o desde un test) para no esperar el TTL."""
    _CACHE.clear()
    _CACHE_DUENO.clear()


def filtro(vendedor, alias: str = "vc") -> str:
    """El pedacito de WHERE que recorta al vendedor y a sus antecesores.
    Cadena vacía si `vendedor` es None (admin / toda la empresa)."""
    if vendedor is None:
        return ""
    codigos = codigos_de(vendedor)
    lista = ",".join(str(c) for c in codigos)   # ints: no hay inyección
    return f"  AND {alias}.vendedor IN ({lista})\n"


def aplicar(sql: str, vendedor, alias: str = "vc") -> str:
    """Reemplaza MARCA por el recorte de vendedor. Con `vendedor` None saca
    la marca y la consulta queda como la de "toda la empresa" — por eso ya no
    hacen falta dos constantes SQL gemelas (VENDEDOR / TODOS) por consulta."""
    return sql.replace(MARCA, filtro(vendedor, alias))
