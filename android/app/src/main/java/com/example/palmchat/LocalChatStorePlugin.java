package com.example.palmchat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.UnrecoverableKeyException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Iterator;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Account-scoped encrypted records. No secret key or plaintext is written outside private app memory. */
@CapacitorPlugin(name = "LocalChatStore")
public class LocalChatStorePlugin extends Plugin {
    private static final byte[] MAGIC = "PALMLOC1".getBytes(StandardCharsets.US_ASCII);
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_DATA_BYTES = 32 * 1024 * 1024;
    private static final Pattern CONVERSATION_KEY = Pattern.compile(
        "^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        Pattern.CASE_INSENSITIVE
    );
    // The queue survives Activity recreation, so a retiring plugin instance and a new
    // instance cannot write the same AtomicFile at the same time.
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final AtomicReference<ExportPayload> ACTIVE_EXPORT = new AtomicReference<>();

    private static class ExportPayload {
        final String id = UUID.randomUUID().toString();
        final byte[] bytes;
        ExportPayload(byte[] bytes) { this.bytes = bytes; }
    }

    private void releaseExport(ExportPayload payload) {
        if (payload != null && ACTIVE_EXPORT.compareAndSet(payload, null)) Arrays.fill(payload.bytes, (byte) 0);
    }

    private static class StoreError extends Exception {
        final String code;
        StoreError(String code, String message) { super(message); this.code = code; }
    }

    @FunctionalInterface
    private interface Operation { JSObject run() throws Exception; }

