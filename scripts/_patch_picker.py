import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f"match {n} != {count}: {old[:80]!r}")
    s = s.replace(old, new)

# ── cabecera
rep("""//     Cantidad: un único input enfocado con el teclado numérico ABIERTO
//     (VirtualKeyboard API, virtualkeyboardpolicy="manual"); Enter o
//     "Enviar pedido" y vuelve al código limpio y enfocado.""",
"""//     Si el campo tenía restos (un escaneo cortado, algo tocado), el escaneo
//     nuevo se toma desde donde arrancó la ráfaga y los restos se descartan.
//     El input está dentro de un <form>: el Enter que llega con el IME
//     componiendo (keyCode 229) igual lo dispara el submit implícito.
//     Si el foco se perdió, un keydown en cualquier lado lo devuelve al código.
//     Cantidad: teclado numérico PROPIO en pantalla (no depende del teclado
//     del sistema, que sin toque del usuario Android no siempre abre); el
//     input sigue aceptando teclas físicas. Enter o "Enviar pedido" y vuelve
//     al código limpio y enfocado.""")

# ── sacar VirtualKeyboard API
rep("""// Teclado en pantalla por API (Chrome Android): el input de cantidad lleva
// virtualkeyboardpolicy="manual" y se le pide el teclado al enfocarlo, porque un
// focus() disparado por el escaneo (no por un toque) no lo abre solo.
const mostrarTecladoVirtual = () => {
  try {
    (navigator as Navigator & { virtualKeyboard?: { show: () => void } }).virtualKeyboard?.show();
  } catch {
    /* sin API: queda el comportamiento normal del navegador */
  }
};
""",
"""// Umbrales del lector: entre caracteres de una ráfaga, pausa que corta la
// ráfaga y pausa que marca el arranque de un escaneo nuevo sobre restos.
const RAFAGA_MS = 80;
const QUIETO_MS = 150;
const ARRANQUE_MS = 300;

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"];
""")

rep("""  const rafagaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
""", """  const rafagaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inicioRafaga = useRef(0); // posición del input donde arrancó la ráfaga
""")

# ── foco: visibilitychange + keydown global
rep("""    window.addEventListener("focus", t);
    return () => {""", """    window.addEventListener("focus", t);
    window.addEventListener("pageshow", t);
    const onVis = () => {
      if (document.visibilityState === "visible") t();
    };
    document.addEventListener("visibilitychange", onVis);
    // Lector tipeando con el foco perdido: se enfoca el código en el keydown
    // (fase captura) y el carácter cae en el input.
    const onKey = () => {
      if (document.activeElement !== codigoRef.current) enfocar();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pageshow", t);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("keydown", onKey, true);""")

# ── focus cantidad sin VirtualKeyboard
rep("""      requestAnimationFrame(() => {
        cantRef.current?.focus();
        mostrarTecladoVirtual();
      });
      return;""", """      requestAnimationFrame(() => cantRef.current?.focus({ preventScroll: true }));
      return;""")
rep("""      requestAnimationFrame(() => {
        cantRef.current?.focus();
        mostrarTecladoVirtual();
      });
  }, [chatAbierto]);""", """      requestAnimationFrame(() => cantRef.current?.focus({ preventScroll: true }));
  }, [chatAbierto]);""")

# ── Enter / change del código
rep("""  const onCodigoKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter (algunos lectores lo mandan con key "Unidentified" y keyCode 13) o
    // Tab como sufijo del lector: los dos abren la cantidad.
    const valor = e.currentTarget.value;
    if (e.key === "Enter" || e.keyCode === 13 || (e.key === "Tab" && valor.trim())) {
      e.preventDefault();
      abrir(valor);
    } else if (e.key === "Escape") {""", """  // Lo que se abre con Enter/submit: si recién terminó una ráfaga de lector, sólo
  // lo que tipeó el lector (sin restos previos); si no, el campo entero.
  const abrirActual = () => {
    const valor = codigoRef.current?.value ?? "";
    const reciente = rafagaRef.current && Date.now() - ultimoCharEn.current < 500;
    const parte = reciente ? valor.slice(inicioRafaga.current) : "";
    abrir(parte.trim().length >= 3 ? parte : valor);
  };

  const onCodigoKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter (algunos lectores lo mandan con key "Unidentified" y keyCode 13) o
    // Tab como sufijo del lector: los dos abren la cantidad.
    const valor = e.currentTarget.value;
    if (e.key === "Enter" || e.keyCode === 13 || (e.key === "Tab" && valor.trim())) {
      e.preventDefault();
      abrirActual();
    } else if (e.key === "Escape") {""")

