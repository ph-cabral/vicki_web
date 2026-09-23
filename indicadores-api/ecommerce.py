"""
Buscador de clientes + cuenta de ecommerce (para /sistema/clientes).

Problema que resuelve: cuando un cliente pide su usuario/contraseña del
ecommerce, el panel de administración NO deja ver la contraseña guardada (solo
cambiarla), y el usuario ni siquiera se puede buscar por número de cliente ni
por CUIT desde ahí. Acá se junta, a partir de UN dato (número de cliente,
nombre o CUIT), el dato del cliente en Magnus + la cuenta del ecommerce con su
usuario y su contraseña.

Dos orígenes, dos servidores:

  1. Cliente (Magnus, LOCAL, SOLO LECTURA) — EVERWEAR.dbo.Ven_Clientes en
     SRV-SQL2 (10.10.0.195), vía db.get_connection("EVERWEAR"). De ahí salen
     razón social, nombre comercial, CUIT, mail, teléfono, provincia, vendedor,
     estado.

  2. Cuenta de ecommerce (aspnet, NUBE, SOLO LECTURA) — la tienda vieja de
     Everwear guarda las cuentas en el ASP.NET Membership clásico, en la base
     `EverWeari` del server de la nube (54.232.225.100,2433, login SQL
     `everweari`). Ahí:
       · aspnet_Users.UserName      → el usuario
       · aspnet_Membership.Password → la contraseña EN CLARO (PasswordFormat=0,
         sin hash; por eso se puede devolver la misma que tenían)
       · aspnet_Profile             → un blob con NroCliente y NroDocu (CUIT)
         serializado al formato de perfil de ASP.NET
         ("Nombre:S:offset:largo:...":"valores concatenados"), que se parsea
         acá para linkear la cuenta con el cliente de Magnus.

     Prolixus (el ecommerce nuevo) NO sirve para esto: sus contraseñas van
     hasheadas (sh5) y no se pueden devolver. La tienda aspnet es la única con
     usuario+contraseña recuperables por cliente.

El listado de cuentas aspnet es chico (~4200) y estático; se trae entero UNA
vez y se cachea en memoria (TTL 5 min) con el índice ya parseado, así cada
búsqueda es en memoria + una sola consulta a Magnus.
"""
import os
import time
import threading
import datetime as dt

import pyodbc

from db import get_connection


class EcomError(RuntimeError):
    """No se pudo leer la tienda aspenet (conexión a la nube caída/ bloqueada)."""


# ── Conexión a la tienda aspnet en la nube ────────────────────────────────────
# pyodbc + ODBC Driver 18 (el mismo del contenedor). El server de la nube es
# viejo: Encrypt=no para que no intente forzar TLS moderno contra un SQL que no
# lo soporta. Login SQL nativo (no AD): no hace falta impersonación.
def _ecom_conn():
    server = os.getenv("ECOM_SQL_SERVER", "54.232.225.100")
    port   = os.getenv("ECOM_SQL_PORT", "2433")
    db     = os.getenv("ECOM_SQL_DATABASE", "EverWeari")
    user   = os.getenv("ECOM_SQL_USER", "everweari")
    pwd    = os.getenv("ECOM_SQL_PASSWORD")
    if not pwd:
        raise EcomError("Falta ECOM_SQL_PASSWORD en el entorno (.env)")
    timeout = int(os.getenv("ECOM_LOGIN_TIMEOUT", "15"))
    conn_str = (
        "DRIVER={ODBC Driver 18 for SQL Server};"
        f"SERVER={server},{port};"
        f"DATABASE={db};"
        f"UID={user};PWD={pwd};"
        "Encrypt=no;TrustServerCertificate=yes;"
    )
    try:
        conn = pyodbc.connect(conn_str, timeout=timeout)
    except pyodbc.Error as e:
        raise EcomError(f"No se pudo conectar a la tienda ecommerce: {e}") from e
    conn.setencoding(encoding="utf-8", ctype=pyodbc.SQL_CHAR)
    return conn


