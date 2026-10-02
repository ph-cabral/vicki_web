package ar.com.everwear.comun;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * Resultado de la sesión de PackageInstaller que abre Actualizador.
 * - PENDING_USER_ACTION: abre el diálogo del sistema "¿Actualizar esta app?" (la app está al frente).
 * - SUCCESS: nada (el proceso viejo ya murió; el picker se re-levanta con MY_PACKAGE_REPLACED).
 * - error / cancelado: devuelve el botón a "Actualizar" con el motivo.
 * Declarado en el AndroidManifest de cada app (exported=false).
 */
public class InstalarReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmar != null) {
                confirmar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(confirmar);
                    return;
                } catch (Exception ignored) {
                }
            }
            avisar("no se pudo abrir el instalador");
            return;
        }
        if (st == PackageInstaller.STATUS_SUCCESS) return;

        String msg;
        switch (st) {
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                msg = ""; // tocó Cancelar
                break;
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                msg = "la versión instalada tiene otra firma: desinstalala y bajá el APK de nuevo";
                break;
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                msg = "no hay espacio en el equipo";
                break;
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                msg = "el equipo bloqueó la instalación";
                break;
            default:
                String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                msg = m == null ? "error " + st : m;
        }
        avisar(msg);
    }

    private static void avisar(String msg) {
        Actualizador a = Actualizador.actual.get();
        if (a != null) a.fallo(msg);
    }
}
