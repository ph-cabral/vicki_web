"""
Conexión a SQL Server (Magnus/WMS, SOLO LECTURA desde esta API).

Tres ajustes de sesión que cambian el rendimiento de TODAS las consultas del
proyecto y por eso viven acá y no en cada módulo:

1. `setencoding(ctype=SQL_CHAR)` — LO MÁS IMPORTANTE.
   Por defecto pyodbc manda los str de Python como NVARCHAR. Las columnas de
   Magnus son CHAR/VARCHAR (colación SQL_Latin1_General_CP1_CI_AS, código de
   página 1252). Comparar una columna CHAR contra un parámetro NVARCHAR obliga
   a SQL Server a convertir LA COLUMNA fila por fila (CONVERT_IMPLICIT), lo que
   anula el índice y fuerza un scan completo de la tabla.
   Medido sobre Ven_PedRenPendientes (361k filas) con la misma consulta y el
   mismo resultado:
       parámetro NVARCHAR (lo de antes) → 137,4 ms / 1.854 páginas leídas
       parámetro VARCHAR  (esto)        →   0,4 ms /   105 páginas leídas
   La decodificación de los resultados NO se toca: el driver de Linux ya
   entrega el texto en UTF-8 y cambiarla rompería los acentos.

2. `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` — Magnus es un ERP con
   gente facturando en vivo. Sin esto, una consulta de tablero toma locks
   compartidos sobre VenFer_PedidoCabecera / Ven_CompCabecera y (a) se frena
   esperando a los usuarios del ERP y (b) los frena a ellos. Esta API solo lee
   para tableros, así que la lectura sucia es aceptable y evita el bloqueo
   cruzado. Para un caso que necesite consistencia estricta:
   get_connection(..., aislamiento="READ COMMITTED").

3. `SET ARITHABORT ON` — los clientes ODBC vienen con ARITHABORT OFF, lo que
   deja a la consulta en una entrada de caché de planes distinta de la que usa
   el ERP/SSMS y suele terminar en el plan malo. Es el clásico "en SSMS vuela y
   desde la app tarda".

Además queda activo el pool del driver (`pyodbc.pooling`), así una petición que
abre varias conexiones no paga el handshake TCP+TLS+login cada vez. Para que el
pool sea efectivo el contenedor necesita `[ODBC] Pooling=Yes` en odbcinst.ini
(ver Dockerfile).
"""
import os

import pyodbc
from dotenv import load_dotenv

load_dotenv()

# Reutiliza conexiones en vez de abrir una nueva por request.
pyodbc.pooling = True

# Segundos de espera para establecer la conexión (no para la consulta).
LOGIN_TIMEOUT = int(os.getenv("SQL_LOGIN_TIMEOUT", "15"))

AISLAMIENTO_POR_DEFECTO = "READ UNCOMMITTED"
_AISLAMIENTOS = {
    "READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ",
    "SNAPSHOT", "SERIALIZABLE",
}


def get_connection(
    database: str | None = None,
    *,
    aislamiento: str | None = None,
):
    # Auth SQL nativa: el server migrado a 10.10.0.195 ya no acepta
    # Trusted_Connection/Kerberos AD (ver MIGRACION_SQLSERVER_MAGNUS.md). Ya no
    # hace falta KRB5CCNAME/ccache.
    server   = os.getenv("SQL_SERVER", "10.10.0.195")
    database = database or os.getenv("SQL_DATABASE")
    user     = os.getenv("SQL_USER", "sa")
    pwd      = os.getenv("SQL_PASSWORD")
    if not pwd:
        raise RuntimeError("Falta SQL_PASSWORD en el entorno (.env) — no hardcodear la clave en el código")

    conn_str = (
        "DRIVER={ODBC Driver 18 for SQL Server};"
        f"SERVER={server};"
        f"DATABASE={database};"
        f"UID={user};PWD={pwd};"
        "TrustServerCertificate=yes;"
    )
    nivel = (aislamiento or AISLAMIENTO_POR_DEFECTO).upper()
    if nivel not in _AISLAMIENTOS:
        raise ValueError(f"Nivel de aislamiento desconocido: {aislamiento!r}")

    conn = pyodbc.connect(conn_str, timeout=LOGIN_TIMEOUT)

    # Los str de Python viajan como VARCHAR, no como NVARCHAR (ver (1) arriba).
    # El encoding sigue siendo UTF-8: el driver de Linux hace la conversión al
    # código de página del servidor, igual que ya hace al leer.
    conn.setencoding(encoding="utf-8", ctype=pyodbc.SQL_CHAR)

    cur = conn.cursor()
    cur.execute(
        "SET NOCOUNT ON;"
        "SET ARITHABORT ON;"
        "SET DATEFORMAT ymd;"
        f"SET TRANSACTION ISOLATION LEVEL {nivel};"
    )
    cur.close()
    return conn
