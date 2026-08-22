# Organic Maps resolves SDK classes and members by literal JNI names.
-keep,includedescriptorclasses class app.organicmaps.sdk.** { *; }

-keepclassmembers class * implements okhttp3.Call {
    void cancel();
}

-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
