package ar.com.everwear.vicki;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/** Config del túnel que devuelve POST /api/vpn/alta, guardada en SharedPreferences (privadas de la app). */
final class VpnConfig {
    String privateKey, address, serverPublicKey, endpoint;
    int port, keepalive;
    String[] allowedIps;

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("vpn", Context.MODE_PRIVATE);
    }

    static VpnConfig leer(Context c) {
        SharedPreferences p = sp(c);
        String pk = p.getString("privateKey", null);
        if (pk == null) return null;
        VpnConfig v = new VpnConfig();
        v.privateKey = pk;
        v.address = p.getString("address", "");
        v.serverPublicKey = p.getString("serverPublicKey", "");
        v.endpoint = p.getString("endpoint", "");
        v.port = p.getInt("port", 13231);
        v.keepalive = p.getInt("keepalive", 25);
        v.allowedIps = p.getString("allowedIps", "").split(",");
        return v;
    }

    static VpnConfig desdeJson(JSONObject j) throws Exception {
        VpnConfig v = new VpnConfig();
        v.privateKey = j.getString("privateKey");
        v.address = j.getString("address");
        v.serverPublicKey = j.getString("serverPublicKey");
        v.endpoint = j.getString("endpoint");
        v.port = j.getInt("port");
        v.keepalive = j.optInt("keepalive", 25);
        JSONArray a = j.getJSONArray("allowedIps");
        v.allowedIps = new String[a.length()];
        for (int i = 0; i < a.length(); i++) v.allowedIps[i] = a.getString(i);
        if (v.privateKey.length() != 44 || v.serverPublicKey.length() != 44) throw new Exception("claves inválidas");
        return v;
    }

    /** Código "VICKI1.<base64url del JSON>" generado por el admin en /admin/vpn (alta remota). */
    static VpnConfig desdeCodigo(String codigo) throws Exception {
        String t = codigo == null ? "" : codigo.trim();
        int i = t.indexOf("VICKI1.");
        if (i < 0) throw new Exception("El código no es válido");
        t = t.substring(i + 7).replaceAll("[^A-Za-z0-9_-]", "");
        byte[] b = android.util.Base64.decode(t, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING);
        return desdeJson(new JSONObject(new String(b, "UTF-8")));
    }

    void guardar(Context c) {
        StringBuilder ips = new StringBuilder();
        for (String s : allowedIps) {
            if (ips.length() > 0) ips.append(',');
            ips.append(s.trim());
        }
        sp(c).edit()
                .putString("privateKey", privateKey)
                .putString("address", address)
                .putString("serverPublicKey", serverPublicKey)
                .putString("endpoint", endpoint)
                .putInt("port", port)
                .putInt("keepalive", keepalive)
                .putString("allowedIps", ips.toString())
                .putBoolean("sinHandshake", false)
                .apply();
    }

    /** Se marca cuando el túnel no logra handshake: en el próximo WiFi de oficina se vuelve a dar de alta. */
    static void marcarSinHandshake(Context c, boolean v) {
        sp(c).edit().putBoolean("sinHandshake", v).apply();
    }

    static boolean sinHandshake(Context c) {
        return sp(c).getBoolean("sinHandshake", false);
    }
}
