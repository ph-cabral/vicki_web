"""
Watchdog de bloqueos de Magnus — lectura de estado y acciones de la vista
/sistema/bloqueos.

Contexto: la base "se cuelga" cuando una sesión del cliente de Magnus queda con
una transacción abierta (típicamente SERIALIZABLE, con un cursor API abierto en
una pantalla) y encadena decenas de sesiones detrás. El diagnóstico manual
—buscar la cabeza, mirar la cadena, ejecutar el KILL, anotar qué pasó— es lo
que este módulo automatiza.

Quién hace qué:
  · `vicki.sp_bloqueos_detectar` (job de SQL Agent, cada minuto) detecta y
    REGISTRA. Nunca mata.
  · Este módulo lee el estado y, cuando alguien aprieta el botón, llama a
    `vicki.sp_bloqueos_matar` / `vicki.sp_bloqueos_dejar`.
  · El KILL vive en el SP y no acá: así lo único que puede matarse es una
    sesión ya identificada como cabeza de un episodio abierto, y queda
    auditado quién lo pidió.

Ver ever/sql/magnus_watchdog_bloqueos.sql para el esquema y el job.

EXCEPCIÓN a la regla de db.py ("esta API sólo lee Magnus"): los tres SP de
arriba escriben en el schema `vicki` de EVERWEAR (tablas propias, ninguna tabla
del ERP). Por eso las conexiones de este módulo van con autocommit — sin él el
KILL falla, porque no puede ejecutarse dentro de una transacción.
"""
import json
from datetime import datetime

from db import get_connection

BASE = "EVERWEAR"

# Umbrales de lo que se considera "episodio". Mismos defaults que el job.
MIN_BLOQUEADOS = 3
MIN_ESPERA_SEG = 20


def _conn():
    """Conexión con autocommit: los SP escriben y el KILL no admite transacción."""
    conn = get_connection(BASE)
    conn.autocommit = True
    return conn


def _filas(cur) -> list[dict]:
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _iso(v):
    return v.isoformat(sep=" ", timespec="seconds") if isinstance(v, datetime) else v


def _limpiar(filas: list[dict], json_cols: tuple[str, ...] = ()) -> list[dict]:
    out = []
    for f in filas:
        d = {}
        for k, v in f.items():
            if k in json_cols:
                try:
                    d[k] = json.loads(v) if v else []
                except (TypeError, ValueError):
                    d[k] = []
            else:
                d[k] = _iso(v)
        out.append(d)
    return out


_SQL_VIVO = """
SELECT  v.spid, v.bloqueados, v.espera_max_seg, v.login, v.host, v.programa,
        v.estado_sesion, v.transacciones_abiertas, v.aislamiento,
        v.ultimo_pedido_inicio, v.ultimo_pedido_fin,
        e.id AS episodio_id, e.detectado_en, e.tran_desde, e.ultimo_sql,
        e.objetos, e.accion, e.accion_usuario, e.muestras
FROM    vicki.v_bloqueo_vivo v
LEFT JOIN vicki.bloqueo_episodio e
       ON e.spid_cabeza = v.spid AND e.estado = 'ABIERTO'
ORDER BY v.bloqueados DESC
"""

# La cadena se arma con la vista, no con la última muestra: así lo que se ve en
# pantalla es el estado de este segundo, no el de la última corrida del job.
_SQL_CADENA = """
SELECT  b.cabeza, b.victima AS spid, b.wait_ms / 1000 AS espera_seg,
        b.wait_type AS espera_tipo, b.nivel, b.recurso,
        s.host_name AS host, s.login_name AS login, s.program_name AS programa,
        SUBSTRING(t.text, 1, 300) AS comando
FROM    vicki.v_bloqueo_cadena b
LEFT JOIN sys.dm_exec_sessions s ON s.session_id = b.victima
OUTER APPLY (
    SELECT TOP 1 tx.text
    FROM   sys.dm_exec_connections c
    CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) tx
    WHERE  c.session_id = b.victima
) t
ORDER BY b.wait_ms DESC
"""

