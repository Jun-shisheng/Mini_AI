package com.example.palmchat;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Encrypts the short-lived native session with Android Keystore so an app
 * update or process restart does not force a new login. The token is still
 * cleared on explicit logout, 401, expiry, or a Keystore failure.
 */
@CapacitorPlugin(name = "SessionStore")
public class SessionStorePlugin extends Plugin {
    private static final String ALIAS = "palm.session.v1";
    private static final byte[] MAGIC = "PALMSSN1".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] AAD = "palm-session-v1".getBytes(StandardCharsets.UTF_8);
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_BYTES = 8192;

    private File file() {
        return new File(getContext().getFilesDir(), "session.bin");
    }

    private SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            generator.generateKey();
        }
        return (SecretKey) keyStore.getKey(ALIAS, null);
    }

    @PluginMethod
    public void save(PluginCall call) {
        String token = call.getString("token");
        String userId = call.getString("userId", "");
        Long expiresAt = call.getLong("expiresAt");
        if (token == null || token.length() < 24 || token.length() > 512
            || token.matches(".*\\s.*")
            || expiresAt == null || expiresAt <= System.currentTimeMillis()
            || (userId != null && !userId.isEmpty() && !userId.matches("[\\w-]{1,128}"))) {
            call.reject("会话信息无效。");
            return;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("token", token);
            payload.put("expiresAt", expiresAt);
            payload.put("userId", userId == null ? "" : userId);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(AAD);
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(payload.toString().getBytes(StandardCharsets.UTF_8));
            AtomicFile atomic = new AtomicFile(file());
            FileOutputStream output = atomic.startWrite();
            try {
                output.write(MAGIC);
                output.write(iv.length);
                output.write(iv);
                output.write(ciphertext);
                atomic.finishWrite(output);
            } catch (Exception error) {
                atomic.failWrite(output);
                throw error;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("无法保存登录状态。");
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        JSObject result = new JSObject();
        File target = file();
        if (!target.isFile()) {
            result.put("session", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            AtomicFile atomic = new AtomicFile(target);
            FileInputStream input = atomic.openRead();
            byte[] data;
            try {
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[1024];
                int read;
                while ((read = input.read(chunk)) > 0) {
                    if (buffer.size() + read > MAX_BYTES) throw new IllegalStateException("too large");
                    buffer.write(chunk, 0, read);
                }
                data = buffer.toByteArray();
            } finally {
                input.close();
            }
            int ivLength = data[8] & 0xff;
            if (data.length <= 9 + ivLength || !Arrays.equals(Arrays.copyOfRange(data, 0, 8), MAGIC)
                || ivLength < 12 || ivLength > 16) throw new IllegalStateException("bad file");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(),
                new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(data, 9, 9 + ivLength)));
            cipher.updateAAD(AAD);
            String json = new String(cipher.doFinal(Arrays.copyOfRange(data, 9 + ivLength, data.length)),
                StandardCharsets.UTF_8);
            JSONObject payload = new JSONObject(json);
            String token = payload.getString("token");
            long expiresAt = payload.getLong("expiresAt");
            String userId = payload.optString("userId", "");
            if (expiresAt <= System.currentTimeMillis()) {
                atomic.delete();
                result.put("session", JSONObject.NULL);
            } else {
                JSObject session = new JSObject();
                session.put("token", token);
                session.put("expiresAt", expiresAt);
                session.put("userId", userId);
                result.put("session", session);
            }
        } catch (KeyPermanentlyInvalidatedException error) {
            new AtomicFile(target).delete();
            result.put("session", JSONObject.NULL);
        } catch (Exception error) {
            // A tampered or unreadable file must not lock the app; the user can log in again.
            try { new AtomicFile(target).delete(); } catch (Exception ignored) { }
            result.put("session", JSONObject.NULL);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try { new AtomicFile(file()).delete(); } catch (Exception ignored) { }
        call.resolve();
    }
}
