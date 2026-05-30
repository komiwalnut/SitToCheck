#include "secrets.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>
#include "MAX30105.h"
#include "heartRate.h"
#include <time.h>

// ============================================================
// Backend: Supabase (PostgREST). This sketch talks to the same
// PostgreSQL tables the web dashboard uses:
//
//   live_data         -> upsert latest reading (every LIVE_UPLOAD_MS)
//   readings_history  -> insert a row (every HISTORY_UPLOAD_MS)
//   device_commands   -> poll for START/STOP/RESET, then ack status='done'
//   device_config     -> read pressure calibration
//
// Auth: the service_role key (in secrets.h) is sent as both the
// `apikey` and `Authorization: Bearer` headers. service_role bypasses
// Row Level Security, so keep secrets.h out of version control.
// ============================================================

// ============================================================
// Pin map based on FINAL DIAGRAM.jpg
// ============================================================
// MLX90614 + MAX30102 share I2C:
//   VIN -> 3V3
//   GND -> GND
//   SCL -> GPIO22
//   SDA -> GPIO23
//
// MPX5100 pressure sensor:
//   VCC -> 3V3
//   GND -> GND
//   OUT -> GPIO34
//
// MOSFET gates:
//   Air pump gate      -> GPIO26
//   Solenoid valve gate -> GPIO27
// ============================================================

constexpr uint8_t PIN_I2C_SDA = 23;
constexpr uint8_t PIN_I2C_SCL = 22;
constexpr uint8_t PIN_PRESSURE = 34;
constexpr uint8_t PIN_PUMP = 26;
constexpr uint8_t PIN_VALVE = 27;

constexpr uint32_t LIVE_UPLOAD_MS = 5000;
constexpr uint32_t HISTORY_UPLOAD_MS = 60000;
constexpr uint32_t COMMAND_CHECK_MS = 3000;
constexpr uint32_t CALIBRATION_CHECK_MS = 30000;

constexpr uint32_t BP_MAX_INFLATE_MS = 15000;

int pressureZeroAdc = 410;          // Tune after testing.
float pressureMmHgPerAdc = 0.22f;   // Tune after testing.
int bpTargetAdc = 1700;             // Stop inflation around this raw ADC.
int bpMaxAdc = 2500;                // Safety cutoff.

Adafruit_MLX90614 mlx = Adafruit_MLX90614();
MAX30105 max30102;

bool mlxReady = false;
bool maxReady = false;
bool measuring = false;

int heartRateBpm = 0;
int spo2Percent = 98; // MAX30102 SpO2 needs calibration; this is a safe placeholder.
float bodyTempC = 0.0f;
int bpSystolic = 0;
int bpDiastolic = 0;
bool sensorValid = false;
String alertStatus = "NO_FINGER";

unsigned long lastLiveUpload = 0;
unsigned long lastHistoryUpload = 0;
unsigned long lastCommandCheck = 0;
unsigned long lastCalibrationCheck = 0;

// Supabase REST endpoints (built in setup()).
String liveUrl;          // /rest/v1/live_data
String historyUrl;       // /rest/v1/readings_history
String commandUrl;       // /rest/v1/device_commands?device_id=eq.<id>
String configUrl;        // /rest/v1/device_config?device_id=eq.<id>&select=*

void stopActuators() {
  digitalWrite(PIN_PUMP, LOW);
  digitalWrite(PIN_VALVE, LOW);
}

void deflateCuff(uint32_t ms = 5000) {
  digitalWrite(PIN_PUMP, LOW);
  digitalWrite(PIN_VALVE, HIGH);
  delay(ms);
  digitalWrite(PIN_VALVE, LOW);
}

int readPressureADC() {
  long total = 0;
  for (int i = 0; i < 20; i++) {
    total += analogRead(PIN_PRESSURE);
    delay(2);
  }
  return total / 20;
}

float pressureToMmHg(int adc) {
  int corrected = max(0, adc - pressureZeroAdc);
  return corrected * pressureMmHgPerAdc;
}

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  if (strlen(WIFI_PASSWORD) == 0) {
    WiFi.begin(WIFI_SSID);
  } else {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    Serial.print(".");
    delay(500);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("WiFi failed. Check WIFI_SSID and WIFI_PASSWORD in secrets.h");
  }
}

void initTime() {
  configTime(8 * 3600, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  unsigned long start = millis();
  while (time(nullptr) < 100000 && millis() - start < 10000) {
    delay(250);
  }
}

void initSensors() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  mlxReady = mlx.begin();
  Serial.println(mlxReady ? "MLX90614 OK" : "MLX90614 NOT FOUND");

  maxReady = max30102.begin(Wire, I2C_SPEED_STANDARD);
  if (maxReady) {
    max30102.setup();
    max30102.setPulseAmplitudeRed(0x1F);
    max30102.setPulseAmplitudeIR(0x1F);
    max30102.setPulseAmplitudeGreen(0);
    Serial.println("MAX30102/MAX30105 OK");
  } else {
    Serial.println("MAX30102/MAX30105 NOT FOUND");
  }

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_PRESSURE, ADC_11db);
}