_SQL_CUENTAS = """
SELECT
    CONVERT(varchar(36), u.UserId)               AS userId,
    RTRIM(u.UserName)                            AS usuario,
    RTRIM(m.Password)                            AS password,
    RTRIM(m.Email)                               AS email,
    m.IsLockedOut                                AS bloqueado,
    m.IsApproved                                 AS aprobado,
    m.LastLoginDate                              AS ultimoLogin,
    m.CreateDate                                 AS alta,
    m.LastPasswordChangedDate                    AS cambioPass,
    CAST(p.PropertyNames        AS varchar(600)) AS pn,
    CAST(p.PropertyValuesString AS varchar(1200)) AS pv
FROM aspnet_Users u
JOIN aspnet_Membership m ON m.UserId = u.UserId
LEFT JOIN aspnet_Profile p ON p.UserId = u.UserId
"""


def _parse_profile(pn: str, pv: str) -> dict:
    """Perfil ASP.NET serializado: PropertyNames = 'Nombre:S:offset:largo:...'
    (grupos de 4, con ':' final), PropertyValuesString = valores concatenados.
    Devuelve {NombreProp: valor}."""
    out: dict[str, str] = {}
    if not pn:
        return out
    parts = pn.split(":")
    val = pv or ""
    j = 0
    while j + 3 < len(parts):
        name = parts[j]
        try:
            off = int(parts[j + 2])
            ln = int(parts[j + 3])
        except (ValueError, IndexError):
            break
        if name:
            out[name] = val[off:off + ln]
        j += 4
    return out


def _iso(v) -> str | None:
    if not v:
        return None
    if isinstance(v, dt.datetime):
        # El membership viejo deja 1753-01-01 como "nunca". Lo tratamos como None.
        if v.year <= 1900:
            return None
        return v.strftime("%Y-%m-%d %H:%M")
    return str(v)


_TTL_SEG = int(os.getenv("ECOM_CACHE_TTL", "300"))
_lock = threading.Lock()
_cache: dict = {"ts": 0.0, "rows": None}


def _cuentas() -> list[dict]:
    """Todas las cuentas del ecommerce, parseadas y cacheadas (TTL 5 min)."""
    ahora = time.time()
    with _lock:
        if _cache["rows"] is not None and (ahora - _cache["ts"]) < _TTL_SEG:
            return _cache["rows"]
    conn = _ecom_conn()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_CUENTAS)
        cols = [d[0] for d in cur.description]
        rows: list[dict] = []
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            perfil = _parse_profile(d.get("pn"), d.get("pv"))
            nro = (perfil.get("NroCliente") or "").strip()
            cuit = (perfil.get("NroDocu") or "").strip()
            rows.append({
                "userId": d.get("userId"),
                "usuario": (d.get("usuario") or "").strip(),
                "password": (d.get("password") or ""),
                "emailCuenta": (d.get("email") or "").strip() or None,
                "bloqueado": bool(d.get("bloqueado")),
                "aprobado": bool(d.get("aprobado")),
                "ultimoLogin": _iso(d.get("ultimoLogin")),
                "alta": _iso(d.get("alta")),
                "cambioPass": _iso(d.get("cambioPass")),
                "nroCliente": int(nro) if nro.isdigit() else None,
                "cuit": cuit or None,
                "tipoUser": (perfil.get("TipoUser") or "").strip() or None,
            })
    finally:
        conn.close()
    with _lock:
        _cache["rows"] = rows
        _cache["ts"] = time.time()
    return rows