old_change_start = s.index("  const onCodigoChange = ")
old_change_end = s.index("  useEffect(\n    () => () => {\n      if (rafagaTimer.current)")
s = s[:old_change_start] + """  const onCodigoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nuevo = e.target.value;
    // Contra el valor del evento anterior (no el estado): un lector que tipea
    // rápido puede disparar varios eventos antes de re-renderizar.
    const previo = previoRef.current;
    const salto = nuevo.length - previo.length;
    const ahora = Date.now();
    const pausa = ahora - ultimoCharEn.current;
    const agrega = nuevo.startsWith(previo); // se sumó al final (lector / tipeo)
    // Arranque de ráfaga: campo vacío, o pausa larga con restos en el campo
    // (escaneo nuevo sobre lo que quedó). Sigue siendo ráfaga mientras cada
    // carácter llegue a < RAFAGA_MS del anterior (una persona no llega).
    if (previo === "" || (pausa > ARRANQUE_MS && agrega)) {
      rafagaRef.current = true;
      inicioRafaga.current = agrega ? previo.length : 0;
    } else {
      rafagaRef.current = rafagaRef.current && agrega && pausa < RAFAGA_MS;
    }
    ultimoCharEn.current = ahora;
    previoRef.current = nuevo;
    const desdeVacio = previo === "";
    setCodigo(nuevo);
    if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    rafagaTimer.current = null;
    // Lectores que "pegan" el código entero sin Enter. Con el teclado oculto
    // sólo puede venir del lector; con el teclado visible se exige además que
    // el campo estuviera vacío (una sugerencia del teclado reemplaza lo ya
    // tipeado, nunca llega a un campo vacío). Con restos en el campo se abre
    // sólo lo pegado.
    if (salto >= 4 && (!teclado || desdeVacio)) {
      abrir(agrega && !desdeVacio ? nuevo.slice(previo.length) : nuevo);
      return;
    }
    // Lectores que tipean sin sufijo: cuando la ráfaga se corta QUIETO_MS, se
    // abre lo que tipeó el lector (también con el teclado visible).
    const parte = nuevo.slice(inicioRafaga.current);
    if (rafagaRef.current && parte.trim().length >= 3) {
      rafagaTimer.current = setTimeout(() => {
        rafagaTimer.current = null;
        if (rafagaRef.current && codigoRef.current?.value === nuevo) abrir(parte);
      }, QUIETO_MS);
    }
  };

""" + s[old_change_end:]

# reset inicio al volver al código
rep("""    setCodigo("");
    previoRef.current = "";
    setTeclado(false);""", """    setCodigo("");
    previoRef.current = "";
    inicioRafaga.current = 0;
    rafagaRef.current = false;
    setTeclado(false);""")

# ── teclado propio
rep("""  // ── Enviar pedido ──""", """  // Teclado numérico propio de la pantalla de cantidad.
  const tecla = (k: string) => {
    vibrar(12);
    setErrorCant(null);
    setCantidad((c) => {
      if (k === "⌫") return c.slice(0, -1);
      if (k === ",") return /[.,]/.test(c) ? c : (c || "0") + ",";
      if (c.length >= 9) return c;
      return c === "0" ? k : c + k;
    });
  };

  // ── Enviar pedido ──""")

rep("""            type="text"
            inputMode="numeric"
            enterKeyHint="send"
            autoComplete="off"
            {...({ virtualkeyboardpolicy: "manual" } as Record<string, string>)}
            onFocus={mostrarTecladoVirtual}
            onClick={mostrarTecladoVirtual}
            placeholder="Cantidad\"""", """            type="text"
            inputMode="none"
            enterKeyHint="send"
            autoComplete="off"
            placeholder="Cantidad\"""")

rep("""          {errorCant && (
            <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorCant}
            </div>
          )}

          <button
            type="submit\"""", """          {errorCant && (
            <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorCant}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {TECLAS.map((k) => (
              <button
                key={k}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => tecla(k)}
                className={`rounded-lg border-2 py-3 text-3xl font-bold tabular-nums select-none ${
                  k === "⌫"
                    ? "border-zinc-700 bg-[#1f1f1f] text-zinc-300 active:bg-zinc-700"
                    : "border-zinc-700 bg-[#1f1f1f] text-white active:bg-yellow-400 active:text-black"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <button
            type="submit\"""")

rep("""className="flex-1 flex flex-col gap-4 px-4 pt-4\"""", """className="flex-1 flex flex-col gap-3 px-4 pt-3 pb-4\"""")

# ── form alrededor del input de código
rep("""        <div className="flex items-center gap-2 px-3 pb-2">
          <div className="relative flex-1">""", """        <form
          className="flex items-center gap-2 px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            abrirActual();
          }}
        >
          <div className="relative flex-1">""")
rep("""              <Keyboard className="h-5 w-5" />
            </button>
          )}
        </div>""", """              <Keyboard className="h-5 w-5" />
            </button>
          )}
        </form>""")

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
