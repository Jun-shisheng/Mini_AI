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

/**
 * Stores the user's own model API key with Android Keystore AES-GCM.
 * The key never leaves the app except in the HTTPS request to the
 * self-hosted relay the user configured.
 */
@CapacitorPlugin(name = "SecretStore")
public class SecretStorePlugin extends Plugin {
    private static final String ALIAS = "palm.provider.v1";
    private static final byte[] MAGIC = "PALMSEC1".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] AAD = "palm-provider-v1".getBytes(StandardCharsets.UTF_8);
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_BYTES = 8192;

    private File file() {
        return new File(getContext().getFilesDir(), "provider.bin");
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
        String value = call.getString("value");
        if (value == null || value.isEmpty() || value.length() > 6000
            || value.indexOf('\u0000') >= 0) {
            call.reject("密钥内容无效。");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(AAD);
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
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
            call.reject("无法保存密钥。");
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        JSObject result = new JSObject();
        File target = file();
        if (!target.isFile()) {
            result.put("value", JSONObjectNull());
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
            String value = new String(cipher.doFinal(Arrays.copyOfRange(data, 9 + ivLength, data.length)),
                StandardCharsets.UTF_8);
            result.put("value", value);
        } catch (KeyPermanentlyInvalidatedException error) {
            new AtomicFile(target).delete();
            result.put("value", JSONObjectNull());
        } catch (Exception error) {
            try { new AtomicFile(target).delete(); } catch (Exception ignored) { }
            result.put("value", JSONObjectNull());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try { new AtomicFile(file()).delete(); } catch (Exception ignored) { }
        call.resolve();
    }

    private static Object JSONObjectNull() {
        return org.json.JSONObject.NULL;
    }
}
