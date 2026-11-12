// =============================================================
//  secrets.h  —  your private settings. copy this file to secrets.h and edit.
//  (.gitignore already excludes this file; secrets.example.h is the template)
// =============================================================
#pragma once

// ---- Wi-Fi (ESP32-S3 supports 2.4 GHz only) ----
#define WIFI_SSID       "YOUR_WIFI_NAME"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

// ---- MQTT broker ----
// Default: HiveMQ public broker (no login, anyone can read/write your topics).
// For a private broker (e.g. HiveMQ Cloud free tier) set MQTT_USE_TLS 1,
// MQTT_PORT 8883 and fill in user/pass.
#define MQTT_HOST       "broker.hivemq.com"
#define MQTT_PORT       1883
#define MQTT_USE_TLS    0
#define MQTT_USER       ""
#define MQTT_PASS       ""

// ---- Topic base ----
// Make this UNIQUE (public broker is shared with the whole world).
// The dashboard must use the same value.
#define TOPIC_BASE      "esp32s3dht/change-me-7f3k"

// ---- Alert threshold (°C). Dashboard can override it at runtime. ----
#define DEFAULT_TEMP_THRESHOLD  36.0f