_SQL_HISTORIAL = """
SELECT TOP (?)
       e.id, e.detectado_en, e.cerrado_en, e.ultima_vista,
       DATEDIFF(SECOND, e.detectado_en, ISNULL(e.cerrado_en, e.ultima_vista)) AS duracion_seg,
       e.spid_cabeza, e.host_cabeza, e.login_cabeza, e.programa_cabeza,
       e.aislamiento, e.tran_desde, e.bloqueados_max, e.espera_max_seg,
       e.muestras, e.estado, e.accion, e.accion_usuario, e.accion_en,
       e.accion_detalle, e.objetos, e.ultimo_sql
FROM   vicki.bloqueo_episodio e
WHERE  e.detectado_en >= DATEADD(DAY, -?, SYSDATETIME())
ORDER BY e.id DESC
"""

_SQL_RESUMEN = """
SELECT  COUNT(*)                                                   AS episodios,
        SUM(CASE WHEN estado = 'MATADO' THEN 1 ELSE 0 END)         AS matados,
        SUM(CASE WHEN estado = 'RESUELTO_SOLO' THEN 1 ELSE 0 END)  AS solos,
        ISNULL(MAX(bloqueados_max), 0)                             AS peor_bloqueados,
        ISNULL(MAX(espera_max_seg), 0)                             AS peor_espera_seg
FROM    vicki.bloqueo_episodio
WHERE   detectado_en >= DATEADD(DAY, -?, SYSDATETIME())
"""


_SQL_INSTALADO = """
SELECT CASE WHEN OBJECT_ID('vicki.v_bloqueo_vivo')      IS NULL
             OR OBJECT_ID('vicki.sp_bloqueos_detectar') IS NULL
             OR OBJECT_ID('vicki.bloqueo_episodio')     IS NULL
            THEN 0 ELSE 1 END AS instalado
"""

FALTA_INSTALAR = (
    "Falta correr sql/magnus_watchdog_bloqueos.sql en SRV-SQL2 (como sa, en la "
    "base EVERWEAR): el schema vicki todavía no existe."
)


def _instalado(cur) -> bool:
    """El schema vicki se crea corriendo el .sql una vez. Chequearlo cuesta una
    lectura de metadata y evita que la vista muera con un 503 ilegible."""
    cur.execute(_SQL_INSTALADO)
    return bool(cur.fetchone()[0])


def fetch_estado(detectar: bool = True) -> dict:
    """Foto de ahora: cabezas que están bloqueando, su cadena y el episodio
    abierto de cada una.

    `detectar=True` corre el SP de detección antes de leer (cuesta ~ms y sale
    de DMVs en memoria). Sirve para que la vista no tenga que esperar hasta un
    minuto a que el job abra el episodio y habilite el botón de matar."""
    conn = _conn()
    try:
        cur = conn.cursor()
        if not _instalado(cur):
            return {
                "ahora": datetime.now().isoformat(sep=" ", timespec="seconds"),
                "instalado": False,
                "mensaje": FALTA_INSTALAR,
                "hay_bloqueo": False,
                "bloqueados_total": 0,
                "umbral": {"bloqueados": MIN_BLOQUEADOS, "espera_seg": MIN_ESPERA_SEG},
                "cabezas": [],
            }
        if detectar:
            try:
                cur.execute(
                    "EXEC vicki.sp_bloqueos_detectar @min_bloqueados = ?, @min_espera_seg = ?",
                    MIN_BLOQUEADOS, MIN_ESPERA_SEG,
                )
                while cur.nextset():
                    pass
            except Exception as e:  # nunca romper la vista por esto
                print(f"[bloqueos] sp_bloqueos_detectar: {e}")

        cur.execute(_SQL_VIVO)
        cabezas = _limpiar(_filas(cur), json_cols=("objetos",))

        cadena = []
        if cabezas:
            cur.execute(_SQL_CADENA)
            cadena = _limpiar(_filas(cur))
    finally:
        conn.close()

    por_cabeza: dict[int, list[dict]] = {}
    for v in cadena:
        por_cabeza.setdefault(v["cabeza"], []).append(v)

    for c in cabezas:
        c["victimas"] = por_cabeza.get(c["spid"], [])
        c["accionable"] = c["episodio_id"] is not None
        c["califica"] = (
            c["bloqueados"] >= MIN_BLOQUEADOS and c["espera_max_seg"] >= MIN_ESPERA_SEG
        )

    return {
        "ahora": datetime.now().isoformat(sep=" ", timespec="seconds"),
        "instalado": True,
        "hay_bloqueo": bool(cabezas),
        "bloqueados_total": sum(c["bloqueados"] for c in cabezas),
        "umbral": {"bloqueados": MIN_BLOQUEADOS, "espera_seg": MIN_ESPERA_SEG},
        "cabezas": cabezas,
    }


