# ESP32-S3 Climate Monitor (DHT11 + MQTT + GitHub Pages)

```
ESP32-S3 ──(TCP 1883)──► MQTT broker ◄──(WSS 8884)── Web dashboard (GitHub Pages)
 DHT11, R/G/B LEDs          broker.hivemq.com            docs/
```

## 1. Wiring

| Part            | ESP32-S3 pin | Notes                                   |
|-----------------|--------------|-----------------------------------------|
| DHT11 VCC       | 3V3          |                                         |
| DHT11 DATA      | GPIO 4       | 10 kΩ pull-up to 3V3 (3-pin modules already have it) |
| DHT11 GND       | GND          |                                         |
| Red LED (+)     | GPIO 5       | via 220–330 Ω resistor, LED (–) to GND  |
| Green LED (+)   | GPIO 6       | via 220–330 Ω resistor                  |
| Blue LED (+)    | GPIO 7       | via 220–330 Ω resistor                  |

Avoid GPIO 0, 3, 45, 46 (strapping), 19/20 (USB) and 26–37 (flash/PSRAM).

## 2. LED behaviour

| LED   | Pattern                      | Meaning                                  |
|-------|------------------------------|------------------------------------------|
| Red   | fast blink (150 ms)          | temperature > threshold (default 36 °C) — works even offline |
| Red   | solid                        | DHT11 read error                         |
| Blue  | short flash every 2 s        | temperature normal and data sent to MQTT |
| Green | fast blink (150 ms)          | Wi-Fi not connected                      |
| Green | slow blink (1 s)             | Wi-Fi OK, MQTT broker not connected      |
| Green | off                          | all connected                            |

Data is published every 2 s whenever MQTT is connected (normal and high temp).
Alert has 0.5 °C hysteresis so the red LED does not flicker at the limit.

## 3. Firmware (Arduino IDE)

1. Boards Manager: install **esp32 by Espressif Systems**. Board: **ESP32S3 Dev Module**.
2. Library Manager: install **DHT sensor library** (Adafruit), **Adafruit Unified Sensor**, **PubSubClient** (Nick O'Leary).
3. Open `firmware/esp32s3_dht_mqtt/esp32s3_dht_mqtt.ino`.
4. Edit `secrets.h`: Wi-Fi SSID/password and a **unique** `TOPIC_BASE`.
5. Upload. Serial Monitor at 115200 baud shows readings and connection state.
   If upload fails on a native-USB board: hold BOOT, tap RESET, release BOOT. Enable *USB CDC On Boot* for Serial output over USB.

## 4. MQTT topics

| Topic                         | Direction        | Payload |
|-------------------------------|------------------|---------|
| `<base>/data`                 | device → web     | `{"temp":29.0,"hum":61,"hi":30.4,"alert":false,"threshold":36.0,"rssi":-58,"uptime":124,"heap":215000}` |
| `<base>/status`               | device → web     | `online` / `offline` (retained, Last Will) |
| `<base>/config/threshold`     | web → device     | `36.0` (retained, so the device keeps it after reboot) |
| `<base>/cmd`                  | web → device     | `identify` (flash all LEDs 3 s) / `reboot` |

## 5. Dashboard

Static files in `docs/` (`index.html`, `style.css`, `app.js`). Features: live temperature/humidity/heat index,
mirrored LEDs, device online/offline, history chart (2/10/30 min) with threshold line, min/avg/max,
threshold slider sent to the device, identify/reboot, browser notification + alert sound, CSV export,
demo mode (fake data, no hardware needed), light/dark theme.

Open `docs/index.html` locally, click ⚙ and set the same topic base as `secrets.h`.

### Deploy to GitHub Pages (not done yet — do it when ready)

1. Create a GitHub repo and push this folder (`secrets.h` is ignored by `.gitignore`).
2. Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.
3. Open `https://<user>.github.io/<repo>/`.

## 6. Security notes

- `broker.hivemq.com` is public: anyone who knows your topic can read the data **and** change the threshold or reboot the board. Fine for learning, not for real use.
- For privacy use a free private broker (e.g. HiveMQ Cloud): in `secrets.h` set `MQTT_PORT 8883`, `MQTT_USE_TLS 1`, user/pass;
  in the dashboard use `wss://<cluster>:8884/mqtt` with a separate read-mostly user. `setInsecure()` skips certificate checks — load the CA with `setCACert()` for production.
- Never commit `secrets.h`. Dashboard credentials are stored only in your browser's localStorage.
