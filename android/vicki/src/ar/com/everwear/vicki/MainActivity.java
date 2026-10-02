package ar.com.everwear.vicki;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ar.com.everwear.comun.Actualizador;

/**
 * Vicki en un WebView, con la VPN adentro.
 *
 * Al abrir (y al cambiar de red) decide por dónde entrar:
 *  1. Si el server responde directo (WiFi de la oficina) -> sin túnel.
 *     Además, la primera vez da de alta el celular en la VPN con la sesión del usuario.
 *  2. Si no, y el celular ya está dado de alta -> levanta el túnel WireGuard.
 *  3. Si nunca se dio de alta -> pide abrir la app una vez en la oficina.
 */
public class MainActivity extends Activity {

    private Actualizador actualizador;

    private static final int REQ_VPN = 10, REQ_ARCHIVO = 11;
    private static final long PARAR_EN_FONDO_MS = 5 * 60_000;
    private static final String BG = "#030712";

    private final Handler h = new Handler(Looper.getMainLooper());
    private final ExecutorService exec = Executors.newSingleThreadExecutor();

    private WebView web;
    private LinearLayout panel;
    private ProgressBar spinner;
    private TextView titulo, detalle;
    private Button boton;

    private volatile boolean enLan;
    private boolean cargado, visible;
    private long creadoEn, enFondoDesde;
    private long ultimoIntentoAlta;
    private volatile boolean altaEnCurso;
    private ValueCallback<Uri[]> archivoCb;
    private ConnectivityManager.NetworkCallback redCb;

