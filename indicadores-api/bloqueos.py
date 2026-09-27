"""
Watchdog de bloqueos de Magnus — lectura de estado y acciones de la vista
/sistema/bloqueos.

Contexto: la base "se cuelga" cuando una sesión del cliente de Magnus queda con
una transacción abierta (típicamente SERIALIZABLE, con un cursor API abierto en
una pantalla) y encadena decenas de sesiones detrás. El diagnóstico manual
—buscar la cabeza, mirar la cadena, ejecutar el KILL, anotar qué pasó— es lo
que este módulo automatiza.

Quién hace qué:
  · `vicki.sp_bloqueos_detectar` (job de SQL Agent, cada 20 s) detecta y
    REGISTRA, y si alguna víctima lleva AUTO_KILL_SEG (2 min) esperando mata
    solo a la cabeza (accion_usuario = 'Watchdog (automático)'). No mata si
    un ADMIN apretó "Dejar" ni lo que figure en vicki.bloqueo_excepcion.
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
# Espera (de la peor víctima) a partir de la cual el SP mata solo a la cabeza.
AUTO_KILL_SEG = 120


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
SELECT  v.spid, v.bloqueados, v.espera_max_seg, v.espera_otros_seg, v.login, v.host, v.programa,
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
        SUM(CASE WHEN estado = 'MATADO' AND accion_usuario LIKE 'Watchdog%'
                 THEN 1 ELSE 0 END)                                AS automaticos,
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


# Interruptor del KILL automático (vicki.bloqueo_config). Si la tabla todavía
# no existe (falta re-correr el .sql) se informa como activo: es lo que hace el SP.
_SQL_CONFIG = """
IF OBJECT_ID('vicki.bloqueo_config') IS NULL
    SELECT CAST(1 AS bit) AS auto_kill, CAST(NULL AS nvarchar(120)) AS actualizado_por,
           CAST(NULL AS datetime2(0)) AS actualizado_en, CAST(0 AS bit) AS configurable
ELSE
    SELECT ISNULL(MAX(CAST(auto_kill AS int)), 1) AS auto_kill,
           MAX(actualizado_por) AS actualizado_por, MAX(actualizado_en) AS actualizado_en,
           CAST(1 AS bit) AS configurable
    FROM vicki.bloqueo_config WHERE id = 1
"""


def _config(cur) -> dict:
    cur.execute(_SQL_CONFIG)
    r = _limpiar(_filas(cur))[0]
    return {
        "activo": bool(r["auto_kill"]),
        "configurable": bool(r["configurable"]),
        "actualizado_por": r["actualizado_por"],
        "actualizado_en": r["actualizado_en"],
    }


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
                "umbral": {"bloqueados": MIN_BLOQUEADOS, "espera_seg": MIN_ESPERA_SEG,
                           "auto_kill_seg": AUTO_KILL_SEG},
                "cabezas": [],
            }
        if detectar:
            try:
                cur.execute(
                    "EXEC vicki.sp_bloqueos_detectar @min_bloqueados = ?, "
                    "@min_espera_seg = ?, @auto_kill_seg = ?",
                    MIN_BLOQUEADOS, MIN_ESPERA_SEG, AUTO_KILL_SEG,
                )
                while cur.nextset():
                    pass
            except Exception as e:  # nunca romper la vista por esto
                print(f"[bloqueos] sp_bloqueos_detectar: {e}")

        try:
            auto_kill = _config(cur)
        except Exception as e:
            print(f"[bloqueos] config: {e}")
            auto_kill = {"activo": True, "configurable": False,
                         "actualizado_por": None, "actualizado_en": None}

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
        "umbral": {"bloqueados": MIN_BLOQUEADOS, "espera_seg": MIN_ESPERA_SEG,
                   "auto_kill_seg": AUTO_KILL_SEG if auto_kill["activo"] else 0},
        "auto_kill": auto_kill,
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


def set_auto_kill(activo: bool, usuario: str) -> dict:
    """Prende/apaga el KILL automático. Apagado, el watchdog sigue detectando
    y registrando episodios; el KILL manual sigue disponible."""
    return _accion(
        "EXEC vicki.sp_bloqueos_auto_kill @activo = ?, @usuario = ?",
        1 if activo else 0, usuario or "desconocido",
    )


# ── Lentitud, timeouts, errores y deadlocks ────────────────────────────────
# Sesión XE `vicki_lentitud` → vicki.sp_lentitud_ingerir (paso 2 del job del
# watchdog, cada 20 s) → vicki.lentitud_evento. Los bloqueos salen de
# vicki.bloqueo_episodio y se suman a la línea de tiempo como tipo BLOQUEO.
# Ver sql/magnus_watchdog_bloqueos.sql (sección REGISTRO DE LENTITUD).

TIPOS_LENTITUD = ("LENTA", "CANCELADA", "ERROR", "DEADLOCK", "BLOQUEO")

# Una LENTA es "PESADA" (mala consulta: lee mucho o quema CPU) o "ESPERANDO"
# (tardó por otra cosa: bloqueo, disco, red, el cliente leyendo despacio).
LECTURAS_PESADA = 500_000   # ~4 GB de páginas leídas

_SQL_LENT_INSTALADO = """
SELECT CASE WHEN OBJECT_ID('vicki.lentitud_evento') IS NULL THEN 0 ELSE 1 END AS tabla,
       CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = N'vicki_lentitud')
            THEN 1 ELSE 0 END AS sesion