// ------------------------------------------------------------
// Supabase REST helpers
// ------------------------------------------------------------
// One TLS client reused across requests. setInsecure() skips certificate
// validation (simplest for a hobby device). For production, pin the
// Supabase root CA with client.setCACert(...) instead.
WiFiClientSecure tls;

void httpAddAuthHeaders(HTTPClient &http) {
  http.addHeader("apikey", SUPABASE_SERVICE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_SERVICE_KEY);
  http.addHeader("Content-Type", "application/json");
}

// POST a JSON body. `prefer` lets callers request upsert behaviour.
bool supabasePost(const String &url, const String &body, const char *prefer) {
  HTTPClient http;
  if (!http.begin(tls, url)) return false;
  httpAddAuthHeaders(http);
  if (prefer && strlen(prefer) > 0) http.addHeader("Prefer", prefer);
  int code = http.POST(body);
  bool ok = code >= 200 && code < 300;
  if (!ok) {
    Serial.print("POST ");
    Serial.print(url);
    Serial.print(" -> ");
    Serial.print(code);
    Serial.print(" ");
    Serial.println(http.getString());
  }
  http.end();
  return ok;
}

bool supabasePatch(const String &url, const String &body) {
  HTTPClient http;
  if (!http.begin(tls, url)) return false;
  httpAddAuthHeaders(http);
  int code = http.PATCH(body);
  bool ok = code >= 200 && code < 300;
  http.end();
  return ok;
}

String supabaseGet(const String &url) {
  HTTPClient http;
  if (!http.begin(tls, url)) return String();
  httpAddAuthHeaders(http);
  int code = http.GET();
  String payload;
  if (code >= 200 && code < 300) {
    payload = http.getString();
  } else {
    Serial.print("GET ");
    Serial.print(url);
    Serial.print(" -> ");
    Serial.println(code);
  }
  http.end();
  return payload;
}

void loadCalibration() {
  if (WiFi.status() != WL_CONNECTED) return;
  String payload = supabaseGet(configUrl);
  if (payload.isEmpty()) return;

  // PostgREST returns an array of rows.
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, payload)) return;
  if (!doc.is<JsonArray>() || doc.size() == 0) return;
  JsonObject row = doc[0];

  if (!row["pressure_zero_adc"].isNull())
    pressureZeroAdc = constrain((int)row["pressure_zero_adc"], 0, 4095);
  if (!row["pressure_mmhg_per_adc"].isNull())
    pressureMmHgPerAdc = constrain((float)row["pressure_mmhg_per_adc"], 0.01f, 2.0f);
  if (!row["bp_target_adc"].isNull())
    bpTargetAdc = constrain((int)row["bp_target_adc"], 0, 4095);
  if (!row["bp_max_adc"].isNull())
    bpMaxAdc = constrain((int)row["bp_max_adc"], 0, 4095);

  Serial.println("Calibration loaded");
}

void readTemperature() {
  if (!mlxReady) {
    bodyTempC = 0.0f;
    return;
  }

  float t = mlx.readObjectTempC();
  if (!isnan(t) && t > 20 && t < 45) {
    bodyTempC = t;
  }
}

void readHeartRate() {
  if (!maxReady) {
    heartRateBpm = 0;
    sensorValid = false;
    alertStatus = "NO_FINGER";
    return;
  }

  long irValue = max30102.getIR();
  sensorValid = irValue > 50000;

  if (!sensorValid) {
    heartRateBpm = 0;
    spo2Percent = 0;
    alertStatus = "NO_FINGER";
    return;
  }

  if (checkForBeat(irValue)) {
    static unsigned long lastBeat = 0;
    unsigned long now = millis();
    unsigned long delta = now - lastBeat;
    lastBeat = now;

    if (delta > 300 && delta < 2000) {
      int bpm = 60000 / delta;
      if (bpm >= 40 && bpm <= 180) {
        heartRateBpm = bpm;
      }
    }
  }

  // Basic placeholder until you calibrate the full SpO2 algorithm.
  spo2Percent = 98;

  if (heartRateBpm <= 0) alertStatus = "NORMAL";
  else if (heartRateBpm < 60) alertStatus = "LOW";
  else if (heartRateBpm > 100) alertStatus = "CRITICAL";
  else alertStatus = "NORMAL";
}