    // ------------------------------------------------------------------ ciclo de vida

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        creadoEn = System.currentTimeMillis();
        getWindow().setStatusBarColor(Color.parseColor(BG));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BG));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(BG));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(crearPanel(), new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        actualizador = new Actualizador(this, Config.BASE_URL, "/apk/vicki.json");

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " VickiApp/" + Config.VERSION);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Puente(), "VickiApp");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new Descargas());

        escucharRed();
        asegurar(false);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        h.removeCallbacks(pararEnFondo);
        // Volvió después de un rato: puede haber cambiado de red o bajado el túnel.
        if (enFondoDesde > 0 && System.currentTimeMillis() - enFondoDesde > 60_000) asegurar(false);
        enFondoDesde = 0;
    }

    @Override
    protected void onResume() {
        super.onResume();
        actualizador.enResume(); // sin red/túnel falla en silencio y reintenta al cargar la página
    }

    @Override
    protected void onPause() {
        actualizador.enPausa();
        super.onPause();
    }

    @Override
    protected void onStop() {
        visible = false;
        enFondoDesde = System.currentTimeMillis();
        CookieManager.getInstance().flush();
        h.postDelayed(pararEnFondo, PARAR_EN_FONDO_MS);
        super.onStop();
    }

    private final Runnable pararEnFondo = new Runnable() {
        @Override
        public void run() {
            if (!visible) {
                exec.execute(new Runnable() {
                    @Override
                    public void run() {
                        TunelService.detener();
                    }
                });
            }
        }
    };

    @Override
    protected void onDestroy() {
        h.removeCallbacksAndMessages(null);
        if (redCb != null) {
            try {
                ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(redCb);
            } catch (Exception ignored) {
            }
        }
        exec.execute(new Runnable() {
            @Override
            public void run() {
                TunelService.detener();
            }
        });
        exec.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_VPN) {
            if (res == RESULT_OK) asegurar(false);
            else estado("Falta el permiso de VPN",
                    "Vicki usa una VPN propia solo para llegar al servidor de la empresa. "
                            + "No toca el resto del celular.", "Dar permiso", false);
        } else if (req == REQ_ARCHIVO && archivoCb != null) {
            archivoCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            archivoCb = null;
        }
    }

    // ------------------------------------------------------------------ conexión

    /** Decide LAN / túnel / sin alta. Serializado en un solo hilo. */
    private void asegurar(final boolean recargar) {
        exec.execute(new Runnable() {
            @Override
            public void run() {
                if (!cargado) estado("Conectando…", "", null, true);

                if (TunelService.activo() && Red.alcanzable(2000)) {
                    enLan = false;
                    listo(recargar);
                    return;
                }
                TunelService.detener();
                if (Red.alcanzable(1500)) {
                    enLan = true;
                    listo(recargar);
                    return;
                }
                enLan = false;

                if (VpnConfig.leer(MainActivity.this) == null) {
                    estado("Activá Vicki en la oficina",
                            "La primera vez hay que abrir la app conectado al WiFi de la empresa "
                                    + "e iniciar sesión. Después funciona desde cualquier lado.",
                            "Reintentar", false);
                    return;
                }

                final Intent permiso = VpnService.prepare(MainActivity.this);
                if (permiso != null) {
                    h.post(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                startActivityForResult(permiso, REQ_VPN);
                            } catch (Exception e) {
                                estado("No se pudo pedir el permiso de VPN", String.valueOf(e.getMessage()),
                                        "Reintentar", false);
                            }
                        }
                    });
                    return;
                }

                estado("Conectando desde afuera…", "", null, true);
                TunelService.iniciar(MainActivity.this);
                long hasta = System.currentTimeMillis() + 12_000;
                while (System.currentTimeMillis() < hasta) {
                    dormir(700);
                    if (TunelService.ultimoHandshake() > 0 && Red.alcanzable(2000)) {
                        VpnConfig.marcarSinHandshake(MainActivity.this, false);
                        listo(recargar);
                        return;
                    }
                }
                boolean huboHandshake = TunelService.ultimoHandshake() > 0;
                if (!huboHandshake) VpnConfig.marcarSinHandshake(MainActivity.this, true);
                String err = TunelService.ultimoError;
                estado("No se pudo conectar con la oficina",
                        huboHandshake
                                ? "La VPN conectó pero el servidor no responde."
                                : "¿Hay internet? Si sigue, abrí la app una vez en el WiFi de la oficina "
                                        + "para renovar el acceso." + (err.isEmpty() ? "" : "\n(" + err + ")"),
                        "Reintentar", false);
            }
        });
    }

    private void listo(final boolean recargar) {
        h.post(new Runnable() {
            @Override
            public void run() {
                panel.setVisibility(View.GONE);
                if (!cargado) {
                    cargado = true;
                    web.loadUrl(Config.BASE_URL + "/");
                } else if (recargar) {
                    web.reload();
                }
            }
        });
    }

    /** Cambios de red (WiFi <-> datos): se vuelve a decidir por dónde entrar. */
    private void escucharRed() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build();
        redCb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                cambio();
            }

            @Override
            public void onLost(Network n) {
                cambio();
            }
        };
        try {
            cm.registerNetworkCallback(req, redCb);
        } catch (Exception ignored) {
        }
    }

    private final Runnable reevaluar = new Runnable() {
        @Override
        public void run() {
            if (visible) asegurar(true);
        }
    };

    private void cambio() {
        if (System.currentTimeMillis() - creadoEn < 4000) return; // callbacks iniciales
        h.removeCallbacks(reevaluar);
        h.postDelayed(reevaluar, 2000);
    }

    /** En la oficina y con sesión: da de alta el celular en la VPN (una vez). */
    private void quizasAlta() {
        if (!enLan || altaEnCurso) return;
        boolean necesita = VpnConfig.leer(this) == null || VpnConfig.sinHandshake(this);
        if (!necesita || System.currentTimeMillis() - ultimoIntentoAlta < 60_000) return;
        final String cookie = CookieManager.getInstance().getCookie(Config.BASE_URL);
        if (cookie == null || !cookie.contains("ever_session=")) return;
        altaEnCurso = true;
        ultimoIntentoAlta = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    VpnConfig cfg = Red.alta(MainActivity.this, cookie);
                    cfg.guardar(MainActivity.this);
                    aviso("Listo: ya podés usar Vicki fuera de la oficina");
                } catch (Exception e) {
                    // Sin permiso / Mikrotik caído: se reintenta en la próxima página (máx. 1 por minuto).
                    android.util.Log.w("VickiVPN", "alta: " + e.getMessage());
                } finally {
                    altaEnCurso = false;
                }
            }
        }, "vicki-alta").start();
    }

    // ------------------------------------------------------------------ UI

    private View crearPanel() {
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Color.parseColor(BG));
        int pad = dp(32);
        panel.setPadding(pad, pad, pad, pad);
        panel.setClickable(true);

        TextView marca = new TextView(this);
        marca.setText("vicki");
        marca.setTextColor(Color.parseColor("#facc15"));
        marca.setTextSize(34);
        marca.setTypeface(Typeface.DEFAULT_BOLD);
        marca.setGravity(Gravity.CENTER);
        panel.addView(marca);

        spinner = new ProgressBar(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(40), dp(40));
        sp.topMargin = dp(24);
        panel.addView(spinner, sp);

        titulo = new TextView(this);
        titulo.setTextColor(Color.parseColor("#e4e4e7"));
        titulo.setTextSize(18);
        titulo.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-1, -2);
        tp.topMargin = dp(20);
        panel.addView(titulo, tp);

        detalle = new TextView(this);
        detalle.setTextColor(Color.parseColor("#a1a1aa"));
        detalle.setTextSize(14);
        detalle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams dpp = new LinearLayout.LayoutParams(-1, -2);
        dpp.topMargin = dp(10);
        panel.addView(detalle, dpp);

        boton = new Button(this);
        boton.setTextColor(Color.parseColor("#030712"));
        boton.setBackgroundColor(Color.parseColor("#facc15"));
        boton.setAllCaps(false);
        boton.setTextSize(16);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(52));
        bp.topMargin = dp(28);
        panel.addView(boton, bp);
        boton.setPadding(dp(28), 0, dp(28), 0);
        boton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                asegurar(true);
            }
        });
        return panel;
    }

    private void estado(final String t, final String d, final String textoBoton, final boolean cargando) {
        h.post(new Runnable() {
            @Override
            public void run() {
                panel.setVisibility(View.VISIBLE);
                titulo.setText(t);
                detalle.setText(d);
                detalle.setVisibility(d.isEmpty() ? View.GONE : View.VISIBLE);
                spinner.setVisibility(cargando ? View.VISIBLE : View.GONE);
                boton.setVisibility(textoBoton == null ? View.GONE : View.VISIBLE);
                if (textoBoton != null) boton.setText(textoBoton);
            }
        });
    }

    private void aviso(final String msg) {
        h.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private static void dormir(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    // ------------------------------------------------------------------ WebView

    /** window.VickiApp.* */
    private class Puente {
        @JavascriptInterface
        public String version() {
            return Config.VERSION;
        }

        /** "lan" | "vpn" */
        @JavascriptInterface
        public String conexion() {
            return enLan ? "lan" : "vpn";
        }

        @JavascriptInterface
        public void reintentar() {
            asegurar(true);
        }

        @JavascriptInterface
        public void guardarArchivo(String base64, String mime, String nombre) {
            try {
                guardar(Base64.decode(base64, Base64.DEFAULT), mime, nombre);
            } catch (Exception e) {
                aviso("No se pudo guardar: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void errorDescarga(String msg) {
            aviso("No se pudo descargar: " + msg);
        }
    }

    /** Descargas hechas en el navegador (Excel con blob:) -> se leen en JS y pasan por el puente. */
    private static final String JS_DESCARGAS = "(function(){if(window.__vickiDl)return;window.__vickiDl=1;"
            + "function g(h,n){fetch(h).then(function(r){return r.blob()}).then(function(b){var f=new FileReader();"
            + "f.onload=function(){VickiApp.guardarArchivo(String(f.result).split(',')[1]||'',b.type||'',n||'descarga')};"
            + "f.readAsDataURL(b)}).catch(function(e){VickiApp.errorDescarga(String(e))})}"
            + "function es(a){return a&&a.href&&a.hasAttribute('download')&&(a.href.indexOf('blob:')===0||a.href.indexOf('data:')===0)}"
            + "var c=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){"
            + "if(es(this)){g(this.href,this.getAttribute('download'));return}return c.call(this)};"
            + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;"
            + "if(es(a)){e.preventDefault();g(a.href,a.getAttribute('download'))}},true)})()";

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
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            view.evaluateJavascript(JS_DESCARGAS, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(JS_DESCARGAS, null);
            CookieManager.getInstance().flush();
            quizasAlta();
            actualizador.revisar();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            cargado = false;
            view.loadUrl("about:blank");
            asegurar(true);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (archivoCb != null) archivoCb.onReceiveValue(null);
            archivoCb = cb;
            try {
                startActivityForResult(p.createIntent(), REQ_ARCHIVO);
                return true;
            } catch (Exception e) {
                archivoCb = null;
                return false;
            }
        }
    }

    /** Descargas por URL (con la cookie de la sesión, por la misma red/túnel de la app). */
    private class Descargas implements DownloadListener {
        @Override
        public void onDownloadStart(final String url, String ua, final String disp, final String mime, long len) {
            if (url.startsWith("blob:") || url.startsWith("data:")) return; // lo maneja JS_DESCARGAS
            final String nombre = URLUtil.guessFileName(url, disp, mime);
            aviso("Descargando " + nombre + "…");
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                        String ck = CookieManager.getInstance().getCookie(url);
                        if (ck != null) c.setRequestProperty("Cookie", ck);
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(60000);
                        InputStream in = c.getInputStream();
                        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                        in.close();
                        guardar(b.toByteArray(), c.getContentType(), nombre);
                    } catch (Exception e) {
                        aviso("No se pudo descargar: " + e.getMessage());
                    }
                }
            }).start();
        }
    }

    /** Guarda en Descargas/Vicki y lo abre si hay una app para ese tipo. */
    private void guardar(byte[] datos, String mime, String nombre) throws Exception {
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        int pc = mime.indexOf(';');
        if (pc > 0) mime = mime.substring(0, pc).trim();
        nombre = nombre.replaceAll("[\\\\/:*?\"<>|]", "_");
        Uri abrir = null;
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, nombre);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Vicki");
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("MediaStore");
            OutputStream os = getContentResolver().openOutputStream(uri);
            os.write(datos);
            os.close();
            abrir = uri;
        } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getFilesDir();
            File f = new File(dir, nombre);
            FileOutputStream os = new FileOutputStream(f);
            os.write(datos);
            os.close();
            aviso("Guardado en " + f.getAbsolutePath());
            return;
        }
        aviso("Guardado en Descargas/Vicki: " + nombre);
        try {
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(abrir, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) {
            // no hay app para abrirlo: queda en Descargas
        }
    }
}
