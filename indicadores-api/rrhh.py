"""
Reclutamiento: personas que postularon por mes, desde Postgres schema
rag_system (tabla candidato) — ver db_pg.py para la conexión (mismo host/red
que Prisma, n8n_sql:5432/n8n).

Se cuentan PERSONAS, no CVs: una misma persona que mandó varios CVs (o que
postuló en meses distintos) figura una sola vez, en el mes de su primer
ingreso. La persona se identifica por email (normalizado); si no tiene, por
DNI; si no, por teléfono normalizado; si no, por id de candidato.
La ventana de meses se aplica DESPUÉS de resolver el primer ingreso, así quien
ya había postulado antes de la ventana no se recuenta como nuevo.
"""
from db_pg import get_pg_connection

_SQL_PERSONAS_POR_MES = """
    WITH k AS (
        SELECT
            created_at,
            COALESCE(
                lower(nullif(trim(email), '')),
                'dni:' || nullif(dni, ''),
                'tel:' || nullif(telefono_normalizado, ''),
                'id:'  || id
            ) AS clave
        FROM rag_system.candidato
    ),
    p AS (
        SELECT clave, MIN(created_at) AS primera
        FROM k
        GROUP BY clave
    )
    SELECT
        to_char(date_trunc('month', primera), 'YYYY-MM') AS mes,
        COUNT(*) AS cantidad
    FROM p
    WHERE primera >= date_trunc('month', now()) - (%s || ' months')::interval
    GROUP BY 1
    ORDER BY 1
"""


def fetch_cvs_por_mes(meses: int = 12) -> dict:
    """Personas únicas que postularon, agrupadas por mes de su primer ingreso,
    últimos `meses` meses (incluye el mes actual). El nombre de la función se
    mantiene por compatibilidad con main.py."""
    conn = get_pg_connection()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_PERSONAS_POR_MES, (meses,))
        rows = [{"mes": mes, "cantidad": cantidad} for mes, cantidad in cur.fetchall()]
    finally:
        conn.close()
    return {
        "meses": meses,
        "total": sum(r["cantidad"] for r in rows),
        "rows": rows,
    }
