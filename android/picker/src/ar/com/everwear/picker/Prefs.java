package ar.com.everwear.picker;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/** Nombre del picker (el mismo que la página guarda en localStorage) y último id recibido. */
final class Prefs {
    private static final String ARCHIVO = "picker";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(ARCHIVO, Context.MODE_PRIVATE);
    }

    static String nombre(Context c) {
        String n = sp(c).getString("nombre", "");
        return n == null ? "" : n.trim();
    }

    /** Guarda el nombre y prende/apaga el servicio. Devuelve true si cambió. */
    static boolean aplicarNombre(Context c, String nuevo) {
        String n = nuevo == null ? "" : nuevo.trim();
        boolean cambio = !n.equals(nombre(c));
        if (cambio) sp(c).edit().putString("nombre", n).apply();
        Intent i = new Intent(c, NotifService.class);
        if (n.isEmpty()) {
            c.stopService(i);
        } else {
            c.startForegroundService(i);
        }
        return cambio;
    }

    static long ultimoId(Context c, String nombre) {
        return sp(c).getLong("ultimo_" + nombre.toLowerCase(), 0L);
    }

    static void setUltimoId(Context c, String nombre, long id) {
        sp(c).edit().putLong("ultimo_" + nombre.toLowerCase(), id).apply();
    }
}
