package com.bomeralounge.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Cihaz açıldığında Bomera TV ekranını başlatır (bazı Android sürümlerinde sistem buna izin vermeyebilir). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent i = new Intent(context, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { context.startActivity(i); } catch (Exception ignored) { }
    }
}