void measureBloodPressure() {
  if (measuring) return;
  measuring = true;

  Serial.println("BP measurement started");
  deflateCuff(1500);

  int peakAdc = 0;
  unsigned long start = millis();

  digitalWrite(PIN_VALVE, LOW);
  digitalWrite(PIN_PUMP, HIGH);

  while (millis() - start < BP_MAX_INFLATE_MS) {
    int adc = readPressureADC();
    peakAdc = max(peakAdc, adc);

    if (adc >= bpTargetAdc || adc >= bpMaxAdc) {
      break;
    }
    delay(50);
  }

  digitalWrite(PIN_PUMP, LOW);
  delay(800);

  float pressure = pressureToMmHg(peakAdc);

  // Estimate only. For real BP, calibrate using a known cuff and oscillometric algorithm.
  bpSystolic = constrain((int)(pressure * 0.90f), 80, 180);
  bpDiastolic = constrain((int)(bpSystolic * 0.67f), 50, 120);

  deflateCuff(5000);

  Serial.print("BP estimate: ");
  Serial.print(bpSystolic);
  Serial.print("/");
  Serial.println(bpDiastolic);

  measuring = false;
}

// Serialise the current reading into a Supabase row JSON object.
String buildReadingJson(bool includeDeviceId) {
  time_t now = time(nullptr);
  if (now < 100000) now = millis() / 1000;

  StaticJsonDocument<512> doc;
  if (includeDeviceId) doc["device_id"] = DEVICE_ID;
  doc["heart_rate"] = heartRateBpm;
  doc["spo2"] = spo2Percent;
  doc["temperature"] = bodyTempC;
  doc["bp_systolic"] = bpSystolic;
  doc["bp_diastolic"] = bpDiastolic;
  doc["sensor_valid"] = sensorValid;
  doc["alert"] = alertStatus;
  doc["device_timestamp"] = (long)now;
  doc["wifi_ssid"] = WiFi.SSID();
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["battery_percent"] = -1;
  doc["battery_voltage"] = 0;

  String out;
  serializeJson(doc, out);
  return out;
}

void uploadLiveData() {
  if (WiFi.status() != WL_CONNECTED) return;
  // Upsert on the device_id primary key.
  if (supabasePost(liveUrl, buildReadingJson(true), "resolution=merge-duplicates")) {
    Serial.println("live_data upserted");
  }
}

void uploadHistory() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (supabasePost(historyUrl, buildReadingJson(true), "return=minimal")) {
    Serial.println("readings_history inserted");
  }
}

void acknowledgeCommand(const String &status) {
  StaticJsonDocument<128> doc;
  doc["status"] = status;
  String body;
  serializeJson(doc, body);
  supabasePatch(commandUrl, body);
}

void checkCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  String payload = supabaseGet(commandUrl + "&select=action,status");
  if (payload.isEmpty()) return;

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, payload)) return;
  if (!doc.is<JsonArray>() || doc.size() == 0) return;
  JsonObject row = doc[0];

  const char *action = row["action"];
  const char *status = row["status"];
  if (!action) return;
  if (status && strcmp(status, "done") == 0) return;

  if (strcmp(action, "START") == 0) {
    measureBloodPressure();
    acknowledgeCommand("done");
  } else if (strcmp(action, "STOP") == 0) {
    stopActuators();
    deflateCuff(3000);
    acknowledgeCommand("done");
  } else if (strcmp(action, "RESET") == 0) {
    stopActuators();
    bpSystolic = 0;
    bpDiastolic = 0;
    acknowledgeCommand("done");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_VALVE, OUTPUT);
  stopActuators();

  String base = String(SUPABASE_URL) + "/rest/v1/";
  liveUrl    = base + "live_data";
  historyUrl = base + "readings_history";
  commandUrl = base + "device_commands?device_id=eq." + String(DEVICE_ID);
  configUrl  = base + "device_config?device_id=eq." + String(DEVICE_ID) + "&select=*";

  tls.setInsecure(); // skip TLS cert validation; pin the CA for production

  connectWiFi();
  initTime();
  initSensors();
  loadCalibration();

  Serial.println("Sit To Check ESP32 ready");
  Serial.println(liveUrl);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  readTemperature();
  readHeartRate();

  unsigned long now = millis();

  if (now - lastCommandCheck >= COMMAND_CHECK_MS) {
    lastCommandCheck = now;
    checkCommands();
  }

  if (now - lastCalibrationCheck >= CALIBRATION_CHECK_MS) {
    lastCalibrationCheck = now;
    loadCalibration();
  }

  if (now - lastLiveUpload >= LIVE_UPLOAD_MS) {
    lastLiveUpload = now;
    uploadLiveData();
  }

  if (now - lastHistoryUpload >= HISTORY_UPLOAD_MS) {
    lastHistoryUpload = now;
    uploadHistory();
  }

  delay(20);
}
