package ar.com.everwear.comun;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Auto-actualización de las apps EverWear (picker, mostrador, vicki).
 *
 * El server publica junto a cada APK un JSON (lo escribe build.sh):
 *   /apk/&lt;app&gt;.json = {paquete, versionCode, versionName, apk, sha256, bytes, obligatoria, notas}
 * La app lo consulta al volver al frente, al terminar de cargar la página y cada 30 min.
 * Si versionCode &gt; instalada muestra una barra abajo ("Actualizar") o, si es obligatoria,
 * una pantalla que tapa todo. El botón baja el APK, verifica sha256 e instala con
 * PackageInstaller (misma firma). En Android 12+ desde la segunda actualización no pide
 * confirmación (la app ya es "instaladora de sí misma"); la primera vez muestra el diálogo del sistema.
 */
public final class Actualizador {

    private static final long CADA_OK_MS = 10 * 60_000L;   // no consultar más seguido que esto
    private static final long CADA_ERR_MS = 20_000L;       // reintento si falló (p.ej. túnel subiendo)
    private static final long TICK_MS = 30 * 60_000L;      // app abierta todo el día (mostrador, picker)

    private static final String AMARILLO = "#facc15";

    /** La activity viva, para que InstalarReceiver le avise si la instalación falló. */
    static WeakReference<Actualizador> actual = new WeakReference<>(null);

    private final Activity act;
    private final String base;     // BASE_URL sin barra final
    private final String rutaJson; // p.ej. "/apk/everwear-picker.json"
    private final Handler h = new Handler(Looper.getMainLooper());

    private volatile boolean buscando;
    private boolean descargando;
    private long ultimoOk, ultimoError;
    private JSONObject disponible;
    private boolean descartada;
    private boolean esperandoPermiso;
    private boolean resumida;
    private volatile long commitEn; // cuándo se mandó la sesión al instalador

    private View vista;
    private Button boton;

    public Actualizador(Activity act, String baseUrl, String rutaJson) {
        this.act = act;
        this.base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.rutaJson = rutaJson;
        actual = new WeakReference<>(this);
    }

    // ------------------------------------------------------------------ ciclo de vida

    public void enResume() {
        resumida = true;
        actual = new WeakReference<>(this);
        // Volvió del diálogo del sistema sin instalar (tocó afuera / Atrás): liberar el botón.
        if (descargando && commitEn > 0 && SystemClock.elapsedRealtime() - commitEn > 1500) fallo(null);
        if (esperandoPermiso) {
            esperandoPermiso = false;
            if (act.getPackageManager().canRequestPackageInstalls()) actualizar();
        }
        revisar();
        h.removeCallbacks(tick);
        h.postDelayed(tick, TICK_MS);
    }

