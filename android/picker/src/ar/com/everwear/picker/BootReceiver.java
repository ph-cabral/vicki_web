package ar.com.everwear.picker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Al prender el equipo o actualizar la app, vuelve a levantar el servicio si hay picker. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Prefs.nombre(context).isEmpty()) {
            try {
                context.startForegroundService(new Intent(context, NotifService.class));
            } catch (Exception ignored) {
                // si el sistema no deja arrancarlo ahora, arranca al abrir la app
            }
        }
    }
}