# ── Cliente en Magnus ─────────────────────────────────────────────────────────
_SQL_CLIENTE_BASE = """
SELECT {top}
    c.CodCliente                        AS codigo,
    LTRIM(RTRIM(c.RazonSocial))         AS razonSocial,
    LTRIM(RTRIM(c.NombreComercial))     AS nombreComercial,
    LTRIM(RTRIM(c.CliDocNro))           AS cuit,
    LTRIM(RTRIM(c.EMail))               AS email,
    LTRIM(RTRIM(c.Telefono))            AS telefono,
    LTRIM(RTRIM(c.Domicilio))           AS domicilio,
    LTRIM(RTRIM(pr.NomPrv))             AS provincia,
    c.Vendedor                          AS vendedorCod,
    LTRIM(RTRIM(v.NombreComercial))     AS vendedor,
    c.CliEstado                         AS cliEstado,
    c.Estado                            AS estado
FROM Ven_Clientes c
LEFT JOIN Gen_Provincias pr ON RTRIM(pr.CodPrv) = RTRIM(c.CodProvin)
LEFT JOIN VW_Vendedor v ON v.CodProveed = c.Vendedor
WHERE {where}
"""


def _fila_cliente(d: dict) -> dict:
    def s(k):
        val = d.get(k)
        val = str(val).strip() if val is not None else ""
        return val or None
    return {
        "codigo": int(d["codigo"]),
        "razonSocial": s("razonSocial"),
        "nombreComercial": s("nombreComercial"),
        "cuit": s("cuit"),
        "email": s("email"),
        "telefono": s("telefono"),
        "domicilio": s("domicilio"),
        "provincia": s("provincia"),
        "vendedor": s("vendedor"),
        "vendedorCod": int(d["vendedorCod"]) if d.get("vendedorCod") is not None else None,
        "activo": (d.get("estado") == 1),
    }


def _magnus_buscar(texto: str, digits: str, limit: int, es_email: bool = False) -> dict[int, dict]:
    """Clientes de Magnus que matchean el texto por código, CUIT, nombre o
    (si el texto trae '@') por email. Devuelve {codigo: fila_cliente}."""
    like = f"%{texto}%"
    if es_email:
        # Con '@' solo tiene sentido el mail: no se busca por nombre ni por
        # los dígitos que pueda traer la dirección (ej. juan123@...).
        conds = ["c.EMail LIKE ?"]
        params: list = [like]
        digits = ""
    else:
        conds = ["c.RazonSocial LIKE ?", "c.NombreComercial LIKE ?"]
        params = [like, like]
    if digits:
        conds.append("c.CliDocNro LIKE ?")
        params.append(f"%{digits}%")
        if len(digits) <= 8:
            conds.append("c.CodCliente = ?")
            params.append(int(digits))
    where = " OR ".join(conds)
    sql = _SQL_CLIENTE_BASE.format(top=f"TOP ({int(limit)})", where=where)
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        out: dict[int, dict] = {}
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            out[int(d["codigo"])] = _fila_cliente(d)
        return out
    finally:
        conn.close()


def _magnus_por_codigos(codigos: list[int]) -> dict[int, dict]:
    cods = sorted({int(c) for c in codigos if c is not None})
    if not cods:
        return {}
    ph = ",".join("?" for _ in cods)
    sql = _SQL_CLIENTE_BASE.format(top="", where=f"c.CodCliente IN ({ph})")
    conn = get_connection("EVERWEAR")
    try:
        cur = conn.cursor()
        cur.execute(sql, cods)
        cols = [d[0] for d in cur.description]
        out: dict[int, dict] = {}
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            out[int(d["codigo"])] = _fila_cliente(d)
        return out
    finally:
        conn.close()