"""

_SQL_LENT_LECTOR = "SELECT leido_en FROM vicki.lentitud_lector WHERE id = 1"

_SQL_LENT_RESUMEN = """
SELECT tipo, COUNT(*) AS n
FROM   vicki.lentitud_evento
WHERE  ocurrido_en >= DATEADD(DAY, -?, SYSDATETIME())
GROUP BY tipo
UNION ALL
SELECT 'BLOQUEO', COUNT(*)
FROM   vicki.bloqueo_episodio
WHERE  detectado_en >= DATEADD(DAY, -?, SYSDATETIME())
"""

_SQL_LENT_EVENTOS = """
SELECT  le.id, le.ocurrido_en AS cuando, le.tipo, le.base, le.host, le.programa,
        le.duracion_ms, le.cpu_ms, le.lecturas, le.lecturas_fisicas, le.filas,
        le.objeto, LEFT(le.sql_texto, 1500) AS sql_texto,
        le.error_numero, le.severidad, le.mensaje,
        CASE WHEN le.tipo = 'LENTA' THEN
             CASE WHEN le.lecturas >= {pesada} OR le.cpu_ms * 2 >= le.duracion_ms
                  THEN 'PESADA' ELSE 'ESPERANDO' END END AS causa
FROM    vicki.lentitud_evento le
WHERE   le.ocurrido_en >= DATEADD(DAY, -?, SYSDATETIME()) {filtro}
"""

_SQL_LENT_EPISODIOS = """
SELECT  -e.id AS id, e.detectado_en AS cuando, 'BLOQUEO' AS tipo, CAST(NULL AS nvarchar(128)) AS base,
        e.host_cabeza AS host, e.programa_cabeza AS programa,
        DATEDIFF(SECOND, e.detectado_en, ISNULL(e.cerrado_en, e.ultima_vista)) * 1000 AS duracion_ms,
        CAST(NULL AS int) AS cpu_ms, CAST(NULL AS bigint) AS lecturas,
        CAST(NULL AS bigint) AS lecturas_fisicas, CAST(NULL AS bigint) AS filas,
        CAST(NULL AS nvarchar(256)) AS objeto, LEFT(e.ultimo_sql, 1500) AS sql_texto,
        CAST(NULL AS int) AS error_numero, CAST(NULL AS tinyint) AS severidad,
        CONCAT(N'Frenó a ', e.bloqueados_max, N' sesiones · ', e.estado,
               CASE WHEN e.accion_usuario IS NOT NULL THEN N' · ' + e.accion_usuario END) AS mensaje,
        CAST(NULL AS varchar(10)) AS causa
FROM    vicki.bloqueo_episodio e
WHERE   e.detectado_en >= DATEADD(DAY, -?, SYSDATETIME())
"""

# Consultas que más tiempo le costaron a la base: misma consulta (query_hash)
# con cualquier parámetro. Sin hash (cursores API de Magnus) agrupa por texto.
_SQL_LENT_TOP = """
SELECT TOP 20
       CAST(COALESCE(NULLIF(query_hash, 0), CHECKSUM(LEFT(sql_texto, 400))) AS varchar(30)) AS clave,
       COUNT(*)                         AS veces,
       SUM(CAST(duracion_ms AS bigint)) / 1000 AS total_seg,
       AVG(CAST(duracion_ms AS bigint)) AS prom_ms,
       MAX(duracion_ms)                 AS max_ms,
       AVG(lecturas)                    AS lecturas_prom,
       AVG(CAST(cpu_ms AS bigint))      AS cpu_prom_ms,
       COUNT(DISTINCT host)             AS equipos,
       MAX(ocurrido_en)                 AS ultima,
       MAX(base)                        AS base,
       MAX(objeto)                      AS objeto,
       MAX(LEFT(sql_texto, 1500))       AS sql_texto,
       SUM(CASE WHEN lecturas >= {pesada} OR cpu_ms * 2 >= duracion_ms THEN 1 ELSE 0 END) AS pesadas
