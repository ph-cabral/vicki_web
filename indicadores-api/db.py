import pyodbc
import os
from dotenv import load_dotenv

load_dotenv()

def get_connection(database: str | None = None):
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
    return pyodbc.connect(conn_str)

