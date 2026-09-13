plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.couchmode.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.couchmode.tv"
        // Fire OS 8 is Android 11.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// No dependencies on purpose: this shell is a WebView and a settings form.
// Everything else lives in the web client, which the bridge serves, so
// improving the TV experience means editing TypeScript, not reinstalling.
dependencies {}
