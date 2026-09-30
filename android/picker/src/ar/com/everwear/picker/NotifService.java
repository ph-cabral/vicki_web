package ar.com.everwear.picker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Servicio en primer plano que mantiene abierto el stream SSE
 * GET {BASE_URL}/api/picking/notificaciones?picker=<nombre>&desde=<ultimoId>
 * y muestra cada mensaje como notificación Android con sonido y vibración,
 * con la app cerrada o el equipo bloqueado. Reemplaza a la app ntfy.
 */
public class NotifService extends Service {

    private static final int ID_FG = 1;
    private static final String CANAL_ESTADO = "estado";
    private static final String CANAL_RESPUESTAS = "respuestas_v1";
    private static final String CANAL_SIN_EXISTENCIA = "sin_existencia_v1";

    private Conexion conexion;
    private WifiManager.WifiLock wifiLock;
    private ConnectivityManager.NetworkCallback redCallback;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        crearCanales();

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "everwear:picker");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }

        // Volvió la red -> reconectar ya, sin esperar el backoff.
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm != null) {
            redCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    Conexion c = conexion;
                    if (c != null) c.despertar();
                }
            };
            try {
                cm.registerDefaultNetworkCallback(redCallback);
            } catch (Exception ignored) {
                redCallback = null;
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String nombre = Prefs.nombre(this);
        // startForeground siempre primero: si no, Android mata la app por no cumplir el plazo.
        ponerEnPrimerPlano(nombre.isEmpty() ? "Sin picker" : "Conectando como " + nombre);

        if (nombre.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (conexion == null || !conexion.nombre.equals(nombre)) {
            if (conexion != null) conexion.cerrar();
            conexion = new Conexion(nombre);
            new Thread(conexion, "sse-picker").start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (conexion != null) conexion.cerrar();
        conexion = null;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (redCallback != null) {
            try {
                ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(redCallback);
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- notificaciones

    private void crearCanales() {
        NotificationManager nm = getSystemService(NotificationManager.class);

        NotificationChannel estado = new NotificationChannel(
                CANAL_ESTADO, "Conexión con el servidor", NotificationManager.IMPORTANCE_MIN);
        estado.setShowBadge(false);
        nm.createNotificationChannel(estado);

        NotificationChannel resp = new NotificationChannel(
                CANAL_RESPUESTAS, "Respuestas de gerencia", NotificationManager.IMPORTANCE_HIGH);
        resp.enableVibration(true);
        resp.setVibrationPattern(new long[] {0, 400, 200, 400});
        resp.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(resp);

        NotificationChannel sinEx = new NotificationChannel(
                CANAL_SIN_EXISTENCIA, "Sin existencia", NotificationManager.IMPORTANCE_HIGH);
        sinEx.enableVibration(true);
        sinEx.setVibrationPattern(new long[] {0, 800, 300, 800, 300, 800});
        sinEx.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(sinEx);
    }

    private PendingIntent abrirApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification notifEstado(String texto) {
        return new Notification.Builder(this, CANAL_ESTADO)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("EverWear Picker")
                .setContentText(texto)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(abrirApp())
                .build();
    }

    private void ponerEnPrimerPlano(String texto) {
        Notification n = notifEstado(texto);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_FG, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(ID_FG, n);
        }
    }

    private void actualizarEstado(String texto) {
        getSystemService(NotificationManager.class).notify(ID_FG, notifEstado(texto));
    }

    private void mostrar(JSONObject j) {
        long id = j.optLong("id");
        String titulo = j.optString("titulo", "EverWear");
        String cuerpo = j.optString("cuerpo", "");
        boolean urgente = "high".equals(j.optString("prioridad"));

        Notification n = new Notification.Builder(this, urgente ? CANAL_SIN_EXISTENCIA : CANAL_RESPUESTAS)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(titulo)
                .setContentText(cuerpo)
                .setStyle(new Notification.BigTextStyle().bigText(cuerpo))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setWhen(j.optLong("ts", System.currentTimeMillis()))
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(abrirApp())
                .build();
        getSystemService(NotificationManager.class).notify((int) (id % 1_000_000_000L) + 10, n);

        // Prende la pantalla unos segundos para que el picker vea el aviso.
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP
                            | PowerManager.ON_AFTER_RELEASE,
                    "everwear:aviso");
            wl.acquire(5000);
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- conexión SSE

    private class Conexion implements Runnable {
        final String nombre;
        private volatile boolean activa = true;
        private volatile boolean conectado = false;
        private volatile HttpURLConnection http;
        private volatile Thread hilo;
        private volatile long espera = 2000;

        Conexion(String nombre) {
            this.nombre = nombre;
        }

        void cerrar() {
            activa = false;
            HttpURLConnection h = http;
            if (h != null) h.disconnect();
            Thread t = hilo;
            if (t != null) t.interrupt();
        }

        /** La red volvió: si estaba esperando para reintentar, reintenta ya. */
        void despertar() {
            if (conectado) return;
            espera = 1000;
            Thread t = hilo;
            if (t != null) t.interrupt();
        }

        @Override
        public void run() {
            hilo = Thread.currentThread();
            while (activa) {
                try {
                    escuchar();
                } catch (Exception e) {
                    // cae abajo: reintento
                } finally {
                    conectado = false;
                    HttpURLConnection h = http;
                    if (h != null) h.disconnect();
                    http = null;
                }
                if (!activa) break;
                actualizarEstado("Sin conexión con el servidor — reintentando");
                try {
                    Thread.sleep(espera);
                } catch (InterruptedException ignored) {
                    // despertar() o cerrar()
                }
                espera = Math.min(espera * 2, 30000);
            }
        }

        private void escuchar() throws Exception {
            long desde = Prefs.ultimoId(NotifService.this, nombre);
            URL url = new URL(Config.BASE_URL + "/api/picking/notificaciones?picker="
                    + URLEncoder.encode(nombre, "UTF-8") + "&desde=" + desde);
            HttpURLConnection h = (HttpURLConnection) url.openConnection();
            http = h;
            h.setConnectTimeout(10000);
            h.setReadTimeout(60000); // el server manda ping cada 20 s
            h.setUseCaches(false);
            h.setRequestProperty("Accept", "text/event-stream");
            int code = h.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);

            conectado = true;
            espera = 2000;
            actualizarEstado("Conectado como " + nombre);

            BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), "UTF-8"));
            StringBuilder data = new StringBuilder();
            String linea;
            while (activa && (linea = r.readLine()) != null) {
                if (linea.isEmpty()) {
                    if (data.length() > 0) procesar(data.toString());
                    data.setLength(0);
                } else if (linea.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(linea.substring(5).trim());
                }
                // "id:", "event:", "retry:" y comentarios ": ping" se ignoran (el id viene en el JSON)
            }
        }

        private void procesar(String json) {
            try {
                JSONObject j = new JSONObject(json);
                long id = j.optLong("id");
                if (id <= Prefs.ultimoId(NotifService.this, nombre)) return;
                Prefs.setUltimoId(NotifService.this, nombre, id);
                mostrar(j);
            } catch (Exception ignored) {
            }
        }
    }
}
