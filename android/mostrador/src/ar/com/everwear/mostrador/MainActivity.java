package ar.com.everwear.mostrador;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;

/**
 * Pantalla única: /mostradores/control de vicki en un WebView.
 * - Login normal de vicki (cookie de sesión persistente en el WebView).
 * - Queda "encerrada" en /mostradores/control: cualquier otra ruta (menos /login) vuelve al control.
 * - Pantalla siempre encendida mientras está abierta (conteo).
 * - navigator.vibrate pasa por el Vibrator nativo (el WebView no lo implementa).
 */
public class MainActivity extends Activity {

    static final String RUTA = "/mostradores/control";
    static final String URL_CONTROL = Config.BASE_URL + RUTA;

    /** Polyfill: la página llama navigator.vibrate?.(ms). */
    private static final String JS_VIBRAR =
            "(function(){try{if(window.__ewVib)return;window.__ewVib=1;"
                    + "navigator.vibrate=function(p){try{EwMostrador.vibrar(JSON.stringify(p));}catch(e){}return true;};"
                    + "}catch(e){}})()";

    private WebView web;

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

        web.addJavascriptInterface(new Puente(), "EwMostrador");
        web.setWebViewClient(new Cliente());
        web.loadUrl(URL_CONTROL);
        web.requestFocus();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush(); // que la sesión sobreviva a un cierre forzado
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

    private void cargarControl() {
        web.loadUrl(URL_CONTROL);
    }

    private void cerrarSesion() {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        web.clearHistory();
        cargarControl(); // sin cookie -> middleware manda a /login?returnTo=/mostradores/control
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
                    MainActivity.this.cerrarSesion();
                }
            });
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
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            pantallaMensaje("No hay conexión con el servidor", Config.BASE_URL, false);
        }
    }
}
