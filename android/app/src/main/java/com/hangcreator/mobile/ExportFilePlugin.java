package com.hangcreator.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Save a generated cache export using Android's system document picker. */
@CapacitorPlugin(name = "ExportFile")
public class ExportFilePlugin extends Plugin {
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void save(PluginCall call) {
        if (!busy.compareAndSet(false, true)) {
            call.reject("Дождитесь завершения текущего экспорта.", "EXPORT_BUSY");
            return;
        }
        try {
            File source = validatedSource(call.getString("source"));
            String name = call.getString("name", source.getName());
            String mime = call.getString("mime", "application/octet-stream");
            validateNameAndMime(name, mime);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime);
            intent.putExtra(Intent.EXTRA_TITLE, name);
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "documentCreated"); }
                catch (Exception error) {
                    busy.set(false);
                    call.reject("Не удалось открыть окно сохранения файла.", "EXPORT_PICKER_FAILED", error);
                }
            });
        } catch (Exception error) {
            busy.set(false);
            call.reject("Некорректный файл для экспорта.", "EXPORT_INVALID_SOURCE", error);
        }
    }

    @ActivityCallback
    private void documentCreated(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        if (result.getResultCode() != Activity.RESULT_OK) {
            busy.set(false);
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        Uri destination = result.getData() == null ? null : result.getData().getData();
        if (destination == null || !"content".equals(destination.getScheme())) {
            busy.set(false);
            call.reject("Не удалось получить место для сохранения.", "EXPORT_INVALID_DESTINATION");
            return;
        }
        try {
            io.execute(() -> {
                try {
                    // Re-check after the picker returns, before reading any bytes.
                    File source = validatedSource(call.getString("source"));
                    try (FileInputStream input = new FileInputStream(source);
                         OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                        if (output == null) throw new IOException("Destination is unavailable");
                        byte[] buffer = new byte[65536];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (Thread.currentThread().isInterrupted()) throw new IOException("Export interrupted");
                            output.write(buffer, 0, count);
                        }
                        output.flush();
                    }
                    call.resolve(new JSObject().put("saved", true));
                } catch (Exception error) {
                    call.reject("Не удалось сохранить файл. Выберите другое место и повторите.", "EXPORT_WRITE_FAILED", error);
                } finally { busy.set(false); }
            });
        } catch (Exception error) {
            busy.set(false);
            call.reject("Сохранение прервано. Повторите экспорт.", "EXPORT_INTERRUPTED", error);
        }
    }

    private File validatedSource(String value) throws IOException {
        if (value == null) throw new IOException("Missing source");
        Uri uri = Uri.parse(value);
        if (!"file".equals(uri.getScheme()) || uri.getPath() == null || uri.getQuery() != null || uri.getFragment() != null
            || (uri.getAuthority() != null && !uri.getAuthority().isEmpty())) throw new IOException("Only local cache files are allowed");
        File cache = getContext().getCacheDir().getCanonicalFile();
        File exports = new File(cache, "exports").getCanonicalFile();
        File source = new File(uri.getPath()).getCanonicalFile();
        if (!exports.getPath().startsWith(cache.getPath() + File.separator)
            || !source.getPath().startsWith(exports.getPath() + File.separator) || !source.isFile() || !source.canRead()) {
            throw new IOException("Source must be inside the app export cache");
        }
        return source;
    }

    private void validateNameAndMime(String name, String mime) throws IOException {
        if (name == null || name.isEmpty() || name.length() > 220 || name.equals(".") || name.equals("..")
            || name.matches("(?s).*[\\x00-\\x1f\\x7f/\\\\].*")) throw new IOException("Invalid filename");
        String extension = "image/png".equals(mime) ? ".png" : "application/json".equals(mime) ? ".json" : "text/plain".equals(mime) ? ".txt" : null;
        if (extension == null || !name.toLowerCase(Locale.ROOT).endsWith(extension)) throw new IOException("Unsupported export type");
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdown();
        super.handleOnDestroy();
    }
}