    public void enPausa() {
        resumida = false;
        h.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!resumida) return;
            revisar();
            h.postDelayed(this, TICK_MS);
        }
    };

    /** Consulta el JSON (con throttle). Se puede llamar seguido: onPageFinished, onResume, etc. */
    public void revisar() {
        if (buscando || descargando) return;
        long ahora = SystemClock.elapsedRealtime();
        if (ultimoOk > 0 && ahora - ultimoOk < CADA_OK_MS) return;
        if (ultimoError > 0 && ahora - ultimoError < CADA_ERR_MS) return;
        buscando = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String txt = new String(bajar(base + rutaJson + "?t=" + System.currentTimeMillis(), 64 * 1024), "UTF-8");
                    final JSONObject j = new JSONObject(txt);
                    String paq = j.optString("paquete", act.getPackageName());
                    final boolean hay = paq.equals(act.getPackageName())
                            && j.optLong("versionCode", 0) > versionInstalada();
                    ultimoOk = SystemClock.elapsedRealtime();
                    ultimoError = 0;
                    h.post(new Runnable() {
                        @Override
                        public void run() {
                            if (hay) mostrar(j);
                            else ocultar();
                        }
                    });
                } catch (Exception e) {
                    ultimoError = SystemClock.elapsedRealtime();
                } finally {
                    buscando = false;
                }
            }
        }, "actualizador").start();
    }

    private long versionInstalada() throws Exception {
        PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    // ------------------------------------------------------------------ UI

    private int dp(int v) {
        return Math.round(v * act.getResources().getDisplayMetrics().density);
    }

    private void ocultar() {
        disponible = null;
        quitarVista();
    }

    private void quitarVista() {
        if (vista != null && vista.getParent() instanceof ViewGroup) ((ViewGroup) vista.getParent()).removeView(vista);
        vista = null;
        boton = null;
    }

    private void mostrar(JSONObject j) {
        if (act.isFinishing() || act.isDestroyed() || descargando) return;
        boolean oblig = j.optBoolean("obligatoria", false);
        if (descartada && !oblig) return;
        disponible = j;
        quitarVista();

        String vn = j.optString("versionName", "");
        String notas = j.optString("notas", "").trim();
        ViewGroup raiz = (ViewGroup) act.findViewById(android.R.id.content);

        boton = new Button(act);
        boton.setText("Actualizar");
        boton.setAllCaps(false);
        boton.setTextSize(17);
        boton.setTypeface(Typeface.DEFAULT_BOLD);
        boton.setTextColor(Color.BLACK);
        GradientDrawable fondoBoton = new GradientDrawable();
        fondoBoton.setColor(Color.parseColor(AMARILLO));
        fondoBoton.setCornerRadius(dp(8));
        boton.setBackground(fondoBoton);
        boton.setPadding(dp(20), dp(10), dp(20), dp(10));
        boton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                actualizar();
            }
        });

        if (oblig) {
            LinearLayout col = new LinearLayout(act);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setGravity(Gravity.CENTER);
            col.setBackgroundColor(Color.parseColor("#f2030712"));
            col.setPadding(dp(28), dp(28), dp(28), dp(28));
            col.setClickable(true); // tapa la página: no se puede seguir sin actualizar

            TextView t = texto("Hay una versión nueva de la app", 21, "#f4f4f5");
            t.setTypeface(Typeface.DEFAULT_BOLD);
            col.addView(t);
            col.addView(texto("Para seguir usándola hay que actualizar" + (vn.isEmpty() ? "." : " a la " + vn + "."), 15, "#a1a1aa"));
            if (!notas.isEmpty()) col.addView(texto(notas, 14, "#d4d4d8"));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = dp(24);
            col.addView(boton, lp);
            vista = col;
            raiz.addView(col, new FrameLayout.LayoutParams(-1, -1));
        } else {
            LinearLayout barra = new LinearLayout(act);
            barra.setOrientation(LinearLayout.HORIZONTAL);
            barra.setGravity(Gravity.CENTER_VERTICAL);
            barra.setBackgroundColor(Color.parseColor("#18181b"));
            barra.setPadding(dp(14), dp(10), dp(8), dp(10));
            barra.setClickable(true);
            if (Build.VERSION.SDK_INT >= 21) barra.setElevation(dp(8));

            LinearLayout txt = new LinearLayout(act);
            txt.setOrientation(LinearLayout.VERTICAL);
            TextView t = texto("Nueva versión" + (vn.isEmpty() ? "" : " " + vn), 15, "#f4f4f5");
            t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.START);
            txt.addView(t);
            TextView n = texto(notas.isEmpty() ? "Tocá Actualizar, tarda unos segundos" : notas, 12, "#a1a1aa");
            n.setGravity(Gravity.START);
            n.setMaxLines(2);
            txt.addView(n);
            barra.addView(txt, new LinearLayout.LayoutParams(0, -2, 1f));
            barra.addView(boton, new LinearLayout.LayoutParams(-2, -2));

            TextView cerrar = texto("✕", 18, "#71717a");
            cerrar.setPadding(dp(14), dp(6), dp(8), dp(6));
            cerrar.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    descartada = true; // vuelve a aparecer la próxima vez que se abra la app
                    quitarVista();
                }
            });
            barra.addView(cerrar, new LinearLayout.LayoutParams(-2, -2));
            vista = barra;
            raiz.addView(barra, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        }
    }

    private TextView texto(String s, int sp, String color) {
        TextView t = new TextView(act);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(Color.parseColor(color));
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private void estadoBoton(String s, boolean habilitado) {
        if (boton == null) return;
        boton.setText(s);
        boton.setEnabled(habilitado);
        boton.setAlpha(habilitado ? 1f : 0.7f);
    }

    // ------------------------------------------------------------------ descarga + instalación

    private void actualizar() {
        if (descargando || disponible == null) return;
        if (!act.getPackageManager().canRequestPackageInstalls()) {
            // Una sola vez por equipo: "Permitir de esta fuente".
            esperandoPermiso = true;
            Toast.makeText(act, "Activá \"Permitir de esta fuente\" y volvé con Atrás", Toast.LENGTH_LONG).show();
            try {
                act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + act.getPackageName())));
            } catch (Exception e) {
                esperandoPermiso = false;
                descargarEInstalar();
            }
            return;
        }
        descargarEInstalar();
    }

    /** Si no hay pantalla de permiso, el instalador del sistema lo pide solo. */
    private void descargarEInstalar() {
        final JSONObject j = disponible;
        descargando = true;
        estadoBoton("Descargando…", false);
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String apk = j.getString("apk");
                    String url = apk.startsWith("http") ? apk : base + (apk.startsWith("/") ? "" : "/") + apk;
                    File f = new File(act.getCacheDir(), "actualizacion.apk");
                    String sha = descargar(url, f, j.optLong("bytes", 0));
                    String esperado = j.optString("sha256", "");
                    if (!esperado.isEmpty() && !esperado.equalsIgnoreCase(sha)) {
                        f.delete();
                        throw new Exception("el archivo bajó incompleto, probá de nuevo");
                    }
                    h.post(new Runnable() {
                        @Override
                        public void run() {
                            estadoBoton("Instalando…", false);
                        }
                    });
                    instalar(f);
                } catch (final Exception e) {
                    h.post(new Runnable() {
                        @Override
                        public void run() {
                            fallo(e.getMessage());
                        }
                    });
                }
            }
        }, "actualizador-dl").start();
    }

    /** Llamado también por InstalarReceiver (cancelado / error del sistema). */
    void fallo(String msg) {
        descargando = false;
        commitEn = 0;
        estadoBoton("Actualizar", true);
        if (msg != null && !msg.isEmpty()) {
            Toast.makeText(act, "No se pudo actualizar: " + msg, Toast.LENGTH_LONG).show();
        }
    }

    private String descargar(String url, File destino, long esperado) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(20000);
        c.setUseCaches(false);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : esperado;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            InputStream in = c.getInputStream();
            OutputStream out = new FileOutputStream(destino);
            try {
                byte[] buf = new byte[16384];
                long leido = 0;
                int ultimoPct = -1, n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    md.update(buf, 0, n);
                    leido += n;
                    if (total > 0) {
                        final int pct = (int) Math.min(100, leido * 100 / total);
                        if (pct / 5 != ultimoPct / 5) {
                            ultimoPct = pct;
                            h.post(new Runnable() {
                                @Override
                                public void run() {
                                    estadoBoton("Descargando " + pct + "%", false);
                                }
                            });
                        }
                    }
                }
            } finally {
                out.close();
                in.close();
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    private void instalar(File f) throws Exception {
        PackageInstaller pi = act.getPackageManager().getPackageInstaller();
        for (PackageInstaller.SessionInfo si : pi.getMySessions()) {
            try {
                pi.abandonSession(si.getSessionId()); // restos de un intento anterior
            } catch (Exception ignored) {
            }
        }
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(act.getPackageName());
        p.setSize(f.length());
        if (Build.VERSION.SDK_INT >= 31) {
            // Android 12+: sin diálogo si la app es su propia instaladora (desde la 2da actualización).
            p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = pi.createSession(p);
        PackageInstaller.Session s = pi.openSession(id);
        try {
            OutputStream out = s.openWrite("app.apk", 0, f.length());
            InputStream in = new FileInputStream(f);
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            } finally {
                in.close();
                out.close();
            }
            Intent i = new Intent(act, InstalarReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent cb = PendingIntent.getBroadcast(act, id, i, flags);
            commitEn = SystemClock.elapsedRealtime();
            s.commit(cb.getIntentSender());
        } catch (Exception e) {
            s.abandon();
            throw e;
        } finally {
            s.close();
            f.delete();
        }
    }

    // ------------------------------------------------------------------ http

    private static byte[] bajar(String url, int max) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(8000);
        c.setUseCaches(false);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (bo.size() > max) throw new Exception("respuesta demasiado grande");
            }
            in.close();
            return bo.toByteArray();
        } finally {
            c.disconnect();
        }
    }
}
