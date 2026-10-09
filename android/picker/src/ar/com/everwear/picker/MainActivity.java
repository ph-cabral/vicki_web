package ar.com.everwear.picker;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import ar.com.everwear.comun.Actualizador;

/**
 * Pantalla única: la página /picking/picker de vicki en un WebView.
 * La página le pasa el nombre del picker por window.EverWearApp.setPicker(...)
 * y NotifService queda escuchando sus notificaciones aunque se cierre la app.
 */
public class MainActivity extends Activity {

    static final String URL_PICKER = Config.BASE_URL + "/deposito/picking/picker";

    private WebView web;
    private Actualizador actualizador;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#030712"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#030712"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " EverWearPicker/" + Config.VERSION);

        actualizador = new Actualizador(this, Config.BASE_URL, "/apk/everwear-picker.json");
        web.addJavascriptInterface(new Puente(), "EverWearApp");
        web.setWebViewClient(new Cliente());
        web.loadUrl(URL_PICKER);
        web.requestFocus();

        if (!Prefs.nombre(this).isEmpty()) Prefs.aplicarNombre(this, Prefs.nombre(this));
        pedirPermisos();
    }

    private void pedirPermisos() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        // Sin optimización de batería el sistema no corta la conexión con el equipo dormido.
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Exception ignored) {
                // algunos equipos no tienen esa pantalla
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        actualizador.enResume();
    }

    @Override
    protected void onPause() {
        actualizador.enPausa();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // no destruye la app: sigue escuchando igual
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Lo que la página puede llamar como window.EverWearApp.* */
    private class Puente {
        @JavascriptInterface
        public void setPicker(final String nombre) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Prefs.aplicarNombre(MainActivity.this, nombre);
                }
            });
        }

        @JavascriptInterface
        public String version() {
            return Config.VERSION;
        }

        @JavascriptInterface
        public void recargar() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    web.loadUrl(URL_PICKER);
                }
            });
        }
    }

    private class Cliente extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (Config.BASE_URL.startsWith(u.getScheme() + "://" + u.getAuthority())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            actualizador.revisar();
            // Toma el nombre que ya estaba en localStorage (picker que ya venía usando la página).
            view.evaluateJavascript(
                    "(function(){try{return localStorage.getItem('picker_nombre')||''}catch(e){return ''}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            if (v == null || v.length() < 2) return;
                            try {
                                String n = new org.json.JSONArray("[" + v + "]").getString(0); // viene como string JSON
                                if (!n.trim().isEmpty()) Prefs.aplicarNombre(MainActivity.this, n);
                            } catch (Exception ignored) {
                            }
                        }
                    });
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            String html = "<html><body style='background:#030712;color:#d4d4d8;font-family:sans-serif;"
                    + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
                    + "height:90vh;text-align:center'>"
                    + "<p style='font-size:18px'>No hay conexión con el servidor</p>"
                    + "<p style='color:#71717a;font-size:13px'>" + Config.BASE_URL + "</p>"
                    + "<button onclick='EverWearApp.recargar()' style='margin-top:16px;padding:14px 28px;"
                    + "font-size:18px;background:#facc15;border:0;border-radius:8px'>Reintentar</button>"
                    + "</body></html>";
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }
    }
}