    private void execute(PluginCall call, String failureCode, Operation action) {
        try {
            IO.execute(() -> {
                try {
                    call.resolve(action.run());
                } catch (StoreError error) {
                    call.reject(error.getMessage(), error.code);
                } catch (AEADBadTagException error) {
                    call.reject("本地聊天校验失败，已保留原文件，请勿覆盖。", "DECRYPT_FAILED");
                } catch (KeyPermanentlyInvalidatedException | UnrecoverableKeyException error) {
                    call.reject("设备上的聊天密钥不可用，已保留原文件。", "KEY_INVALIDATED");
                } catch (InvalidKeyException error) {
                    call.reject("设备无法使用当前聊天密钥，已保留原文件。", "KEY_INVALIDATED");
                } catch (BadPaddingException error) {
                    call.reject("本地聊天无法解密，已保留原文件，请勿覆盖。", "DECRYPT_FAILED");
                } catch (Exception error) {
                    call.reject(failureCode.startsWith("EXPORT")
                        ? "导出写入失败，目标文件可能不完整，请重新导出。"
                        : "本地聊天存储操作失败，请重试；原有记录不会作为空记录覆盖。", failureCode);
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject("应用存储正在关闭，请重新打开应用。", "STORE_UNAVAILABLE");
        }
    }

    private String accountHash(PluginCall call) throws Exception {
        String account = call.getString("accountId");
        if (account == null || account.trim().isEmpty() || account.length() > 256) {
            throw new StoreError("INVALID_ACCOUNT", "本地账号标识无效。");
        }
        for (int i = 0; i < account.length(); i++) {
            if (Character.isISOControl(account.charAt(i))) throw new StoreError("INVALID_ACCOUNT", "本地账号标识无效。");
        }
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(account.getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder(64);
        for (byte part : hash) value.append(String.format(Locale.ROOT, "%02x", part & 0xff));
        return value.toString();
    }

    private String recordKey(PluginCall call) throws StoreError {
        String key = call.getString("key");
        if ("index".equals(key)) return key;
        if (key != null && CONVERSATION_KEY.matcher(key).matches()) return key.toLowerCase(Locale.ROOT);
        throw new StoreError("INVALID_KEY", "本地记录键必须为 index 或 conversation:UUID。");
    }

    private File accountDirectory(String account, boolean create) throws StoreError {
        File directory = new File(new File(getContext().getFilesDir(), "palm-chat-v1"), account);
        if (create && !directory.isDirectory() && !directory.mkdirs()) {
            throw new StoreError("WRITE_FAILED", "无法创建应用私有聊天目录。");
        }
        return directory;
    }

    private File recordFile(File directory, String key) {
        String filename = "index".equals(key) ? "index.enc" : "conversation_" + key.substring("conversation:".length()) + ".enc";
        return new File(directory, filename);
    }

    private String keyFromFile(String filename) {
        if (filename.endsWith(".bak")) filename = filename.substring(0, filename.length() - 4);
        if ("index.enc".equals(filename)) return "index";
        if (filename.startsWith("conversation_") && filename.endsWith(".enc")) {
            String candidate = "conversation:" + filename.substring("conversation_".length(), filename.length() - 4);
            if (CONVERSATION_KEY.matcher(candidate).matches()) return candidate.toLowerCase(Locale.ROOT);
        }
        return null;
    }

    private boolean hasCommittedFiles(File directory) {
        String[] names = directory.list();
        if (names == null) return false;
        for (String name : names) if (keyFromFile(name) != null) return true;
        return false;
    }

    private boolean exists(File file) {
        return file.isFile() || new File(file.getPath() + ".bak").isFile();
    }

    private SecretKey secretKey(String account, File directory, boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        String alias = "palm.chat.v1." + account;
        java.security.Key key = store.getKey(alias, null);
        if (key instanceof SecretKey) return (SecretKey) key;
        if (!create || hasCommittedFiles(directory)) {
            throw new StoreError("KEY_INVALIDATED", "此账号的本地密钥不可用，已保留密文，不能自动覆盖。");
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build());
        return generator.generateKey();
    }

    private byte[] aad(String account, String key) {
        return ("palm-local-v1:" + account + ":" + key).getBytes(StandardCharsets.UTF_8);
    }

    private byte[] encrypt(String account, String key, File directory, byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey(account, directory, true));
        cipher.updateAAD(aad(account, key));
        byte[] iv = cipher.getIV();
        if (iv.length != IV_LENGTH) throw new StoreError("WRITE_FAILED", "设备不支持所需的本地加密格式。");
        byte[] ciphertext = cipher.doFinal(plaintext);
        ByteArrayOutputStream output = new ByteArrayOutputStream(MAGIC.length + IV_LENGTH + ciphertext.length);
        output.write(MAGIC);
        output.write(iv);
        output.write(ciphertext);
        return output.toByteArray();
    }

    private String decrypt(String account, String key, File directory, byte[] encrypted) throws Exception {
        if (encrypted.length < MAGIC.length + IV_LENGTH + TAG_BITS / 8 ||
            !Arrays.equals(MAGIC, Arrays.copyOfRange(encrypted, 0, MAGIC.length))) {
            throw new StoreError("DECRYPT_FAILED", "本地聊天格式损坏，已保留原文件，请勿覆盖。");
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = Arrays.copyOfRange(encrypted, MAGIC.length, MAGIC.length + IV_LENGTH);
        cipher.init(Cipher.DECRYPT_MODE, secretKey(account, directory, false), new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(aad(account, key));
        byte[] plaintext = cipher.doFinal(encrypted, MAGIC.length + IV_LENGTH, encrypted.length - MAGIC.length - IV_LENGTH);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    private byte[] readBounded(AtomicFile file) throws Exception {
        try (FileInputStream input = file.openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > MAX_DATA_BYTES + 64) {
                    throw new StoreError("PAYLOAD_TOO_LARGE", "本地单条记录超出32MiB限制，原文件已保留。");
                }
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        execute(call, "LIST_FAILED", () -> {
            File directory = accountDirectory(accountHash(call), false);
            List<String> keys = new ArrayList<>();
            String[] files = directory.list();
            if (files == null && directory.exists()) throw new StoreError("LIST_FAILED", "无法读取此账号的本地记录列表。");
            if (files != null) {
                for (String file : files) {
                    String key = keyFromFile(file);
                    if (key != null && !keys.contains(key)) keys.add(key);
                }
            }
            Collections.sort(keys);
            JSArray resultKeys = new JSArray();
            for (String key : keys) resultKeys.put(key);
            JSObject result = new JSObject();
            result.put("keys", resultKeys);
            return result;
        });
    }

    @PluginMethod
    public void get(PluginCall call) {
        execute(call, "READ_FAILED", () -> {
            String account = accountHash(call);
            String key = recordKey(call);
            File directory = accountDirectory(account, false);
            File file = recordFile(directory, key);
            JSObject result = new JSObject();
            if (!exists(file)) { result.put("data", JSONObject.NULL); return result; }
            byte[] encrypted = readBounded(new AtomicFile(file));
            result.put("data", decrypt(account, key, directory, encrypted));
            return result;
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        execute(call, "WRITE_FAILED", () -> {
            String account = accountHash(call);
            String key = recordKey(call);
            String data = call.getString("data");
            if (data == null) throw new StoreError("INVALID_DATA", "本地记录必须是字符串。");
            if (data.length() > MAX_DATA_BYTES) throw new StoreError("PAYLOAD_TOO_LARGE", "本地单条记录不能超过32MiB。");
            byte[] plaintext = data.getBytes(StandardCharsets.UTF_8);
            if (plaintext.length > MAX_DATA_BYTES) throw new StoreError("PAYLOAD_TOO_LARGE", "本地单条记录不能超过32MiB。");
            File directory = accountDirectory(account, true);
            byte[] encrypted = encrypt(account, key, directory, plaintext);
            AtomicFile file = new AtomicFile(recordFile(directory, key));
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(encrypted);
                file.finishWrite(output);
            } catch (Exception error) {
                if (output != null) file.failWrite(output);
                throw error;
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            return result;
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        execute(call, "REMOVE_FAILED", () -> {
            String account = accountHash(call);
            String key = recordKey(call);
            File file = recordFile(accountDirectory(account, false), key);
            new AtomicFile(file).delete();
            if (exists(file)) throw new StoreError("REMOVE_FAILED", "未能删除指定的本地记录。");
            JSObject result = new JSObject();
            result.put("ok", true);
            return result;
        });
    }

    @PluginMethod
    public void exportDocument(PluginCall call) {
        try {
            String data = call.getString("data");
            if (data == null) throw new StoreError("INVALID_DATA", "导出内容必须是字符串。");
            if (data.length() > MAX_DATA_BYTES) {
                throw new StoreError("PAYLOAD_TOO_LARGE", "单个导出文件不能超过32MiB，请分会话导出。");
            }
            byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_DATA_BYTES) throw new StoreError("PAYLOAD_TOO_LARGE", "单个导出文件不能超过32MiB，请分会话导出。");
            String filename = call.getString("filename", "PalmChat-聊天备份.json");
            filename = filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
            if (filename.isEmpty()) filename = "PalmChat-聊天备份.json";
            if (filename.length() > 100) filename = filename.substring(0, Character.isHighSurrogate(filename.charAt(99)) ? 99 : 100);
            if (!filename.toLowerCase(Locale.ROOT).endsWith(".json")) filename += ".json";
            ExportPayload payload = new ExportPayload(bytes);
            if (!ACTIVE_EXPORT.compareAndSet(null, payload)) {
                Arrays.fill(bytes, (byte) 0);
                throw new StoreError("EXPORT_ACTIVE", "请先完成或取消当前导出。");
            }
            // Capacitor persists pending Activity call options to savedInstanceState.
            // Keep plaintext only in process memory; the Bundle gets a random ID.
            List<String> optionNames = new ArrayList<>();
            Iterator<String> names = call.getData().keys();
            while (names.hasNext()) optionNames.add(names.next());
            for (String name : optionNames) call.getData().remove(name);
            call.getData().put("exportId", payload.id);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            intent.putExtra(Intent.EXTRA_TITLE, filename);
            getActivity().runOnUiThread(() -> {
                try {
                    startActivityForResult(call, intent, "exportDocumentResult");
                } catch (Exception error) {
                    releaseExport(payload);
                    call.reject("无法打开系统保存文件界面，请确认设备有可用的文件管理器。", "EXPORT_UNAVAILABLE");
                }
            });
        } catch (StoreError error) {
            call.reject(error.getMessage(), error.code);
        }
    }

    @ActivityCallback
    private void exportDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) { releaseExport(ACTIVE_EXPORT.get()); return; }
        ExportPayload payload = ACTIVE_EXPORT.get();
        String exportId = call.getString("exportId");
        boolean matchingPayload = payload != null && payload.id.equals(exportId);
        Intent intent = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || intent == null || intent.getData() == null) {
            if (matchingPayload) releaseExport(payload);
            JSObject cancelled = new JSObject();
            cancelled.put("ok", false);
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        if (!matchingPayload) {
            call.reject("应用曾被系统回收，导出未完成，请重新导出。", "EXPORT_INTERRUPTED");
            return;
        }
        Uri uri = intent.getData();
        execute(call, "EXPORT_WRITE_FAILED", () -> {
            try {
                if (!"content".equals(uri.getScheme())) throw new StoreError("EXPORT_INVALID_DESTINATION", "系统没有返回可用的文档位置。");
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new StoreError("EXPORT_WRITE_FAILED", "无法打开所选位置，文件可能不完整，请重新导出。");
                    output.write(payload.bytes);
                    output.flush();
                }
                JSObject saved = new JSObject();
                saved.put("ok", true);
                saved.put("cancelled", false);
                return saved;
            } finally {
                releaseExport(payload);
            }
        });
    }

}
