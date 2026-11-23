# R8 rules for the Capacitor shell, native plugins and payment bridge.
# Keep reflection/annotation surfaces; app logic is renamed and shrunk.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,MethodParameters,KotlinMetadata

# Capacitor resolves plugin classes and methods by annotation/reflection.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}

# WebView JavaScript bridge methods.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Activity, BuildConfig and local plugins are referenced by name or manifest.
-keep class com.example.palmchat.MainActivity { *; }
-keep class com.example.palmchat.BuildConfig { *; }
-keep class com.example.palmchat.*Plugin { *; }

# Keep native method names and annotations.
-keepclasseswithmembernames class * { native <methods>; }

# Optional libraries that R8 may not see.
-dontwarn org.apache.**
-dontwarn org.json.**
-dontwarn androidx.webkit.**
-dontwarn com.google.**

-renamesourcefileattribute SourceFile
-allowaccessmodification
-optimizationpasses 5
