package com.example.palmchat;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalChatStorePlugin.class);
        registerPlugin(VoiceRecorderPlugin.class);
        registerPlugin(SessionStorePlugin.class);
        registerPlugin(SecretStorePlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        if (getBridge() == null || getBridge().getWebView() == null) return;
        boolean debug = BuildConfig.DEBUG;
        // Debug APKs can reach a developer's HTTP LAN backend. Release APKs always
        // enforce HTTPS; no remote page or API key is embedded in the native shell.
        getBridge().getWebView().getSettings().setMixedContentMode(
            debug ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW
        );
        WebView.setWebContentsDebuggingEnabled(debug);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                        .hide(WindowInsetsCompat.Type.ime());
                    return;
                }
                WebView view = getBridge().getWebView();
                view.evaluateJavascript(
                    "(() => { const e = new Event('palm:android-back', { cancelable: true }); " +
                    "window.dispatchEvent(e); return e.defaultPrevented; })()",
                    result -> {
                        if ("true".equals(result)) return;
                        if (view.canGoBack()) view.goBack();
                        else moveTaskToBack(true);
                    }
                );
            }
        });
    }

    private void dispatchLifecycle(String eventName) {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new Event('" + eventName + "'));", null
            );
        }
    }

    @Override
    public void onPause() {
        dispatchLifecycle("palm:android-pause");
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        dispatchLifecycle("palm:android-resume");
    }
}
