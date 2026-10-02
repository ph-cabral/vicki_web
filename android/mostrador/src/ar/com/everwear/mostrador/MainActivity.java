package ar.com.everwear.mostrador;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;

import ar.com.everwear.comun.Actualizador;

/**
 * Pantalla única: /mostradores/control de vicki en un WebView.
 * - Login normal de vicki (cookie de sesión persistente en el WebView).
 * - Queda "encerrada" en /mostradores/control: cualquier otra ruta (menos /login) vuelve al control.
 * - Pantalla siempre encendida mientras está abierta (conteo).
 * - navigator.vibrate pasa por el Vibrator nativo (el WebView no lo implementa).
 * - Límite de inactividad: sin tocar la pantalla ni el teclado/escáner Config.INACTIVIDAD_MIN minutos,
 *   cierra la sesión (vuelve al login para que el próximo controlador entre con su usuario).
 *   Avisa 1 min antes. La última actividad se guarda: si la app se cerró y vuelve pasado el límite,
 *   arranca deslogueada.
 */
public class MainActivity extends Activity {

    static final String RUTA = "/mostradores/control";
    static final String URL_CONTROL = Config.BASE_URL + RUTA;

    /** Polyfill: la página llama navigator.vibrate?.(ms). */
    private static final String JS_VIBRAR =
            "(function(){try{if(window.__ewVib)return;window.__ewVib=1;"
                    + "navigator.vibrate=function(p){try{EwMostrador.vibrar(JSON.stringify(p));}catch(e){}return true;};"
                    + "}catch(e){}})()";

    private static final long LIMITE_MS = Config.INACTIVIDAD_MIN * 60_000L;
    private static final long AVISO_MS = 60_000L;
    private static final long TICK_MS = 15_000L;
    private static final String PREFS = "mostrador", PREF_ULTIMA = "ultimaActividad";

    private WebView web;
    private Actualizador actualizador;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long ultimaActividad = System.currentTimeMillis();
    private boolean avisado;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            revisarInactividad();
            handler.postDelayed(this, TICK_MS);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#030712"));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#030712"));
        setContentView(web);

        CookieManager.getInstance().setAcceptCookie(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " EverWearMostrador/" + Config.VERSION);

