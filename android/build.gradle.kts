group = "com.affinaloyalty.rtlsdk.rtl_sdk"
version = "4.1.0"

buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath("com.android.tools.build:gradle:8.13.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20")
    }
}
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.affinaloyalty.rtlsdk.rtl_sdk"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").java.srcDirs("src/main/kotlin")
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.mockito:mockito-core:5.18.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    // Development hosts explicitly include these projects when RTL_ANDROID_SDK_PATH is set.
    if (!System.getenv("RTL_ANDROID_SDK_PATH").isNullOrBlank()) {
        require(rootProject.findProject(":core") != null && rootProject.findProject(":hyperlocal-offers") != null) {
            "Include the native core and hyperlocal-offers projects from RTL_ANDROID_SDK_PATH in settings.gradle"
        }
        api(project(":core"))
        implementation(project(":hyperlocal-offers"))
    } else {
        api("com.affinaloyalty:rtl-sdk-core:4.1.0")
        implementation("com.affinaloyalty:rtl-sdk-location:4.1.0")
    }
}
