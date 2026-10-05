#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Errores Mesa de Control - widget de escritorio para Windows (puerto a Python
del errores-mesa.ps1 original, 2026-07-31 - "hacerlo con
python no powershell, convertirlo a exe"). Mismo comportamiento y look que
el .ps1: cuadro flotante sin bordes, esquina inferior derecha, 2 pantallas.

Pantalla 1 ("operario"): pide el N de operario 1 sola vez por sesion
  (GET /api/deposito/errores-mesa/operario?nro=N).

Pantalla 2 ("main"): cuadro grande con cliente/pedido/ubicacion + icono
  "reasignar" (POST /api/deposito/errores-mesa/asignar - SIEMPRE se puede
  apretar: si el pedido que ya tenia el operario sigue Abierto en Magnus, el
  server devuelve ESE MISMO, ver control_asignacion.py "UN PEDIDO POR
  OPERARIO A LA VEZ" 2026-07-31 - no es un reclamo nuevo) + pildora
  "Articulos" y pildora "Finalizar".

  - Clic izquierdo (franja superior) : arrastrar el widget
  - Clic izquierdo (icono reasignar) : pedir/reconfirmar el pedido asignado
  - Clic izquierdo (Articulos)       : abre el selector de articulos (lista
                                        con scroll, 10 visibles por vez)
  - Clic en un articulo del selector : abre el menu de Detalle Error PARA
                                        ESE articulo (1 error por articulo,
                                        no 1 error para todo el pedido)
  - Clic izquierdo (Finalizar)       : guarda en lote (1 fila por articulo
                                        con error elegido)
  - Clic derecho                     : menu (Cambiar operario / Recargar
                                        opciones / Iniciar con Windows / Salir)

Empaquetar con build.bat (PyInstaller --onefile --noconsole) ->
dist/ErroresMesa.exe. Ese .exe es autocontenido: se copia a cualquier PC
Windows y corre sin instalar nada (mismo patron que autoelevador.py /
facturacion_mini.py en esta carpeta).

Diferencias respecto al .ps1 original (documentadas para no generar
sorpresas):
  - Se agrego persistencia de "Iniciar con Windows" (registro HKCU\\...\\Run)
    con checkbox en el menu, igual que el resto de los widgets Python de esta
    carpeta. El .ps1 no lo tenia (se auto-iniciaba via acceso directo manual
    en la carpeta de Inicio de Windows).
  - El truncado con "..." de textos muy largos (StringTrimming.EllipsisWord
    en GDI+) no tiene equivalente directo en tkinter; en su lugar el texto
    se recorta con "…" a ancho fijo (ver _truncate) para que cada fila del
    selector de Articulos mida siempre lo mismo (necesario para el scroll
    de a 10, ver REDISEÑO 2026-08-19 abajo).

REDISEÑO 2026-08-19 ("la lista de articulos se extiende
sin fin, que sea de a 10 y despues scroll" + "que se pueda elegir un error
POR articulo, no un error general"):
  - El selector de Articulos (open_articulos_menu) ahora es un Canvas con
    Scrollbar en vez de un Frame que crecia sin limite: se ve como maximo
    VISIBLE_ROWS filas (10) y el resto se scrollea (rueda del mouse o barra).
    Antes, con pedidos de 20+ articulos, el popup se salia de la pantalla.
  - Se saco la pildora global "Error" (single-choice para TODO el pedido) y
    el error se elige ARTICULO POR ARTICULO: click en una fila del selector
    abre un menu con las mismas opciones de detalleError, pero el resultado
    se guarda en self.articulos_errores = {codArticulo: detalleError} en vez
    de un self.selected_error unico. La fila marcada muestra el error
    elegido al lado, en verde.
  - La pildora que antes decia "Error" ahora dice "Finalizar" (mismo rect
    PILL_ERROR, mismo lugar - no cambia el layout/geometria del widget) y
    dispara el guardado en lote: POST /api/deposito/errores-mesa/items con
    {nroPedido, nroOperario, items:[{codArticulo, detalleError}, ...]} - ver
    insert_error_mesa_items / ErrorMesaItemsIn en indicadores-api (ese
    endpoint YA fue agregado el 2026-08-04 previendo este cambio del widget;
    no hizo falta tocar el server). El guardado dejo de ser automatico al
    elegir el ultimo dato (como antes) - ahora es una accion explicita
    (click en "Finalizar"), porque con "1 error por articulo" no hay un
    unico "ultimo campo" que dispare el guardado solo.
  - El endpoint viejo (POST /api/deposito/errores-mesa, 1 solo detalleError
    para todo el pedido) sigue vivo en el server para el widget de Calidad,
    pero este widget (Mesa de Control) ya no lo usa.

RESERVA POR CLIENTE (2026-09-23): todos los pedidos de un cliente los
controla el primero al que se le asigno uno (ver control_asignacion.py,
bloque "RESERVA POR CLIENTE"). Cuando el cliente tiene mas de una unidad
(pedidos y/o vueltas de acopio 70/75, con el gate CP1/CP2) aparece una BANDA
arriba del cuadro grande ("parte superior agrandada", GRUPO_H px; la ventana
crece hacia arriba y el borde de abajo queda fijo):
  - linea 1: cliente; linea 2: "Listos N/M · Prep. K"
  - si hay que decidir (1a unidad con otras en preparacion, o se sumo otra
    lista estando en espera): botones "Tomar" / "Esperar"
    (POST /api/deposito/errores-mesa/grupo/decision). Esperar devuelve el
    pedido a la cola RESERVADO para este operario y queda libre para otros
    clientes; Tomar se lo asigna ya (o despues del pedido actual).
  - Polling cada POLL_GRUPO_MS (GET /api/deposito/errores-mesa/grupo) en un
    hilo aparte: ademas mantiene viva la reserva (latido). Cuando aparece una
    decision nueva suena un bell. Si quedaron TODAS listas estando en espera y
    el widget esta libre, se asigna solo.

PREASIGNACION (2026-09-24): desde la web (Depósito → Mesas → Asignar pedidos)
se le puede elegir a un operario el proximo pedido a controlar. El polling de
/grupo trae "preasignadoListo" = ese pedido esta listo en la cola y lo que el
operario estaba controlando ya cerro en Magnus; el widget pide Asignar solo
(con un bell), salvo que tenga errores elegidos sin Finalizar o el menu de
articulos abierto. Un widget viejo igual lo recibe, pero al apretar el icono.

CAMBIO AUTOMATICO AL CERRAR (2026-10-05): /grupo trae "actual" = la unidad
asignada al operario y si ya cerro en Magnus. Cuando la unidad que el widget
estaba controlando (self._vigilado) aparece cerrada, el widget pide la
siguiente solo (bell + Asignar), aunque ya se haya hecho Finalizar. Si no hay
errores sin Finalizar ni el menu abierto lo hace al toque; si los hay, espera a
que se finalice. Si la cola esta vacia reintenta en cada polling durante
AUTO_SIGUIENTE_S (no se queda tomando pedidos un widget abandonado).
"""

import os
import sys
import re
import json
import math
import time
import traceback
import threading
import queue
import webbrowser
from urllib import request, error

import tkinter as tk
from tkinter import messagebox

# ----------------------------- CONFIG ---------------------------------------
API_BASE = "http://10.10.0.159:3001"   # ever (proxy a indicadores-api)
APP_NAME = "ErroresMesaControl"

FALLBACK_DETALLE = [
    "Error en cantidad",
    "Error en producto",
    "Producto no conforme",
    "Pedido incompleto",
    "Producto sin identificación",
    "Pedido no encontrado",
    "Error de mesa",
]

FORM_W = 250
STAGE1_H = 104   # solo ubicacion/estado + pildora de N Operario
STAGE2_H = 200   # widget completo: cuadro grande + pildoras Articulos/Finalizar
PLACEHOLDER_OPERARIO = "N° Operario"
IDLE_TEXT = "-"

# Selector de Articulos (REDISEÑO 2026-08-19): lista con scroll en vez de
# crecer sin fin - se ven ROW_H*VISIBLE_ROWS px y el resto se scrollea.
VISIBLE_ROWS = 10
ROW_H = 24
ROW_MAXLEN = 52   # recorte de "codigo + descripcion" (ver _truncate) para que
                   # cada fila mida siempre ROW_H, sin salto de linea.
                   # 2026-08-25: era 42 (solo descripcion); se amplio junto con
                   # ROW_WIDTH al anteponer el codigo de articulo.
ROW_WIDTH = 300   # ancho del canvas de la lista de articulos (era 228)

# Rects como (x0, y0, x1, y1), mismas coordenadas que el .ps1 original.
UBIC_BOX = (10, 6, 240, 46)          # stage "operario" (1 linea)
UBIC_BOX_MAIN = (10, 6, 240, 86)     # stage "main" (hasta 3 lineas)
PILL1 = (10, 50, 240, 92)            # input N Operario (solo stage "operario")
PILL_ARTICULOS = (10, 94, 240, 136)
PILL_ERROR = (10, 144, 240, 186)
REASIGNAR_ICON = (200, 10, 230, 40)  # esq. sup. derecha del cuadro grande
UBIC_DRAG = (0, 0, FORM_W, 50)       # franja de arrastre

C_MAGENTA = "#ff00ff"   # clave de transparencia
C_FILL = "#080808"
C_BORDER = "#ff8c1e"
C_GREEN = "#5ae682"
C_GRAY = "#96969c"
C_ERR = "#e5484d"
C_TXT = "#ffffff"
C_AMBER = "#ffc53d"

# Banda de grupo por cliente (RESERVA POR CLIENTE 2026-09-23): se suma ARRIBA
# del cuadro grande solo cuando el cliente tiene mas de una unidad. Todo el
# stage "main" se corre GRUPO_H px hacia abajo mientras la banda esta visible.
GRUPO_H = 80
GRUPO_BOX = (10, 6, 240, 76)
GRUPO_BTN_TOMAR = (16, 48, 121, 72)
GRUPO_BTN_ESPERAR = (129, 48, 234, 72)
GRUPO_BTN_TOMAR_ESPERA = (170, 50, 234, 72)   # "Tomar" chico estando en espera
POLL_GRUPO_MS = 20000
AUTO_SIGUIENTE_S = 600   # ventana de reintento del cambio automatico al cerrar
UPDATE_CHECK_MS = 120000  # cada cuanto se fija si hay codigo nuevo (solo con lanzador)
REINICIO_VALIDO_S = 120   # el estado guardado para el reinicio vence a los 2 min
# ----------------------------------------------------------------------------

# AUTO-ACTUALIZACION (2026-10-05): el .exe es lanzador.py, que baja este
# archivo desde vicki_web/public/widgets/errores_mesa.py y lo ejecuta con
# LANZADOR = {"sha", "url", "version"} en los globals. Con el widget libre y
# un sha distinto en el server, se guarda operario/posicion/pedido en
# config.json ("reinicio"), se pone _REINICIAR = True y se cierra la ventana:
# el lanzador vuelve a bajar y ejecutar el codigo nuevo en el mismo proceso.
# Corriendo el .py suelto (sin lanzador) no hace nada de esto.
_REINICIAR = False


def _lanzador():
    return globals().get("LANZADOR")
# ----------------------------------------------------------------------------


# ------------------------- utilidades de entorno ----------------------------
def exe_path():
    if getattr(sys, "frozen", False):
        return sys.executable
    return os.path.abspath(__file__)


def config_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, APP_NAME)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


CONFIG_PATH = os.path.join(config_dir(), "config.json")
LOG_PATH = os.path.join(config_dir(), "errores-mesa-widget.log")


def log(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except Exception:
        pass


def set_startup(enable):
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE)
        if enable:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, '"%s"' % exe_path())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


def enable_dpi_awareness():
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# ------------------------------- HTTP ----------------------------------------
class ApiError(Exception):
    """status_code = None si fue un error de conexion (no HTTP)."""
    def __init__(self, status_code, body_text):
        self.status_code = status_code
        self.body_text = body_text or ""
        super().__init__("HTTP %s: %s" % (status_code, self.body_text))


def _api_request(method, path, body=None, timeout=8):
    url = API_BASE + path
    data = None
    headers = {"User-Agent": APP_NAME}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, method=method, headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8") if raw else ""
            return json.loads(text) if text else None
    except error.HTTPError as e:
        raw = e.read()
        text = raw.decode("utf-8", errors="replace") if raw else ""
        raise ApiError(e.code, text)
    except error.URLError as e:
        raise ApiError(None, str(e.reason))
    except Exception as e:
        raise ApiError(None, str(e))


def api_get(path, timeout=8):
    return _api_request("GET", path, None, timeout)


def api_post(path, body, timeout=10):
    return _api_request("POST", path, body, timeout)


def get_error_message(raw_text):
    """Extrae el mensaje humano de un cuerpo de error JSON anidado
    ({"error":...,"detail":{"detail":"..."}}) - mismo criterio que
    Get-ErrorMessage en el .ps1 original."""
    if not raw_text:
        return raw_text
    try:
        obj = json.loads(raw_text)
    except (TypeError, ValueError):
        return raw_text
    for _ in range(5):
        if isinstance(obj, str):
            return obj
        if obj is None:
            break
        if isinstance(obj, dict) and "detail" in obj:
            obj = obj["detail"]
            continue
        if isinstance(obj, dict) and "error" in obj:
            obj = obj["error"]
            continue
        break
    if isinstance(obj, str):
        return obj
    return raw_text


def clean_ubicacion(raw):
    """Saca la frase fija que anota Deposito al derivar el pedido a Mesa de
    Control (ej. "0009 rojo - pasado a mesa de control -") - ruido aca, el
    widget YA ES la mesa de control."""
    if not raw:
        return raw
    clean = re.sub(r"pasado a mesa de control", "", raw, flags=re.IGNORECASE)
    clean = re.sub(r"\s*-\s*-\s*", " - ", clean)
    clean = clean.strip(" \t-")
    return clean


def rect_contains(rect, x, y):
    x0, y0, x1, y1 = rect
    return x0 <= x <= x1 and y0 <= y <= y1


def _truncate(text, maxlen=ROW_MAXLEN):
    text = text or ""
    if len(text) <= maxlen:
        return text
    return text[: maxlen - 1].rstrip() + "…"


# -------------------------------- Widget --------------------------------------
class ErroresMesaWidget:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=C_MAGENTA)
        try:
            self.root.attributes("-transparentcolor", C_MAGENTA)
        except Exception:
            pass

        self.cfg = load_config()
        if "startup" not in self.cfg:
            self.cfg["startup"] = True
            set_startup(True)
            save_config(self.cfg)
        else:
            set_startup(bool(self.cfg.get("startup")))

        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        self.screen_bottom = screen_h
        self.x = screen_w - FORM_W - 12
        # Borde inferior de la ventana: la banda de grupo agranda la ventana
        # hacia ARRIBA, asi que el alto se acomoda sin mover el borde de abajo
        # (y respeta donde la haya dejado el operario al arrastrarla).
        self.bottom = self.screen_bottom - 12
        # Estado guardado por un reinicio de auto-actualizacion (ver arriba).
        self._reinicio = self.cfg.pop("reinicio", None)
        if self._reinicio:
            save_config(self.cfg)
            if time.time() - float(self._reinicio.get("ts") or 0) > REINICIO_VALIDO_S:
                self._reinicio = None
        if self._reinicio:
            try:
                self.x = int(self._reinicio.get("x", self.x))
                self.bottom = int(self._reinicio.get("bottom", self.bottom))
            except Exception:
                pass
        self.cur_h = STAGE1_H
        self.root.geometry("%dx%d+%d+%d" % (FORM_W, STAGE1_H, self.x, self.bottom - STAGE1_H))

        # --- estado (mismos nombres/roles que las variables $script: del .ps1) ---
        self.stage = "operario"          # "operario" -> "main"
        self.operario_nro = None
        self.operario_nombre = None
        self.error_label_text = "Finalizar"   # pildora PILL_ERROR (ver REDISEÑO 2026-08-19)
        self.articulos_disponibles = []      # [{codArticulo, descripcion}, ...]
        self.articulos_errores = {}          # {codArticulo: detalleError} - 1 error POR articulo
        self.articulos_label_text = "Artículos"
        self.ubic_text = IDLE_TEXT
        self.ubic_color = C_GRAY
        self.pedido_valido = False
        self.pedido_asignado = None
        self.remito_asignado = None
        self.asignando = False
        self.detalle_error_opciones = list(FALLBACK_DETALLE)

        # Reserva por cliente (2026-09-23)
        self.cod_cliente_asignado = None
        self.grupos = []              # lo ultimo que devolvio el server
        self.grupo = None             # el que se muestra en la banda
        self.grupo_msg = None         # texto temporal de la 3a linea
        self.decidiendo = False
        self._ofertas_vistas = set()  # (codCliente, listos) ya avisadas con bell
        self._poll_q = queue.Queue()
        self._poll_en_curso = False
        self._poll_after_id = None
        # Cambio automatico al cerrar (2026-10-05)
        self._vigilado = None         # (nroPedido, nroRemito) que se esta controlando
        self._auto_hasta = 0.0        # time.time() hasta el que se pide la siguiente sola
        self._auto_bell = False

        self._press = None
        self._dragging = False
        self._moved = False
        self._welcome_after_id = None
        self._reset_after_id = None
        # ANTI-DOBLE-CLICK (2026-09-24): True desde que se manda el lote
        # hasta el reset (o hasta que falla). Los clicks que Tk encola
        # mientras el POST bloquea la UI se descartan en try_guardar.
        self._guardando = False
        self.articulos_popup = None
        self._articulos_canvas = None     # canvas con scroll del selector abierto (o None)
        self._articulos_rows = {}         # {codArticulo: (row_frame, label)} del selector abierto

        self.canvas = tk.Canvas(self.root, width=FORM_W, height=STAGE1_H,
                                 bg=C_MAGENTA, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)

        # Entry superpuesto sobre PILL1 - solo visible/usable en stage "operario".
        self.txt_nro = tk.Entry(self.root, bd=0, bg=C_FILL, fg=C_GRAY,
                                 insertbackground=C_TXT, font=("Segoe UI", 11))
        self.txt_nro.insert(0, PLACEHOLDER_OPERARIO)
        self.txt_nro.place(x=PILL1[0] + 38, y=PILL1[1] + 8,
                            width=(PILL1[2] - PILL1[0]) - 48, height=26)
        self.txt_nro.bind("<FocusIn>", self._on_nro_focus_in)
        self.txt_nro.bind("<FocusOut>", self._on_nro_focus_out)
        self.txt_nro.bind("<Return>", self._on_nro_enter)

        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<ButtonPress-3>", self.on_right_click)

        self.menu_ctx = tk.Menu(self.root, tearoff=0, bg=C_FILL, fg=C_TXT,
                                 activebackground=C_BORDER, activeforeground=C_TXT)
        self.menu_ctx.add_command(label="Cambiar operario", command=self.switch_to_operario)
        self.menu_ctx.add_command(label="Recargar opciones", command=self.load_opciones)
        self.startup_var = tk.BooleanVar(value=bool(self.cfg.get("startup", True)))
        self.menu_ctx.add_checkbutton(label="Iniciar con Windows",
                                       variable=self.startup_var, command=self.toggle_startup)
        self.menu_ctx.add_separator()
        self.menu_ctx.add_command(label="Salir", command=self.quit)

        self.load_opciones()
        self.redraw()
        self.root.after(400, self._drain_poll)

        # Auto-actualizacion
        self._update_q = queue.Queue()
        self._update_pendiente = False
        if _lanzador():
            self.root.after(UPDATE_CHECK_MS, self._check_update)
        if self._reinicio and self._reinicio.get("operario"):
            self.root.after(200, self._restaurar_reinicio)

    # ------------------------- auto-actualizacion ---------------------------
    def _restaurar_reinicio(self):
        r, self._reinicio = self._reinicio, None
        self.txt_nro.delete(0, "end")
        self.txt_nro.insert(0, str(r["operario"]))
        self.txt_nro.config(fg=C_TXT)
        self.fetch_operario()
        if self.stage == "main" and r.get("pedido"):
            # despues del "Hola" de switch_to_main (1600 ms); el server
            # devuelve el MISMO pedido si sigue abierto.
            self.root.after(2000, self.fetch_asignar)

    def _check_update(self):
        lz = _lanzador()
        if not lz:
            return
        self.root.after(UPDATE_CHECK_MS, self._check_update)
        if self._update_pendiente:
            return

        def worker():
            try:
                import hashlib
                req = request.Request(lz["url"] + "?t=%d" % int(time.time()),
                                      headers={"User-Agent": APP_NAME, "Cache-Control": "no-cache"})
                with request.urlopen(req, timeout=10) as resp:
                    b = resp.read()
                compile(b.decode("utf-8"), "errores_mesa.py", "exec")
                if b and hashlib.sha256(b).hexdigest() != lz.get("sha"):
                    self._update_q.put(True)
            except Exception as e:
                log("Check-Update: %s" % e)

        threading.Thread(target=worker, daemon=True).start()

    def _libre_para_reiniciar(self):
        return not (self.asignando or self.decidiendo or self._guardando
                    or self.articulos_errores or self.articulos_popup is not None
                    or self._press is not None)

    def _intentar_reinicio(self):
        try:
            while True:
                self._update_q.get_nowait()
                self._update_pendiente = True
        except queue.Empty:
            pass
        if not self._update_pendiente or not self._libre_para_reiniciar():
            return
        global _REINICIAR
        log("Codigo nuevo en el server: reinicio")
        self.cfg["reinicio"] = {
            "ts": time.time(), "x": self.x, "bottom": self.bottom,
            "operario": self.operario_nro if self.stage == "main" else None,
            "pedido": bool(self.pedido_asignado),
        }
        save_config(self.cfg)
        _REINICIAR = True
        self.quit()

    # --------------------------- menu contextual -----------------------------
    def toggle_startup(self):
        val = bool(self.startup_var.get())
        set_startup(val)
        self.cfg["startup"] = val
        save_config(self.cfg)

    def on_right_click(self, e):
        try:
            self.menu_ctx.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu_ctx.grab_release()

    def quit(self):
        try:
            self.root.destroy()
        except Exception:
            pass

    # ------------------------------ dibujo ------------------------------------
    def set_ubic(self, text, color):
        self.ubic_text = text
        self.ubic_color = color
        self.redraw()

    def _round_pill(self, x0, y0, x1, y1, radius, fill, outline=""):
        r = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
        pts = [
            x0 + r, y0,   x1 - r, y0,   x1, y0,
            x1, y0 + r,   x1, y1 - r,   x1, y1,
            x1 - r, y1,   x0 + r, y1,   x0, y1,
            x0, y1 - r,   x0, y0 + r,   x0, y0,
        ]
        kw = {"fill": fill, "smooth": True}
        if outline:
            kw["outline"] = outline
            kw["width"] = 3
        else:
            kw["outline"] = fill
        self.canvas.create_polygon(*pts, **kw)

    def _draw_reasignar_icon(self, rect):
        x0, y0, x1, y1 = rect
        pad = 5
        bx0, by0, bx1, by1 = x0 + pad, y0 + pad, x1 - pad, y1 - pad
        self.canvas.create_arc(bx0, by0, bx1, by1, start=20, extent=140,
                                style="arc", outline=C_TXT, width=2)
        self.canvas.create_arc(bx0, by0, bx1, by1, start=200, extent=140,
                                style="arc", outline=C_TXT, width=2)
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        r = (bx1 - bx0) / 2
        for ang in (160, 340):
            rad = math.radians(ang)
            px, py = cx + r * math.cos(rad), cy - r * math.sin(rad)
            tx, ty = math.sin(rad), math.cos(rad)
            nx, ny = -ty, tx
            tip = (px + tx * 6, py - ty * 6)
            base_a = (px - nx * 4, py + ny * 4)
            base_b = (px + nx * 4, py - ny * 4)
            self.canvas.create_polygon(tip[0], tip[1], base_a[0], base_a[1],
                                        base_b[0], base_b[1], fill=C_TXT, outline=C_TXT)

    # ---- banda de grupo (RESERVA POR CLIENTE) ----
    def _banda_visible(self):
        return self.stage == "main" and self.grupo is not None

    def _off(self):
        return GRUPO_H if self._banda_visible() else 0

    def _o(self, rect):
        """Rect del stage "main" corrido hacia abajo si la banda esta visible."""
        d = self._off()
        return (rect[0], rect[1] + d, rect[2], rect[3] + d)

    def _draw_banda(self):
        g = self.grupo
        oferta = bool(g.get("oferta"))
        self._round_pill(*GRUPO_BOX, radius=14, fill=C_FILL,
                         outline=(C_AMBER if oferta else C_GRAY))
        cx = (GRUPO_BOX[0] + GRUPO_BOX[2]) / 2
        cod = g.get("codCliente")
        nombre = (g.get("cliente") or "Cliente").strip()
        extra = len(self.grupos) - 1
        nombre = _truncate(nombre, 18)
        linea1 = "%s #%s" % (nombre, cod) if cod is not None else nombre
        if extra > 0:
            linea1 += "  (+%d)" % extra
        self.canvas.create_text(cx, GRUPO_BOX[1] + 13, text=linea1, fill=C_TXT,
                                font=("Segoe UI", 9, "bold"))
        total = int(g.get("total") or 0)
        listos = int(g.get("listos") or 0) + int(g.get("asignados") or 0)
        prep = int(g.get("enPreparacion") or 0)
        linea2 = "Listos %d/%d" % (listos, total)
        if prep:
            linea2 += "  ·  Prep. %d" % prep
        self.canvas.create_text(cx, GRUPO_BOX[1] + 30, text=linea2,
                                fill=(C_AMBER if oferta else C_GREEN),
                                font=("Segoe UI", 9, "bold"))
        if oferta and not self.decidiendo:
            for rect, txt, col in ((GRUPO_BTN_TOMAR, "Tomar", C_GREEN),
                                   (GRUPO_BTN_ESPERAR, "Esperar", C_AMBER)):
                self._round_pill(*rect, radius=(rect[3] - rect[1]) / 2, fill=C_FILL, outline=col)
                self.canvas.create_text((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2,
                                        text=txt, fill=col, font=("Segoe UI", 9, "bold"))
        elif self._espera_con_tomar():
            # En espera sin novedad: puede arrepentirse y tomarlo igual.
            self.canvas.create_text(GRUPO_BOX[0] + 10, GRUPO_BOX[1] + 55,
                                    text=self.grupo_msg or "En espera · te aviso",
                                    anchor="w", fill=C_GRAY, font=("Segoe UI", 8))
            r = GRUPO_BTN_TOMAR_ESPERA
            self._round_pill(*r, radius=(r[3] - r[1]) / 2, fill=C_FILL, outline=C_GREEN)
            self.canvas.create_text((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, text="Tomar",
                                    fill=C_GREEN, font=("Segoe UI", 8, "bold"))
        else:
            if self.grupo_msg:
                msg = self.grupo_msg
            elif self.decidiendo:
                msg = "..."
            elif g.get("estado") == "espera":
                msg = "En espera · te aviso si se suma otro"
            elif prep:
                msg = "Todos tuyos · te van cayendo"
            else:
                msg = "Todos listos · van a vos"
            self.canvas.create_text(cx, GRUPO_BOX[1] + 52, text=msg, fill=C_GRAY,
                                    font=("Segoe UI", 8))

    def _espera_con_tomar(self):
        g = self.grupo or {}
        return (self._banda_visible() and not g.get("oferta") and not self.decidiendo
                and g.get("estado") == "espera" and int(g.get("listos") or 0) > 0)

    def redraw(self):
        self.canvas.delete("all")

        if self._banda_visible():
            self._draw_banda()

        ubic_rect = self._o(UBIC_BOX_MAIN) if self.stage == "main" else UBIC_BOX
        self._round_pill(*ubic_rect, radius=16, fill=C_FILL)

        pills = [self._o(PILL_ARTICULOS), self._o(PILL_ERROR)] if self.stage == "main" else [PILL1]
        for rect in pills:
            self._round_pill(*rect, radius=(rect[3] - rect[1]) / 2, fill=C_FILL, outline=C_BORDER)

        if self.stage == "main":
            pa, pe = self._o(PILL_ARTICULOS), self._o(PILL_ERROR)
            self.canvas.create_text(
                (pa[0] + pa[2]) / 2, (pa[1] + pa[3]) / 2,
                text=self.articulos_label_text, fill=C_TXT,
                font=("Segoe UI", 10, "bold"))
            self.canvas.create_text(
                (pe[0] + pe[2]) / 2, (pe[1] + pe[3]) / 2,
                text=self.error_label_text, fill=C_TXT,
                font=("Segoe UI", 10, "bold"), width=pe[2] - pe[0] - 16)
            self._draw_reasignar_icon(self._o(REASIGNAR_ICON))
        else:
            cx, cy = PILL1[0] + 20, (PILL1[1] + PILL1[3]) / 2
            self.canvas.create_oval(cx - 6, cy - 6, cx + 4, cy + 4, outline=C_GRAY, width=2)
            self.canvas.create_line(cx + 3, cy + 3, cx + 8, cy + 8, fill=C_GRAY, width=2)

        right_margin = (REASIGNAR_ICON[2] - REASIGNAR_ICON[0]) + 6 if self.stage == "main" else 0
        self.canvas.create_text(
            (ubic_rect[0] + ubic_rect[2] - right_margin) / 2 + 2,
            (ubic_rect[1] + ubic_rect[3]) / 2,
            text=self.ubic_text, fill=self.ubic_color,
            font=("Segoe UI", 10, "bold"), justify="center",
            width=ubic_rect[2] - ubic_rect[0] - 8 - right_margin)

        self.txt_nro.place_forget()
        if self.stage == "operario":
            self.txt_nro.place(x=PILL1[0] + 38, y=PILL1[1] + 8,
                                width=(PILL1[2] - PILL1[0]) - 48, height=26)

    # ------------------------- input N Operario -------------------------------
    def _on_nro_focus_in(self, _e=None):
        if self.txt_nro.get() == PLACEHOLDER_OPERARIO:
            self.txt_nro.delete(0, "end")
            self.txt_nro.config(fg=C_TXT)

    def _on_nro_focus_out(self, _e=None):
        if not self.txt_nro.get().strip():
            self.txt_nro.insert(0, PLACEHOLDER_OPERARIO)
            self.txt_nro.config(fg=C_GRAY)

    def _on_nro_enter(self, _e=None):
        if self.stage == "operario":
            self.fetch_operario()

    def fetch_operario(self):
        nro_text = self.txt_nro.get().strip()
        if not re.match(r"^\d+$", nro_text):
            self.set_ubic("Ingresá tu N° de operario", C_GRAY)
            return
        self.set_ubic("Buscando...", C_GRAY)
        try:
            resp = api_get("/api/deposito/errores-mesa/operario?nro=%s" % nro_text, 8)
            self.operario_nro = int(nro_text)
            self.operario_nombre = resp.get("nombre") if resp else None
            self.switch_to_main()
        except ApiError as e:
            if e.status_code == 404:
                self.set_ubic("Operario no encontrado", C_ERR)
            else:
                log("Fetch-Operario nro=%s status=%s detalle=%s" % (nro_text, e.status_code, e.body_text))
                self.set_ubic("Error: %s" % get_error_message(e.body_text), C_ERR)

    # ------------------------------ stages -------------------------------------
    def _set_form_height(self, h):
        self.cur_h = h
        self.canvas.config(height=h)
        self.root.geometry("%dx%d+%d+%d" % (FORM_W, h, self.x, self.bottom - h))

    def _ajustar_alto(self):
        """Alto del stage main segun si la banda de grupo esta visible."""
        if self.stage != "main":
            return
        h = STAGE2_H + self._off()
        if h != self.cur_h:
            self._set_form_height(h)

    def switch_to_main(self):
        self.stage = "main"
        self.pedido_valido = False
        self.pedido_asignado = None
        self.remito_asignado = None
        self.cod_cliente_asignado = None
        self.grupos, self.grupo, self.grupo_msg = [], None, None
        self._set_form_height(STAGE2_H)
        self._poll_grupo()
        self.set_ubic("Hola, %s" % self.operario_nombre, C_GREEN)
        if self._welcome_after_id:
            try:
                self.root.after_cancel(self._welcome_after_id)
            except Exception:
                pass
        self._welcome_after_id = self.root.after(1600, lambda: self.set_ubic(IDLE_TEXT, C_GRAY))

    def switch_to_operario(self):
        if self._welcome_after_id:
            try:
                self.root.after_cancel(self._welcome_after_id)
            except Exception:
                pass
        if self._reset_after_id:
            try:
                self.root.after_cancel(self._reset_after_id)
            except Exception:
                pass
        if self._poll_after_id:
            try:
                self.root.after_cancel(self._poll_after_id)
            except Exception:
                pass
            self._poll_after_id = None
        self.grupos, self.grupo, self.grupo_msg = [], None, None
        self.cod_cliente_asignado = None
        self._guardando = False
        self.stage = "operario"
        self.operario_nro = None
        self.operario_nombre = None
        self.pedido_valido = False
        self.pedido_asignado = None
        self.remito_asignado = None
        self.asignando = False
        self._vigilado = None
        self._auto_hasta = 0.0
        self.reset_articulos()
        self.txt_nro.delete(0, "end")
        self.txt_nro.insert(0, PLACEHOLDER_OPERARIO)
        self.txt_nro.config(fg=C_GRAY)
        self._set_form_height(STAGE1_H)
        self.set_ubic(IDLE_TEXT, C_GRAY)

    # ------------------------------ asignar -------------------------------------
    def fetch_asignar(self):
        if self.stage != "main" or self.asignando:
            return
        self.asignando = True
        self.set_ubic("Asignando...", C_GRAY)
        try:
            resp = api_post("/api/deposito/errores-mesa/asignar",
                             {"nroOperario": self.operario_nro}, 20)
            self._aplicar_asignacion(resp)
        except ApiError as e:
            if e.status_code == 404:
                self.set_ubic(get_error_message(e.body_text), C_ERR)
            else:
                log("Fetch-Asignar operario=%s status=%s detalle=%s" %
                    (self.operario_nro, e.status_code, e.body_text))
                self.set_ubic("Error: %s" % get_error_message(e.body_text), C_ERR)
        finally:
            self.asignando = False

    def _aplicar_asignacion(self, resp):
        """Muestra la fila asignada (respuesta de /asignar o el "asignado" de
        Tomar) y, si viene, el grupo del cliente en la banda."""
        nro_nuevo = int(resp["nroPedido"])
        # ACOPIO 70/75 (2026-08-21): la unidad asignada es la VUELTA, no
        # el pedido — el server manda "nroRemito" (0 = fila normal por
        # pedido, > 0 = vuelta de acopio). Un mismo acopio puede tocar
        # varias veces a lo largo de meses, con OTRA vuelta cada vez, así
        # que comparar solo por nroPedido lo tomaría por "el mismo" y no
        # recargaría los artículos. La identidad es el par.
        remito_nuevo = int(resp.get("nroRemito") or 0)
        es_pedido_nuevo = (
            (nro_nuevo, remito_nuevo) != (self.pedido_asignado, self.remito_asignado)
        )

        self.pedido_asignado = nro_nuevo
        self.remito_asignado = remito_nuevo
        self.pedido_valido = True
        self._vigilado = (nro_nuevo, remito_nuevo)
        self._auto_hasta = 0.0

        cliente_nombre = resp.get("cliente") or "Sin cliente"
        cod_cliente = resp.get("codCliente")
        cliente_linea = "%s #%s" % (cliente_nombre, cod_cliente) if cod_cliente else cliente_nombre
        ubic_limpia = clean_ubicacion(resp.get("ubicacion")) or "Sin ubicación"
        # En acopio se muestra también el remito: es LA VUELTA que hay que
        # controlar (el pedido va a seguir abierto meses y puede volver a
        # tocar con otra vuelta distinta).
        linea_ped = ("Ped %s · Rem %s" % (nro_nuevo, remito_nuevo)) if remito_nuevo \
            else ("Ped %s" % nro_nuevo)
        self.set_ubic("%s\n%s\n%s" % (cliente_linea, linea_ped, ubic_limpia), C_GREEN)

        self.cod_cliente_asignado = cod_cliente
        self.grupo_msg = None
        g = resp.get("grupo")
        if g is not None:
            self._set_grupos([g] + [x for x in self.grupos
                                    if x.get("codCliente") != g.get("codCliente")])

        if es_pedido_nuevo:
            self.load_articulos(str(nro_nuevo))

    # ------------------------------ guardar -------------------------------------
    # REDISEÑO 2026-08-19: ya no hay 1 detalleError para todo el pedido - se
    # guarda en lote, 1 fila por articulo (cada uno con SU error, elegido en
    # el selector de Articulos). Accion explicita: click en la pildora
    # "Finalizar" (antes "Error"), no se dispara solo al elegir el ultimo dato.
    def try_guardar(self):
        if self.stage != "main":
            return
        if self._guardando:   # ya se mandó este lote (doble click) - ignorar
            return
        if not self.articulos_errores:
            self.set_ubic("Elegí un error por artículo", C_ERR)
            return
        if not self.pedido_valido or not self.pedido_asignado:
            self.set_ubic("Asigná un pedido primero", C_ERR)
            return
        items = [{"codArticulo": cod, "detalleError": err}
                 for cod, err in self.articulos_errores.items()]
        body = {
            "nroPedido": self.pedido_asignado,
            "nroOperario": self.operario_nro,
            "items": items,
        }
        self.set_ubic("Guardando...", C_GRAY)
        self._guardando = True
        try:
            api_post("/api/deposito/errores-mesa/items", body, 10)
            self.set_ubic("Guardado", C_GREEN)
            if self._reset_after_id:
                try:
                    self.root.after_cancel(self._reset_after_id)
                except Exception:
                    pass
            self._reset_after_id = self.root.after(1400, self._do_reset)
        except ApiError as e:
            log("Try-Guardar nro=%s operario=%s items=%s detalle=%s" %
                (self.pedido_asignado, self.operario_nro, items, e.body_text))
            msg = get_error_message(e.body_text) or ""
            if msg.startswith("Ya estaba"):
                # el server lo rechazó por repetido: ya está guardado, se
                # trata como OK (no se reintenta y se limpia el widget)
                self.set_ubic(msg, C_GREEN)
                if self._reset_after_id:
                    try:
                        self.root.after_cancel(self._reset_after_id)
                    except Exception:
                        pass
                self._reset_after_id = self.root.after(1400, self._do_reset)
                return
            self._guardando = False   # fallo real: se puede reintentar
            self.set_ubic("Error: %s" % msg, C_ERR)

    def _do_reset(self):
        self._guardando = False
        self.pedido_valido = False
        self.pedido_asignado = None   # libera el icono de reasignar para un nuevo reclamo
        self.remito_asignado = None
        self.cod_cliente_asignado = None
        self.reset_articulos()
        self.set_ubic(IDLE_TEXT, C_GRAY)

    # ------------------------ grupo por cliente -------------------------------
    # RESERVA POR CLIENTE (2026-09-23). El polling corre en un hilo (no traba
    # la UI si el server tarda) y deja el resultado en una cola que el hilo de
    # tkinter vacia cada 400 ms (_drain_poll) - tkinter no es thread-safe.
    def _poll_grupo(self):
        if self._poll_after_id:
            try:
                self.root.after_cancel(self._poll_after_id)
            except Exception:
                pass
            self._poll_after_id = None
        if self.stage != "main" or not self.operario_nro:
            return
        self._poll_after_id = self.root.after(POLL_GRUPO_MS, self._poll_grupo)
        if self._poll_en_curso:
            return
        self._poll_en_curso = True
        nro = self.operario_nro

        def worker():
            try:
                r = api_get("/api/deposito/errores-mesa/grupo?nroOperario=%s" % nro, 15)
                self._poll_q.put((nro, r))
            except ApiError as e:
                self._poll_q.put((nro, e))

        threading.Thread(target=worker, daemon=True).start()

    def _drain_poll(self):
        try:
            while True:
                nro, r = self._poll_q.get_nowait()
                self._poll_en_curso = False
                if nro != self.operario_nro or self.stage != "main":
                    continue
                if isinstance(r, ApiError):
                    log("Poll-Grupo operario=%s status=%s detalle=%s" % (nro, r.status_code, r.body_text))
                    continue
                grupos = (r or {}).get("grupos") or []
                self._set_grupos(grupos)
                idle = not self.pedido_asignado and not self.asignando and not self.decidiendo
                if idle and any(g.get("autoAsignar") for g in grupos):
                    self.fetch_asignar()
                elif ((r or {}).get("preasignadoListo") and not self.asignando
                      and not self.decidiendo and not self.articulos_errores
                      and self.articulos_popup is None):
                    # PREASIGNACION (2026-09-24): el supervisor le eligio un
                    # pedido desde la vista "Asignar pedidos", ya esta listo y
                    # lo que estaba controlando cerro en Magnus -> se pide solo.
                    # No pisa errores cargados sin Finalizar ni el menu abierto.
                    try:
                        self.root.bell()
                    except Exception:
                        pass
                    self.fetch_asignar()
                else:
                    self._auto_siguiente((r or {}).get("actual"))
        except queue.Empty:
            pass
        except Exception:
            log("Drain-Poll:\n" + traceback.format_exc())
        try:
            self._intentar_reinicio()
            if _REINICIAR:
                return
        except Exception:
            log("Reinicio:\n" + traceback.format_exc())
        self.root.after(400, self._drain_poll)

    def _auto_siguiente(self, actual):
        """CAMBIO AUTOMATICO AL CERRAR (2026-10-05) - ver docstring del modulo."""
        if actual and actual.get("cerrado") and self._vigilado == (
                int(actual.get("nroPedido") or 0), int(actual.get("nroRemito") or 0)):
            self._vigilado = None
            self._auto_hasta = time.time() + AUTO_SIGUIENTE_S
            self._auto_bell = True
        if self._auto_hasta <= time.time():
            self._auto_hasta = 0.0
            return
        if (self.asignando or self.decidiendo or self._guardando
                or self.articulos_errores or self.articulos_popup is not None):
            return   # errores sin Finalizar / menu abierto: espera
        if self._auto_bell:          # bell solo en el primer intento
            self._auto_bell = False
            try:
                self.root.bell()
            except Exception:
                pass
        if self.pedido_asignado:
            self._do_reset()
        self.fetch_asignar()

    def _set_grupos(self, grupos):
        """Filtra lo que vale la pena mostrar y elige el de la banda: primero
        el que pide decision; si no, el del pedido que esta controlando; si no,
        el primero."""
        vis = [g for g in grupos
               if g.get("oferta") or int(g.get("total") or 0) > 1 or int(g.get("enPreparacion") or 0) > 0]
        self.grupos = vis
        elegido = next((g for g in vis if g.get("oferta")), None)
        if elegido is None and self.cod_cliente_asignado is not None:
            elegido = next((g for g in vis if g.get("codCliente") == self.cod_cliente_asignado), None)
        if elegido is None and vis:
            elegido = vis[0]
        if (elegido or {}).get("codCliente") != (self.grupo or {}).get("codCliente"):
            self.grupo_msg = None
        self.grupo = elegido
        if elegido is not None and elegido.get("oferta"):
            clave = (elegido.get("codCliente"), int(elegido.get("listos") or 0))
            if clave not in self._ofertas_vistas:
                self._ofertas_vistas.add(clave)
                try:
                    self.root.bell()
                except Exception:
                    pass
        self._ajustar_alto()
        self.redraw()

    def _decidir(self, accion):
        g = self.grupo
        if not g or self.decidiendo:
            return
        cod = g.get("codCliente")
        self.decidiendo = True
        self.redraw()
        try:
            resp = api_post("/api/deposito/errores-mesa/grupo/decision",
                            {"nroOperario": self.operario_nro, "codCliente": cod,
                             "accion": accion}, 20) or {}
            self.decidiendo = False
            if accion == "esperar":
                self.grupo_msg = None   # la banda muestra "En espera ..." por estado
                if resp.get("liberado"):
                    # El pedido volvio a la cola reservado para el: queda libre
                    # para tomar otro cliente.
                    self._do_reset()
                    self.set_ubic("En espera. Asigná otro pedido", C_GRAY)
            else:
                self.grupo_msg = ("Tomado · sigue despues del actual"
                                  if resp.get("despues") else None)
                if resp.get("asignado"):
                    self._aplicar_asignacion(resp["asignado"])
            g2 = resp.get("grupo")
            if g2 is not None:
                self._set_grupos([g2] + [x for x in self.grupos if x.get("codCliente") != cod])
            else:
                self._set_grupos([x for x in self.grupos if x.get("codCliente") != cod])
        except ApiError as e:
            self.decidiendo = False
            log("Decidir-Grupo operario=%s cliente=%s accion=%s status=%s detalle=%s" %
                (self.operario_nro, cod, accion, e.status_code, e.body_text))
            self.grupo_msg = get_error_message(e.body_text) or "Error"
            self.redraw()
        self._poll_grupo()

    # ------------------------------ opciones Error -------------------------------
    def load_opciones(self):
        detalle = list(FALLBACK_DETALLE)
        try:
            op = api_get("/api/deposito/errores-mesa/opciones", 6)
            if op and op.get("detalleError"):
                detalle = op["detalleError"]
        except ApiError:
            pass  # sin conexion: se queda con el fallback local
        self.detalle_error_opciones = detalle

    # ------------------------------ Articulos -------------------------------------
    def reset_articulos(self):
        self.articulos_disponibles = []
        self.articulos_errores = {}
        self.refresh_articulos_label()

    def refresh_articulos_label(self):
        n = len(self.articulos_errores)
        if n == 0:
            self.articulos_label_text = "Artículos"
        elif n == 1:
            self.articulos_label_text = "1 artículo"
        else:
            self.articulos_label_text = "%d artículos" % n
        self.error_label_text = "Finalizar (%d)" % n if n else "Finalizar"
        self.redraw()

    def load_articulos(self, nro_text):
        self.articulos_disponibles = []
        self.articulos_errores = {}
        try:
            # 20s: este endpoint hace varios round-trips en el server (WMS +
            # EVERWEAR), mas lento que el resto de las llamadas del widget.
            arts = api_get("/api/deposito/pedido/%s/articulos" % nro_text, 20)
            if arts:
                self.articulos_disponibles = list(arts)
        except ApiError as e:
            log("Load-Articulos nro=%s detalle=%s" % (nro_text, e.body_text))
        self.refresh_articulos_label()

    # -- fila del selector: texto + color segun si ya tiene error elegido --
    def _row_text(self, art):
        # 2026-08-25: el CODIGO de articulo va PRIMERO y
        # despues la descripcion. Antes la fila arrancaba con la descripcion
        # y, como el ancho de la lista corta el texto, el codigo (que es el
        # dato con el que se identifica el articulo) no se veia nunca.
        cod = art.get("codArticulo")
        cod_txt = str(cod).strip() if cod is not None else ""
        desc_txt = (art.get("descripcion") or "").strip()
        base = ("%s  %s" % (cod_txt, desc_txt)).strip() if cod_txt else desc_txt
        texto = _truncate(base)
        err = self.articulos_errores.get(cod)
        mark = "☑" if err else "☐"
        if err:
            return "%s %s → %s" % (mark, texto, err)
        return "%s %s" % (mark, texto)

    def _refresh_row(self, cod, art):
        row = self._articulos_rows.get(cod)
        if not row:
            return
        _frame, lbl = row
        has_err = cod in self.articulos_errores
        lbl.config(text=self._row_text(art), fg=(C_GREEN if has_err else C_TXT))

    def open_item_error_menu(self, art, anchor_widget):
        """Menu de Detalle Error para UN articulo puntual (click en su fila
        del selector) - reemplaza al menu global de Error del diseño viejo."""
        cod = art.get("codArticulo")
        menu = tk.Menu(self.root, tearoff=0, bg=C_FILL, fg=C_TXT,
                        activebackground=C_BORDER, activeforeground=C_TXT)
        if cod in self.articulos_errores:
            menu.add_command(label="✕ Quitar selección",
                              command=lambda: self._set_articulo_error(art, None))
            menu.add_separator()
        for d in self.detalle_error_opciones:
            menu.add_command(label=d, command=lambda d=d: self._set_articulo_error(art, d))
        x = anchor_widget.winfo_rootx()
        y = anchor_widget.winfo_rooty() + anchor_widget.winfo_height()
        try:
            menu.tk_popup(x, y)
        finally:
            menu.grab_release()

    def _set_articulo_error(self, art, detalle):
        cod = art.get("codArticulo")
        if detalle is None:
            self.articulos_errores.pop(cod, None)
        else:
            self.articulos_errores[cod] = detalle
        self.refresh_articulos_label()
        self._refresh_row(cod, art)

    def _on_articulos_wheel(self, e):
        if self._articulos_canvas is None:
            return
        # Windows: e.delta es multiplo de 120 (positivo = arriba).
        steps = -1 if e.delta > 0 else 1
        self._articulos_canvas.yview_scroll(steps, "units")

    def open_articulos_menu(self, x_root, y_root):
        if self.articulos_popup is not None:
            try:
                self.articulos_popup.destroy()
            except Exception:
                pass
            self.articulos_popup = None

        popup = tk.Toplevel(self.root)
        popup.overrideredirect(True)
        popup.attributes("-topmost", True)
        popup.configure(bg=C_BORDER)
        inner = tk.Frame(popup, bg=C_FILL)
        inner.pack(padx=1, pady=1)

        self._articulos_rows = {}
        self._articulos_canvas = None

        if not self.articulos_disponibles:
            tk.Label(inner, text="Sin artículos para este pedido", bg=C_FILL, fg=C_GRAY,
                      font=("Segoe UI", 9), padx=10, pady=6, anchor="w").pack(fill="x")
        else:
            # Lista con scroll (REDISEÑO 2026-08-19): antes esto era un Frame
            # que apilaba TODOS los articulos sin limite y se salia de la
            # pantalla en pedidos grandes. Ahora se ve como maximo
            # VISIBLE_ROWS (10) filas de alto ROW_H fijo y el resto scrollea
            # (rueda del mouse o la barra de scroll).
            list_wrap = tk.Frame(inner, bg=C_FILL)
            list_wrap.pack(fill="both", expand=True)

            n_rows = len(self.articulos_disponibles)
            visible_h = ROW_H * min(VISIBLE_ROWS, n_rows)
            list_canvas = tk.Canvas(list_wrap, width=ROW_WIDTH, height=visible_h,
                                     bg=C_FILL, highlightthickness=0, bd=0)
            rows_frame = tk.Frame(list_canvas, bg=C_FILL)
            rows_window = list_canvas.create_window((0, 0), window=rows_frame, anchor="nw")

            if n_rows > VISIBLE_ROWS:
                vsb = tk.Scrollbar(list_wrap, orient="vertical", command=list_canvas.yview)
                list_canvas.configure(yscrollcommand=vsb.set)
                vsb.pack(side="right", fill="y")
            list_canvas.pack(side="left", fill="both", expand=True)

            for art in self.articulos_disponibles:
                cod = art.get("codArticulo")
                row = tk.Frame(rows_frame, bg=C_FILL, height=ROW_H)
                row.pack(fill="x")
                row.pack_propagate(False)

                lbl = tk.Label(row, text=self._row_text(art),
                                bg=C_FILL, fg=(C_GREEN if cod in self.articulos_errores else C_TXT),
                                font=("Segoe UI", 9), anchor="w", justify="left",
                                cursor="hand2")
                lbl.pack(fill="both", expand=True, padx=6)
                lbl.bind("<Button-1>", lambda _e, art=art, lbl=lbl: self.open_item_error_menu(art, lbl))
                self._articulos_rows[cod] = (row, lbl)

            def _on_rows_configure(_e=None):
                list_canvas.configure(scrollregion=list_canvas.bbox("all"))
            rows_frame.bind("<Configure>", _on_rows_configure)
            list_canvas.bind(
                "<Configure>",
                lambda e: list_canvas.itemconfig(rows_window, width=e.width))

            self._articulos_canvas = list_canvas
            self.root.bind_all("<MouseWheel>", self._on_articulos_wheel)

        sep = tk.Frame(inner, bg=C_BORDER, height=1)
        sep.pack(fill="x", pady=4)
        btn = tk.Button(inner, text="✓ Listo (cerrar)",
                         command=lambda: self.close_articulos_menu(popup),
                         bg=C_FILL, fg=C_GREEN, activebackground=C_FILL, activeforeground=C_GREEN,
                         font=("Segoe UI", 9, "bold"), bd=0, highlightthickness=0)
        btn.pack(fill="x", padx=6, pady=(0, 6))

        popup.geometry("+%d+%d" % (x_root, y_root))
        self.articulos_popup = popup

    def close_articulos_menu(self, popup):
        self.root.unbind_all("<MouseWheel>")
        self._articulos_canvas = None
        self._articulos_rows = {}
        self.refresh_articulos_label()
        try:
            popup.destroy()
        except Exception:
            pass
        if self.articulos_popup is popup:
            self.articulos_popup = None

    # ----------------------- arrastrar / clic -------------------------------
    def on_press(self, e):
        # Guarda el origen del click siempre (para el hit-test de MouseUp),
        # pero solo lo que empieza en la franja de arriba (UBIC_DRAG) mueve
        # la ventana - mismo criterio que el .ps1 ($script:dragging).
        self._press = (e.x_root, e.y_root, self.root.winfo_x(), self.root.winfo_y())
        self._dragging = rect_contains(UBIC_DRAG, e.x, e.y)
        self._moved = False

    def on_drag(self, e):
        if not self._press or not self._dragging:
            return
        dx = e.x_root - self._press[0]
        dy = e.y_root - self._press[1]
        if abs(dx) > 3 or abs(dy) > 3:
            self._moved = True
        new_x = self._press[2] + dx
        new_y = self._press[3] + dy
        self.root.geometry("+%d+%d" % (new_x, new_y))
        self.x = new_x
        self.bottom = new_y + self.cur_h

    def on_release(self, e):
        # Solo se cancela el click si HUBO un arrastre real (franja de
        # arriba + moviste el mouse). Un click directo sobre Artículos/
        # Finalizar/el ícono de reasignar nunca pasó por la franja de
        # arrastre, así que
        # _dragging es False y el hit-test de abajo se evalúa igual - antes
        # este método cortaba con "return" en ese caso y las píldoras nunca
        # respondían al click.
        was_drag = bool(self._dragging) and self._moved
        self._press = None
        self._dragging = False
        self._moved = False
        if was_drag:
            return
        oferta = self._banda_visible() and bool(self.grupo.get("oferta")) and not self.decidiendo
        if oferta and rect_contains(GRUPO_BTN_TOMAR, e.x, e.y):
            self._decidir("tomar")
        elif oferta and rect_contains(GRUPO_BTN_ESPERAR, e.x, e.y):
            self._decidir("esperar")
        elif self._espera_con_tomar() and rect_contains(GRUPO_BTN_TOMAR_ESPERA, e.x, e.y):
            self._decidir("tomar")
        elif self.stage == "main" and rect_contains(self._o(REASIGNAR_ICON), e.x, e.y):
            self.fetch_asignar()
        elif self.stage == "main" and rect_contains(self._o(PILL_ARTICULOS), e.x, e.y):
            pa = self._o(PILL_ARTICULOS)
            pt_x = self.canvas.winfo_rootx() + pa[0]
            pt_y = self.canvas.winfo_rooty() + pa[3] + 2
            self.open_articulos_menu(pt_x, pt_y)
        elif self.stage == "main" and rect_contains(self._o(PILL_ERROR), e.x, e.y):
            # "Finalizar" (antes "Error"): guarda en lote, ver try_guardar.
            self.try_guardar()


def main():
    log("===== Inicio. exe=%s =====" % exe_path())
    try:
        enable_dpi_awareness()
        app = ErroresMesaWidget()
        log("Ventana creada.")
        app.root.mainloop()
    except Exception:
        tb = traceback.format_exc()
        log("ERROR FATAL:\n" + tb)
        try:
            messagebox.showerror("Errores Mesa de Control",
                                  "Error al iniciar el widget:\n\n%s\n\nDetalle en: %s" % (tb, LOG_PATH))
        except Exception:
            pass
        raise
    finally:
        log("Fin.")


if __name__ == "__main__":
    main()