        actualizador = new Actualizador(this, Config.BASE_URL, "/apk/everwear-mostrador.json");
        web.addJavascriptInterface(new Puente(), "EwMostrador");
        web.setWebViewClient(new Cliente());
        if (vencidaAlVolver()) {
            cerrarSesion(true); // estuvo cerrada más que el límite: arranca en el login
        } else {
            guardarActividad();
            web.loadUrl(URL_CONTROL);
        }
        web.requestFocus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        actualizador.enResume();
        if (vencidaAlVolver() && haySesion()) cerrarSesion(true);
        actividad();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush(); // que la sesión sobreviva a un cierre forzado
        actualizador.enPausa();
        handler.removeCallbacks(tick);
        if (!haySesion()) actividad(); // en el login no corre el reloj
        prefs().edit().putLong(PREF_ULTIMA, ultimaActividad).apply();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        // La página usa history.pushState para sus modales (conteo, cantidad, finalizar).
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ── Límite de inactividad ──────────────────────────────────────────────

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        actividad();
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent ev) {
        actividad(); // escáner del PDA (entra como teclado) y teclado en pantalla
        return super.dispatchKeyEvent(ev);
    }

    private void actividad() {
        ultimaActividad = System.currentTimeMillis();
        avisado = false;
    }

    private void guardarActividad() {
        actividad();
        prefs().edit().putLong(PREF_ULTIMA, ultimaActividad).apply();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** La app estuvo cerrada / en segundo plano más que el límite. */
    private boolean vencidaAlVolver() {
        long u = prefs().getLong(PREF_ULTIMA, 0);
        return u > 0 && System.currentTimeMillis() - u >= LIMITE_MS;
    }

    private static boolean haySesion() {
        String c = CookieManager.getInstance().getCookie(Config.BASE_URL);
        return c != null && c.contains("ever_session=");
    }

    private void revisarInactividad() {
        if (LIMITE_MS <= 0 || !haySesion()) {
            actividad(); // en el login no corre el reloj
            return;
        }
        long quieto = System.currentTimeMillis() - ultimaActividad;
        if (quieto >= LIMITE_MS) {
            cerrarSesion(true);
        } else if (!avisado && quieto >= LIMITE_MS - AVISO_MS) {
            avisado = true;
            Puente p = new Puente();
            p.vibrar("[200,150,200]");
            Toast.makeText(this, "Sin actividad: en 1 minuto se cierra la sesión. Tocá la pantalla para seguir.",
                    Toast.LENGTH_LONG).show();
        }
    }

    private void cargarControl() {
        web.loadUrl(URL_CONTROL);
    }

    private void cerrarSesion(boolean porInactividad) {
        guardarActividad();
        if (porInactividad) {
            Toast.makeText(this, "Sesión cerrada por inactividad (" + Config.INACTIVIDAD_MIN + " min)",
                    Toast.LENGTH_LONG).show();
        }
        final CookieManager cm = CookieManager.getInstance();
        // removeAllCookies es asíncrono: recién al terminar se recarga (si no, viaja la cookie vieja).
        cm.removeAllCookies(new ValueCallback<Boolean>() {
            @Override
            public void onReceiveValue(Boolean ok) {
                cm.flush();
                web.clearHistory();
                cargarControl(); // sin cookie -> middleware manda a /login?returnTo=/mostradores/control
            }
        });
    }

    private void pantallaMensaje(String titulo, String detalle, boolean conCerrarSesion) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='background:#030712;color:#d4d4d8;font-family:sans-serif;margin:0;"
                + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
                + "height:90vh;text-align:center;padding:0 24px'>"
                + "<p style='font-size:19px'>" + titulo + "</p>"
                + "<p style='color:#71717a;font-size:13px'>" + detalle + "</p>"
                + "<button onclick='EwMostrador.recargar()' style='margin-top:16px;padding:14px 28px;"
                + "font-size:18px;background:#facc15;border:0;border-radius:8px'>Reintentar</button>"
                + (conCerrarSesion
                        ? "<button onclick='EwMostrador.cerrarSesion()' style='margin-top:14px;padding:12px 24px;"
                                + "font-size:16px;background:transparent;color:#d4d4d8;border:1px solid #3f3f46;"
                                + "border-radius:8px'>Entrar con otro usuario</button>"
                        : "")
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static boolean esDelServidor(Uri u) {
        return u != null && u.getScheme() != null
                && Config.BASE_URL.startsWith(u.getScheme() + "://" + u.getAuthority());
    }

    /** Lo que la página puede llamar como window.EwMostrador.* */
    private class Puente {
        @JavascriptInterface
        public String version() {
            return Config.VERSION;
        }

        @JavascriptInterface
        public void recargar() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    cargarControl();
                }
            });
        }

        @JavascriptInterface
        public void cerrarSesion() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.cerrarSesion(false);
                }
            });
        }

        /** Minutos de inactividad antes de cerrar la sesión (para mostrarlo en la página). */
        @JavascriptInterface
        public int inactividadMin() {
            return Config.INACTIVIDAD_MIN;
        }

        @JavascriptInterface
        public void vibrar(String patron) {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator() || patron == null) return;
            try {
                String p = patron.trim();
                if (p.startsWith("[")) {
                    JSONArray a = new JSONArray(p);
                    if (a.length() == 0) { v.cancel(); return; }
                    long[] t = new long[a.length() + 1]; // Android: arranca con espera
                    t[0] = 0;
                    for (int i = 0; i < a.length(); i++) t[i + 1] = Math.max(0, a.optLong(i));
                    v.vibrate(VibrationEffect.createWaveform(t, -1));
                } else {
                    long ms = (long) Double.parseDouble(p);
                    if (ms <= 0) { v.cancel(); return; }
                    v.vibrate(VibrationEffect.createOneShot(Math.min(ms, 5000), VibrationEffect.DEFAULT_AMPLITUDE));
                }
            } catch (Exception ignored) {
            }
        }
    }

    private class Cliente extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (esDelServidor(u)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) {
            }
            return true;
        }

        /** Cubre también la navegación interna de Next (pushState / router.replace). */
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            Uri u = Uri.parse(url);
            if (!esDelServidor(u)) return;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.startsWith(RUTA) || path.startsWith("/login")) return;
            if (u.getQueryParameter("denied") != null) {
                pantallaMensaje("Tu usuario no tiene acceso a Control de mostrador",
                        "Pedí el permiso o entrá con otro usuario.", true);
                return;
            }
            cargarControl();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(JS_VIBRAR, null);
            CookieManager.getInstance().flush();
            actualizador.revisar();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            pantallaMensaje("No hay conexión con el servidor", Config.BASE_URL, false);
        }
    }
}
