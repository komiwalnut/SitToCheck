# Sit to Check — Smart Health Monitoring Chair

A smart-chair health monitor. An **ESP32** reads heart rate, SpO₂, skin
temperature and an estimated blood pressure, and pushes them to **Supabase**
(PostgreSQL + Auth + Realtime). A static **web dashboard** shows live readings,
per-user history, health interpretations, and an admin panel for device control
and pressure calibration.

> ⚠️ For monitoring and research only — **not** a medical diagnostic device.

---

## Repository layout

```
SitToCheck/
├── index.html                  # Dashboard markup (auth + app shell)
├── css/style.css               # Styles
├── js/
│   ├── app.js                  # Dashboard logic (Supabase auth, Realtime, queries)
│   └── supabase-config.js      # Supabase URL + anon key  ← edit this
├── assets/logo.png
├── esp32/SitToCheck_ESP32/
│   ├── SitToCheck_ESP32.ino    # Firmware (posts to Supabase REST)
│   └── secrets.h.example       # Copy to secrets.h and fill in (git-ignored)
└── supabase/
    ├── schema.sql              # Tables, triggers, functions, Realtime
    ├── policies.sql            # Row Level Security policies
    └── seed.sql                # Default calibration + admin instructions
```

---

## 1. Create the GitHub repository & pull it

### Create it (GitHub CLI)

```bash
# from inside the project folder
gh repo create SitToCheck --public --source=. --remote=origin --push
```

### Or create it on the web

1. Go to <https://github.com/new>.
2. Name it **SitToCheck**, choose **Public**, and **do not** add a README/.gitignore
   (this project already has them). Click **Create repository**.
3. Connect your local folder and push:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/SitToCheck.git
   git push -u origin main
   ```

### Pull / clone it elsewhere

```bash
# first time on a new machine
git clone https://github.com/<your-username>/SitToCheck.git
cd SitToCheck

# later, to get the latest changes
git pull origin main
```

> 🔐 `secrets.h` and `.env` files are git-ignored so your real keys never get
> published. Copy `esp32/SitToCheck_ESP32/secrets.h.example` to `secrets.h`
> after cloning.

---

## 2. Set up Supabase (the backend)

1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor** and run the scripts **in order**:
   1. `supabase/schema.sql`
   2. `supabase/policies.sql`
   3. `supabase/seed.sql`
3. **Auth:** under **Authentication → Providers**, keep **Email** enabled. For
   quick local testing you can turn **"Confirm email"** off so new signups can
   log in immediately.
4. Grab your keys from **Project Settings → API**:
   - **Project URL** and **anon public** key → paste into `js/supabase-config.js`.
   - **service_role** key → paste into the ESP32 `secrets.h` (never in the browser).
5. **Make yourself an admin:** sign up through the web app once, then run in the
   SQL editor:

   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```

### Data model (replaces the old Firebase Realtime Database tree)

| Firebase RTDB                       | Postgres table            |
| ----------------------------------- | ------------------------- |
| `Users/{uid}/profile`               | `profiles`                |
| `Admins/{uid}`                      | `profiles.role = 'admin'` |
| `Users/{owner}/Live_Data`           | `live_data` (1 row/device) |
| `Users/{owner}/History`             | `readings_history`        |
| `Users/{uid}/Sessions`              | `sessions`                |
| `Users/{owner}/Commands`            | `device_commands`         |
| `DEVICE_CONFIG/{device}/calibration`| `device_config`           |
| `Admin_Logs`                        | `admin_logs`              |

---

## 3. Run the web dashboard

The dashboard is a static site (no build step). After setting
`js/supabase-config.js`, serve the folder over HTTP:

```bash
# any static server works, e.g.
python -m http.server 5500
# then open http://localhost:5500
```

Or deploy the repo to **GitHub Pages**, **Netlify**, **Vercel**, or
**Supabase Storage** static hosting. Add your deployed URL to Supabase
**Authentication → URL Configuration** so password-reset redirects work.

---

## 4. Flash the ESP32 firmware

1. In Arduino IDE, install the ESP32 board support and these libraries:
   - **ArduinoJson**
   - **Adafruit MLX90614**
   - **SparkFun MAX3010x Pulse and Proximity Sensor Library**
   (`WiFi`, `WiFiClientSecure`, `HTTPClient` ship with the ESP32 core.)
2. Copy `esp32/SitToCheck_ESP32/secrets.h.example` → `secrets.h` and fill in
   your WiFi credentials, `SUPABASE_URL`, and the `service_role` key.
3. Open `SitToCheck_ESP32.ino`, select your ESP32 board, and upload.

The device upserts `live_data` every 5 s, appends to `readings_history` every
60 s, polls `device_commands` every 3 s, and reloads `device_config` every 30 s.

---

## Security notes

- The **anon key** is safe in the browser — access is enforced by Postgres Row
  Level Security (`supabase/policies.sql`).
- The **service_role key** bypasses RLS and lives **only** in the device's
  git-ignored `secrets.h`. For production, prefer pinning the Supabase root CA
  in the firmware (`tls.setCACert(...)`) instead of `tls.setInsecure()`, and
  consider a device-scoped token or Edge Function instead of `service_role`.
