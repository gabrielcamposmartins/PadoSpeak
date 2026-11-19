import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A versão é a mesma do resto do PadoSpeak (package.json da raiz, trocada pelo `npm run version:set`).
val appVersion: String = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"")
    .find(rootProject.file("../package.json").readText())!!.groupValues[1]
val (vMajor, vMinor, vPatch) = appVersion.split(".").map { it.toInt() }

// Servidor que o app abre. `-PpadospeakBase=http://localhost:8090` só nos testes (build de depuração).
val baseUrl: String = (findProperty("padospeakBase") as String?) ?: "https://padospeak.padoru.org"

// Chave de assinatura fora do repositório: ~/.android-keys/padospeak-release.properties
// (storeFile, storePassword, keyAlias, keyPassword) ou o caminho em PADOSPEAK_ANDROID_SIGNING.
val signingFile = file(
    System.getenv("PADOSPEAK_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.android-keys/padospeak-release.properties"
)
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use { load(it) } }

android {
    namespace = "dev.padospeak.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.padospeak.android"
        minSdk = 26
        targetSdk = 35
        // `-PpadospeakVersionCode=1` só para testar a atualização (um APK que se acha antigo).
        versionCode = (findProperty("padospeakVersionCode") as String?)?.toInt() ?: (vMajor * 10000 + vMinor * 100 + vPatch)
        versionName = appVersion
        buildConfigField("String", "BASE_URL", "\"https://padospeak.padoru.org\"")
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "BASE_URL", "\"$baseUrl\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    applicationVariants.all {
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "PadoSpeak_${appVersion}_${buildType.name}.apk"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