def fetch_historial(dias: int = 30, limite: int = 100) -> dict:
    conn = _conn()
    try:
        cur = conn.cursor()
        if not _instalado(cur):
            return {"dias": dias, "instalado": False, "mensaje": FALTA_INSTALAR,
                    "resumen": {}, "episodios": []}
        cur.execute(_SQL_HISTORIAL, limite, dias)
        episodios = _limpiar(_filas(cur), json_cols=("objetos",))
        cur.execute(_SQL_RESUMEN, dias)
        resumen = _limpiar(_filas(cur))
    finally:
        conn.close()
    return {
        "dias": dias,
        "instalado": True,
        "resumen": resumen[0] if resumen else {},
        "episodios": episodios,
    }


def fetch_episodio(episodio_id: int) -> dict:
    """Detalle de un episodio cerrado: cabecera + evolución minuto a minuto."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT e.*, DATEDIFF(SECOND, e.detectado_en,
                                 ISNULL(e.cerrado_en, e.ultima_vista)) AS duracion_seg
            FROM   vicki.bloqueo_episodio e WHERE e.id = ?
            """,
            episodio_id,
        )
        cab = _limpiar(_filas(cur), json_cols=("objetos",))
        if not cab:
            raise ValueError(f"No existe el episodio {episodio_id}")

        cur.execute(
            """
            SELECT TOP 200 tomada_en, bloqueados, espera_max_seg, cadena
            FROM   vicki.bloqueo_muestra
            WHERE  episodio_id = ? ORDER BY tomada_en
            """,
            episodio_id,
        )
        muestras = _limpiar(_filas(cur), json_cols=("cadena",))
    finally:
        conn.close()
    return {"episodio": cab[0], "muestras": muestras}


def _accion(sp: str, *args) -> dict:
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(sp, *args)
        filas = _filas(cur)
    finally:
        conn.close()
    if not filas:
        return {"ok": False, "mensaje": "Sin respuesta del servidor"}
    r = filas[0]
    return {"ok": bool(r.get("ok")), "mensaje": r.get("mensaje")}


def matar(episodio_id: int, usuario: str) -> dict:
    """KILL de la cabeza del episodio. El SP revalida que siga bloqueando."""
    return _accion(
        "EXEC vicki.sp_bloqueos_matar @episodio_id = ?, @usuario = ?",
        episodio_id, usuario or "desconocido",
    )


def dejar(episodio_id: int, usuario: str, motivo: str | None = None) -> dict:
    """Se decide esperar: el watchdog lo sigue midiendo y lo cierra cuando
    se destrabe, con el nombre de quien tomó la decisión."""
    return _accion(
        "EXEC vicki.sp_bloqueos_dejar @episodio_id = ?, @usuario = ?, @motivo = ?",
        episodio_id, usuario or "desconocido", motivo,
    )
