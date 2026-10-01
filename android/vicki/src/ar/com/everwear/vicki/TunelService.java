package ar.com.everwear.vicki;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import android.util.Base64;
import android.util.Log;

import java.io.FileDescriptor;
import java.io.IOException;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;

import ar.com.everwear.vicki.wg.WgTunnel;

/**
 * VPN propia de la app: WireGuard en Java (wg/WgTunnel) sobre la interfaz
 * que da VpnService. Solo enruta lo que diga la config (10.10.0.159/32) y
 * solo para ESTA app (addAllowedApplication): el resto del celular no se entera.
 */
public class TunelService extends VpnService {
    private static final String TAG = "VickiVPN";
    static final String PARAR = "parar";

    static volatile TunelService inst;
    static volatile String ultimoError = "";

    private final Object lk = new Object();
    private ParcelFileDescriptor pfd;
    private WgTunnel wg;

    static void iniciar(Context c) {
        c.startService(new Intent(c, TunelService.class));
    }

    static boolean activo() {
        TunelService s = inst;
        return s != null && s.wg != null;
    }

    static long ultimoHandshake() {
        TunelService s = inst;
        WgTunnel w = s == null ? null : s.wg;
        return w == null ? 0 : w.lastHandshakeMs();
    }

    /** Baja el túnel (sincrónico). */
    static void detener() {
        TunelService s = inst;
        if (s != null) s.parar();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && PARAR.equals(intent.getAction())) {
            parar();
            return START_NOT_STICKY;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                arrancar();
            }
        }, "vicki-vpn-start").start();
        return START_NOT_STICKY;
    }

    private void arrancar() {
        synchronized (lk) {
            if (wg != null) return;
            VpnConfig cfg = VpnConfig.leer(this);
            if (cfg == null) {
                ultimoError = "El celular todavía no está dado de alta";
                return;
            }
            try {
                InetAddress ep = InetAddress.getByName(cfg.endpoint);

                Builder b = new Builder();
                b.setSession("Vicki");
                b.addAddress(cfg.address, 32);
                for (String r : cfg.allowedIps) {
                    String[] p = r.trim().split("/");
                    if (p[0].isEmpty()) continue;
                    b.addRoute(p[0], p.length > 1 ? Integer.parseInt(p[1]) : 32);
                }
                b.setMtu(1280);
                b.setBlocking(true);
                b.addAllowedApplication(getPackageName());
                if (Build.VERSION.SDK_INT >= 29) b.setMetered(false);
                b.setConfigureIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
                pfd = b.establish();
                if (pfd == null) {
                    ultimoError = "Falta aceptar el permiso de VPN";
                    return;
                }

                DatagramSocket sock = new DatagramSocket();
                protect(sock);

                WgTunnel.Config c = new WgTunnel.Config();
                c.privateKey = Base64.decode(cfg.privateKey, Base64.DEFAULT);
                c.peerPublicKey = Base64.decode(cfg.serverPublicKey, Base64.DEFAULT);
                c.endpoint = new InetSocketAddress(ep, cfg.port);
                c.keepaliveSec = cfg.keepalive;
                c.allowedIps = cfg.allowedIps;

                wg = new WgTunnel(c, new AndroidTun(pfd.getFileDescriptor()), sock, new WgTunnel.Listener() {
                    @Override
                    public void onHandshake(long whenMs) {
                        ultimoError = "";
                    }

                    @Override
                    public void onError(String msg) {
                        Log.w(TAG, msg);
                        ultimoError = msg;
                    }
                });
                wg.start();
                ultimoError = "";
            } catch (Exception e) {
                Log.w(TAG, "no arrancó", e);
                ultimoError = e.getClass().getSimpleName().equals("UnknownHostException")
                        ? "Sin internet (no se resuelve " + cfg.endpoint + ")"
                        : String.valueOf(e.getMessage());
                cerrar();
            }
        }
    }

    void parar() {
        synchronized (lk) {
            cerrar();
        }
        stopSelf();
    }

    private void cerrar() {
        if (wg != null) {
            wg.stop();
            wg = null;
        }
        if (pfd != null) {
            try {
                pfd.close();
            } catch (IOException ignored) {
            }
            pfd = null;
        }
    }

    @Override
    public void onRevoke() {
        parar();
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        synchronized (lk) {
            cerrar();
        }
        if (inst == this) inst = null;
        super.onDestroy();
    }

    /** tun con poll(500 ms) para que el hilo lector pueda terminar al parar. */
    private static final class AndroidTun implements WgTunnel.Tun {
        private final FileDescriptor fd;
        private final StructPollfd[] pf;

        AndroidTun(FileDescriptor fd) {
            this.fd = fd;
            StructPollfd p = new StructPollfd();
            p.fd = fd;
            p.events = (short) OsConstants.POLLIN;
            pf = new StructPollfd[] {p};
        }

        @Override
        public int read(byte[] buf) throws IOException {
            try {
                pf[0].revents = 0;
                if (Os.poll(pf, 500) <= 0) return 0;
                if ((pf[0].revents & (OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL)) != 0) {
                    throw new IOException("tun cerrado");
                }
                return Os.read(fd, buf, 0, buf.length);
            } catch (ErrnoException e) {
                if (e.errno == OsConstants.EINTR || e.errno == OsConstants.EAGAIN) return 0;
                throw new IOException(e.getMessage());
            }
        }

        @Override
        public void write(byte[] buf, int off, int len) throws IOException {
            try {
                Os.write(fd, buf, off, len);
            } catch (ErrnoException e) {
                throw new IOException(e.getMessage());
            }
        }
    }
}
