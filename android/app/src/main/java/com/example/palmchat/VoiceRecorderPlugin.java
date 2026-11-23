package com.example.palmchat;

import android.Manifest;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Records 16 kHz mono 16-bit PCM and returns a WAV for DeepSeek ASR.
 * The audio never touches app storage; it is returned to the WebView once.
 */
@CapacitorPlugin(name = "VoiceRecorder", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class VoiceRecorderPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int MAX_MILLISECONDS = 120000;
    private final AtomicBoolean recording = new AtomicBoolean(false);
    private AudioRecord recorder;
    private Thread thread;
    private ByteArrayOutputStream pcm;
    private long startedAt;

    @PluginMethod
    public void start(PluginCall call) {
        if (recording.get()) {
            call.reject("已经在录音。");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("需要麦克风权限才能语音输入。");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        try {
            int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                Math.max(minimum, SAMPLE_RATE * 2));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                release();
                call.reject("无法初始化麦克风。");
                return;
            }
            pcm = new ByteArrayOutputStream();
            recording.set(true);
            startedAt = System.currentTimeMillis();
            recorder.startRecording();
            thread = new Thread(() -> {
                byte[] buffer = new byte[4096];
                while (recording.get()) {
                    int read = recorder.read(buffer, 0, buffer.length);
                    if (read > 0) pcm.write(buffer, 0, read);
                    if (System.currentTimeMillis() - startedAt > MAX_MILLISECONDS) {
                        recording.set(false);
                        break;
                    }
                }
            }, "palm-voice-recorder");
            thread.start();
            call.resolve();
        } catch (Exception error) {
            recording.set(false);
            release();
            call.reject("无法开始录音。");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!recording.get()) {
            call.reject("当前没有录音。");
            return;
        }
        recording.set(false);
        try {
            if (thread != null) thread.join(1500);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        release();
        byte[] data = pcm == null ? new byte[0] : pcm.toByteArray();
        if (data.length < 2) {
            call.reject("没有录到声音，请再试一次。");
            return;
        }
        JSObject result = new JSObject();
        result.put("base64", Base64.encodeToString(wav(data), Base64.NO_WRAP));
        result.put("mimeType", "audio/wav");
        result.put("durationMs", Math.min(MAX_MILLISECONDS, System.currentTimeMillis() - startedAt));
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        recording.set(false);
        try {
            if (thread != null) thread.join(300);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        release();
        call.resolve();
    }

    private void release() {
        if (recorder != null) {
            try { recorder.stop(); } catch (Exception ignored) { }
            try { recorder.release(); } catch (Exception ignored) { }
            recorder = null;
        }
    }

    private byte[] wav(byte[] pcmBytes) {
        int channels = 1;
        int bits = 16;
        int byteRate = SAMPLE_RATE * channels * bits / 8;
        int dataSize = pcmBytes.length;
        byte[] header = new byte[44];
        header[0] = 'R'; header[1] = 'I'; header[2] = 'F'; header[3] = 'F';
        putInt(header, 4, 36 + dataSize);
        header[8] = 'W'; header[9] = 'A'; header[10] = 'V'; header[11] = 'E';
        header[12] = 'f'; header[13] = 'm'; header[14] = 't'; header[15] = ' ';
        putInt(header, 16, 16);
        putShort(header, 20, 1);
        putShort(header, 22, channels);
        putInt(header, 24, SAMPLE_RATE);
        putInt(header, 28, byteRate);
        putShort(header, 32, channels * bits / 8);
        putShort(header, 34, bits);
        header[36] = 'd'; header[37] = 'a'; header[38] = 't'; header[39] = 'a';
        putInt(header, 40, dataSize);
        byte[] output = new byte[44 + dataSize];
        System.arraycopy(header, 0, output, 0, 44);
        System.arraycopy(pcmBytes, 0, output, 44, dataSize);
        return output;
    }

    private static void putInt(byte[] buffer, int offset, int value) {
        buffer[offset] = (byte) (value & 0xff);
        buffer[offset + 1] = (byte) ((value >> 8) & 0xff);
        buffer[offset + 2] = (byte) ((value >> 16) & 0xff);
        buffer[offset + 3] = (byte) ((value >> 24) & 0xff);
    }

    private static void putShort(byte[] buffer, int offset, int value) {
        buffer[offset] = (byte) (value & 0xff);
        buffer[offset + 1] = (byte) ((value >> 8) & 0xff);
    }
}
