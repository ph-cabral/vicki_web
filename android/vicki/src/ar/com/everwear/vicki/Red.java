package ar.com.everwear.vicki;

import android.content.Context;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;

/** Chequeo de alcance del server y alta del dispositivo en la VPN. */
final class Red {
    private Red() {}

    static final String HOST;
    static final int PUERTO;

    static {
        URL u;
        try {
            u = new URL(Config.BASE_URL);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        HOST = u.getHost();
        PUERTO = u.getPort() > 0 ? u.getPort() : u.getDefaultPort();
    }

    /** ¿Se llega al server de vicki? (TCP, sin HTTP: es lo más rápido). */
    static boolean alcanzable(int timeoutMs) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(HOST, PUERTO), timeoutMs);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    static String idDispositivo(Context c) {
        String id = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID);
        return id == null ? "desconocido" : id;
    }

    /** POST /api/vpn/alta con la cookie de sesión del WebView. Devuelve la config o tira con el motivo. */
    static VpnConfig alta(Context c, String cookie) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(Config.BASE_URL + "/api/vpn/alta").openConnection();
        h.setConnectTimeout(5000);
        h.setReadTimeout(15000);
        h.setRequestMethod("POST");
        h.setDoOutput(true);
        h.setRequestProperty("Content-Type", "application/json");
        h.setRequestProperty("Cookie", cookie);
        JSONObject body = new JSONObject();
        body.put("dispositivo", idDispositivo(c));
        body.put("modelo", Build.MANUFACTURER + " " + Build.MODEL);
        OutputStream os = h.getOutputStream();
        os.write(body.toString().getBytes("UTF-8"));
        os.close();
        int code = h.getResponseCode();
        String txt = leer(code >= 400 ? h.getErrorStream() : h.getInputStream());
        h.disconnect();
        JSONObject j = new JSONObject(txt.isEmpty() ? "{}" : txt);
        if (code != 200) throw new Exception(j.optString("error", "HTTP " + code));
        return VpnConfig.desdeJson(j);
    }

    static String leer(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }
}
