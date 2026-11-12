/*
  ESP32-S3 + DHT11 + 3 LEDs  ->  MQTT  ->  Web dashboard (GitHub Pages)

  LED behaviour (each LED is independent, so combined states are visible):
    RED   : fast blink  -> temperature > threshold (default 36 °C). Works offline too.
            solid ON    -> DHT11 read error
    BLUE  : short flash every 2 s -> temperature normal AND reading published to MQTT
    GREEN : fast blink  -> Wi-Fi NOT connected
            slow blink  -> Wi-Fi OK but MQTT broker not connected
            OFF         -> everything connected

  MQTT topics (TOPIC_BASE set in secrets.h):
    <base>/data                 JSON reading, every 2 s
    <base>/status               "online" / "offline" (retained, LWT)
    <base>/config/threshold     dashboard -> device, number in °C (retained)
    <base>/cmd                  dashboard -> device: "identify" (flash all LEDs), "reboot"

  Libraries (Arduino IDE > Library Manager):
    - "DHT sensor library" by Adafruit (+ "Adafruit Unified Sensor")
    - "PubSubClient" by Nick O'Leary
  Board: "ESP32S3 Dev Module" (esp32 by Espressif, Boards Manager)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <DHT.h>
#include "secrets.h"

// ---------------- Pins (safe GPIOs on ESP32-S3) ----------------
#define DHT_PIN    4
#define DHT_TYPE   DHT11
#define LED_RED    5
#define LED_GREEN  6
#define LED_BLUE   7

// ---------------- Timing ----------------
const unsigned long SAMPLE_INTERVAL_MS = 2000;  // read + publish every 2 s (DHT11 min is 1 s)
const unsigned long FAST_BLINK_MS      = 150;   // half-period of "frequent" blink
const unsigned long SLOW_BLINK_MS      = 1000;  // half-period of MQTT-down blink
const unsigned long BLUE_FLASH_MS      = 150;   // blue on-time per 2 s cycle
const unsigned long WIFI_RETRY_MS      = 10000;
const unsigned long MQTT_RETRY_MS      = 5000;
const float         HYSTERESIS_C       = 0.5f;  // stops red LED flickering at the limit

// ---------------- Globals ----------------
DHT dht(DHT_PIN, DHT_TYPE);

#if MQTT_USE_TLS
WiFiClientSecure netClient;
#else
WiFiClient netClient;
#endif
PubSubClient mqtt(netClient);

String topicData, topicStatus, topicThreshold, topicCmd, clientId;

float tempThreshold = DEFAULT_TEMP_THRESHOLD;
float lastTemp = NAN, lastHum = NAN;
bool  highTemp = false;
bool  sensorError = false;

unsigned long lastSample = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;
unsigned long blueOffAt = 0;
unsigned long identifyUntil = 0;
bool wasWifiConnected = false;

// ---------------- Helpers ----------------
inline bool blinkPhase(unsigned long now, unsigned long halfPeriod) {
  return (now / halfPeriod) % 2 == 0;
}

void startWifi() {
  Serial.printf("[WiFi] Connecting to %s ...\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttempt = millis();
}

void handleWifi(unsigned long now) {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasWifiConnected) {
    Serial.printf("[WiFi] Connected. IP=%s RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else if (!connected && wasWifiConnected) {
    Serial.println("[WiFi] Lost connection");
  }
  wasWifiConnected = connected;

  if (!connected && now - lastWifiAttempt >= WIFI_RETRY_MS) startWifi();
}

void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  String msg;
  msg.reserve(len);
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  msg.trim();
  Serial.printf("[MQTT] <- %s : %s\n", topic, msg.c_str());

  if (topicThreshold == topic) {
    float v = msg.toFloat();
    if (msg.length() && v >= 0 && v <= 60) {       // DHT11 range is 0–50 °C
      tempThreshold = v;
      Serial.printf("[CFG] Threshold = %.1f C\n", tempThreshold);
    }
  } else if (topicCmd == topic) {
    if (msg == "identify") identifyUntil = millis() + 3000;
    else if (msg == "reboot") { mqtt.publish(topicStatus.c_str(), "offline", true); delay(200); ESP.restart(); }
  }
}

void handleMqtt(unsigned long now) {
  if (WiFi.status() != WL_CONNECTED) return;

  if (mqtt.connected()) { mqtt.loop(); return; }
  if (now - lastMqttAttempt < MQTT_RETRY_MS) return;
  lastMqttAttempt = now;

  Serial.printf("[MQTT] Connecting to %s:%d ...\n", MQTT_HOST, MQTT_PORT);
  const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char* pass = strlen(MQTT_PASS) ? MQTT_PASS : nullptr;

  // Last Will: broker publishes "offline" if the board disappears.
  if (mqtt.connect(clientId.c_str(), user, pass,
                   topicStatus.c_str(), 1, true, "offline")) {
    Serial.println("[MQTT] Connected");
    mqtt.publish(topicStatus.c_str(), "online", true);
    mqtt.subscribe(topicThreshold.c_str(), 1);
    mqtt.subscribe(topicCmd.c_str());
  } else {
    Serial.printf("[MQTT] Failed, state=%d (retry in %lus)\n", mqtt.state(), MQTT_RETRY_MS / 1000);
  }
}

void sampleAndPublish(unsigned long now) {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (isnan(t) || isnan(h)) {
    sensorError = true;
    Serial.println("[DHT] Read failed - check wiring / pull-up");
    if (mqtt.connected()) {
      char err[96];
      snprintf(err, sizeof(err), "{\"error\":\"sensor\",\"uptime\":%lu}", now / 1000);
      mqtt.publish(topicData.c_str(), err);
    }
    return;
  }
  sensorError = false;
  lastTemp = t;
  lastHum = h;

  // Alert with hysteresis
  if (!highTemp && t > tempThreshold) highTemp = true;
  else if (highTemp && t < tempThreshold - HYSTERESIS_C) highTemp = false;

  float hi = dht.computeHeatIndex(t, h, false);
  Serial.printf("[DHT] T=%.1f C  H=%.0f %%  HI=%.1f C  %s\n", t, h, hi, highTemp ? "HIGH!" : "normal");

  if (!mqtt.connected()) return;

  char json[256];
  snprintf(json, sizeof(json),
           "{\"temp\":%.1f,\"hum\":%.0f,\"hi\":%.1f,\"alert\":%s,\"threshold\":%.1f,"
           "\"rssi\":%d,\"uptime\":%lu,\"heap\":%u}",
           t, h, hi, highTemp ? "true" : "false", tempThreshold,
           WiFi.RSSI(), now / 1000, ESP.getFreeHeap());

  if (mqtt.publish(topicData.c_str(), json) && !highTemp) {
    digitalWrite(LED_BLUE, HIGH);             // blue flash = "normal + sent"
    blueOffAt = now + BLUE_FLASH_MS;
  }
}

void updateLeds(unsigned long now) {
  if (now < identifyUntil) {                  // "identify" command: all LEDs together
    bool on = blinkPhase(now, 100);
    digitalWrite(LED_RED, on); digitalWrite(LED_GREEN, on); digitalWrite(LED_BLUE, on);
    return;
  }

  // RED
  if (sensorError)   digitalWrite(LED_RED, HIGH);
  else if (highTemp) digitalWrite(LED_RED, blinkPhase(now, FAST_BLINK_MS));
  else               digitalWrite(LED_RED, LOW);

  // GREEN
  if (WiFi.status() != WL_CONNECTED) digitalWrite(LED_GREEN, blinkPhase(now, FAST_BLINK_MS));
  else if (!mqtt.connected())        digitalWrite(LED_GREEN, blinkPhase(now, SLOW_BLINK_MS));
  else                               digitalWrite(LED_GREEN, LOW);

  // BLUE (turned on in sampleAndPublish)
  if (blueOffAt && (long)(now - blueOffAt) >= 0) {
    digitalWrite(LED_BLUE, LOW);
    blueOffAt = 0;
  }
}

// ---------------- Setup / Loop ----------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== ESP32-S3 DHT11 MQTT ===");

  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  // Power-on self test: R, G, B
  for (int pin : {LED_RED, LED_GREEN, LED_BLUE}) { digitalWrite(pin, HIGH); delay(250); digitalWrite(pin, LOW); }

  dht.begin();

  topicData      = String(TOPIC_BASE) + "/data";
  topicStatus    = String(TOPIC_BASE) + "/status";
  topicThreshold = String(TOPIC_BASE) + "/config/threshold";
  topicCmd       = String(TOPIC_BASE) + "/cmd";

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  clientId = "esp32s3-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  startWifi();

#if MQTT_USE_TLS
  netClient.setInsecure();   // skips cert check. For production load the broker CA with setCACert().
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(3);  // keep connect attempts short so LEDs keep blinking
}

void loop() {
  unsigned long now = millis();

  handleWifi(now);
  handleMqtt(now);

  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    sampleAndPublish(now);
  }

  updateLeds(now);
  delay(5);
}