FROM   vicki.lentitud_evento
WHERE  tipo = 'LENTA' AND ocurrido_en >= DATEADD(DAY, -?, SYSDATETIME())
GROUP BY COALESCE(NULLIF(query_hash, 0), CHECKSUM(LEFT(sql_texto, 400)))
ORDER BY SUM(CAST(duracion_ms AS bigint)) DESC
""".replace("{pesada}", str(LECTURAS_PESADA))

# Lo que está corriendo AHORA hace más de 5 s (no se guarda: es la foto).
_SQL_LENT_AHORA = """
SELECT TOP 30
       r.session_id AS spid, DB_NAME(r.database_id) AS base,
       s.host_name AS host, s.program_name AS programa,
       r.status AS estado, r.command AS comando,
       r.total_elapsed_time / 1000 AS seg, r.cpu_time AS cpu_ms,
       r.logical_reads AS lecturas, r.wait_type AS espera_tipo,
       r.blocking_session_id AS bloqueada_por,
       r.granted_query_memory * 8 AS memoria_kb,
       LEFT(SUBSTRING(t.text, (r.statement_start_offset / 2) + 1,
            CASE WHEN r.statement_end_offset = -1 THEN 4000
                 ELSE (r.statement_end_offset - r.statement_start_offset) / 2 + 1 END), 1500) AS sql_texto
FROM   sys.dm_exec_requests r
JOIN   sys.dm_exec_sessions s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE  s.is_user_process = 1
  AND  r.session_id <> @@SPID
  AND  r.total_elapsed_time >= 5000
  AND  r.command NOT IN ('WAITFOR', 'BROKER_RECEIVE_WAITFOR')
ORDER BY r.total_elapsed_time DESC
"""

FALTA_LENTITUD = (
    "Falta re-correr sql/magnus_watchdog_bloqueos.sql (python sql/aplicar_sql.py): "
    "crea la sesión vicki_lentitud y la tabla vicki.lentitud_evento."
)


def fetch_lentitud(dias: int = 7, tipo: str | None = None, limite: int = 200) -> dict:
    tipo = (tipo or "").upper() or None
    if tipo and tipo not in TIPOS_LENTITUD:
        raise ValueError(f"tipo inválido: {tipo}")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(_SQL_LENT_AHORA)
        ahora = _limpiar(_filas(cur))

        cur.execute(_SQL_LENT_INSTALADO)
        inst = _filas(cur)[0]
        if not inst["tabla"]:
            return {"dias": dias, "instalado": False, "mensaje": FALTA_LENTITUD,
                    "ahora": ahora, "resumen": {}, "eventos": [], "top": []}

        cur.execute(_SQL_LENT_LECTOR)
        lector = _filas(cur)

        cur.execute(_SQL_LENT_RESUMEN, dias, dias)
        resumen = {r["tipo"]: r["n"] for r in _filas(cur)}

        partes, params = [], []
        if tipo != "BLOQUEO":
            filtro = "AND le.tipo = ?" if tipo else ""
            partes.append(_SQL_LENT_EVENTOS.format(pesada=LECTURAS_PESADA, filtro=filtro))
            params += [dias] + ([tipo] if tipo else [])
        if tipo in (None, "BLOQUEO"):
            partes.append(_SQL_LENT_EPISODIOS)
            params.append(dias)
        sql = ("SELECT TOP (?) * FROM (" + "\nUNION ALL\n".join(partes)
               + ") u ORDER BY u.cuando DESC")
        cur.execute(sql, limite, *params)
        eventos = _limpiar(_filas(cur))

        cur.execute(_SQL_LENT_TOP, dias)
        top = _limpiar(_filas(cur))
    finally:
        conn.close()

    return {
        "dias": dias,
        "instalado": True,
        "sesion_activa": bool(inst["sesion"]),
        "leido_en": _iso(lector[0]["leido_en"]) if lector else None,
        "umbral": {"lenta_seg": 5, "cancelada_seg": 2, "lecturas_pesada": LECTURAS_PESADA},
        "ahora": ahora,
        "resumen": resumen,
        "eventos": eventos,
        "top": top,
    }