# ── Búsqueda unificada ────────────────────────────────────────────────────────
def buscar(q: str, limit: int = 50) -> dict:
    """Un solo dato (número de cliente / nombre / CUIT) → filas con datos del
    cliente + su(s) cuenta(s) de ecommerce.

    Cada fila: { cliente: {...}|null, cuenta: {...}|null, sinCuenta: bool }.
    Si la tienda ecommerce no responde, igual se devuelven los clientes de
    Magnus (cuenta=null) y ecommerceOk=false con un aviso.
    """
    texto = (q or "").strip()
    if not texto:
        return {"resultados": [], "total": 0, "ecommerceOk": True, "aviso": None}
    limit = max(1, min(int(limit or 50), 100))
    ql = texto.lower()
    es_email = "@" in texto
    # Con '@' los dígitos son parte de la dirección, no un nº de cliente/CUIT.
    digits = "" if es_email else "".join(ch for ch in texto if ch.isdigit())

    # 1) Clientes de Magnus que matchean directamente el texto.
    clientes = _magnus_buscar(texto, digits, limit + 30, es_email)
    cods_directos = set(clientes.keys())

    # 2) Cuentas del ecommerce que matchean (por nº cliente, CUIT, usuario,
    #    email de la cuenta) — o cuyo cliente cayó en la búsqueda de Magnus.
    #    El email de la cuenta es el que bloquea el alta de un usuario nuevo
    #    ("el email ya está vinculado"): así se ve a qué cuenta/cliente quedó
    #    pegado.
    ecommerce_ok = True
    aviso = None
    cuentas_match: list[dict] = []
    try:
        for a in _cuentas():
            hit = False
            mail = (a["emailCuenta"] or "").lower()
            if es_email:
                hit = bool(mail) and ql in mail
            elif digits and a["nroCliente"] is not None and str(a["nroCliente"]) == digits:
                hit = True
            elif digits and len(digits) >= 7 and a["cuit"] and digits in a["cuit"]:
                hit = True
            elif len(ql) >= 2 and a["usuario"] and ql in a["usuario"].lower():
                hit = True
            elif len(ql) >= 4 and mail and ql in mail:
                hit = True
            if not hit and a["nroCliente"] in cods_directos:
                hit = True
            if hit:
                cuentas_match.append(a)
    except EcomError as e:
        ecommerce_ok = False
        aviso = str(e)

    # 3) Traer de Magnus los clientes de esas cuentas que no estaban ya.
    cods_cuentas = {a["nroCliente"] for a in cuentas_match if a["nroCliente"] is not None}
    faltan = cods_cuentas - cods_directos
    if faltan:
        clientes.update(_magnus_por_codigos(list(faltan)))

    # 4) Armar filas: una por cuenta; más los clientes sin cuenta que matchearon
    #    directo por Magnus.
    resultados: list[dict] = []
    cods_con_cuenta: set[int] = set()
    for a in cuentas_match:
        cli = clientes.get(a["nroCliente"]) if a["nroCliente"] is not None else None
        if a["nroCliente"] is not None:
            cods_con_cuenta.add(a["nroCliente"])
        resultados.append({"cliente": cli, "cuenta": a, "sinCuenta": False})

    for cod in cods_directos:
        if cod not in cods_con_cuenta:
            resultados.append({"cliente": clientes[cod], "cuenta": None, "sinCuenta": True})

    # 5) Orden: primero match exacto (nº o usuario/ CUIT), luego con cuenta,
    #    luego por razón social.
    def clave(row):
        cli = row["cliente"] or {}
        cu = row["cuenta"] or {}
        exacto = 0
        if digits and (str(cli.get("codigo")) == digits or cu.get("cuit") == digits
                       or (cli.get("cuit") == digits)):
            exacto = -2
        elif cu.get("usuario") and cu["usuario"].lower() == ql:
            exacto = -2
        elif (cu.get("emailCuenta") or "").lower() == ql:
            exacto = -2
        elif (cli.get("email") or "").lower() == ql:
            exacto = -1
        con_cuenta = 0 if row["cuenta"] else 1
        nombre = (cli.get("razonSocial") or cu.get("usuario") or "").lower()
        return (exacto, con_cuenta, nombre)

    resultados.sort(key=clave)
    total = len(resultados)
    return {
        "resultados": resultados[:limit],
        "total": total,
        "ecommerceOk": ecommerce_ok,
        "aviso": aviso,
    }
