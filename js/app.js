// ============================================================================
// Sit to Check — dashboard application (Supabase backend)
// ----------------------------------------------------------------------------
// Data layer: Supabase (PostgreSQL + Auth + Realtime). All credentials live in
// js/supabase-config.js. Access is enforced server-side by Row Level Security.
// ============================================================================

import { supabase, DEVICE_ID } from './supabase-config.js';

let chart        = null;
let currentUID   = null;
let isAdmin      = false;
let activeMetric = 'hr';
let isReading    = false;
let latestReading = null;
let activeSession = null;
let sessionTimer = null;
let historyEntries = [];

// Chart data buffers (no IR)
const chartBuffers = { hr: [], spo2: [], temp: [], bp: [] };

let liveChannel   = null;   // Supabase Realtime channel for live_data
let offlineTimer  = null;
const OFFLINE_MS  = 20000;

const recentAlertsBuffer = [];

const $ = (id) => document.getElementById(id);

function safeText(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function safeNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// Device timestamps are epoch seconds (or ms). Render a clock label.
function tsLabel(ts) {
  if (!ts || ts < 1000000) return '--';
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString();
}
function tsDateTime(ts) {
  if (!ts || ts < 1000000) return '--';
  const ms = ts > 1e10 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}
// Render a Postgres timestamptz (ISO string) as a local date-time.
function isoDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString();
}

// Extract blood pressure from a database row.
function extractBP(d) {
  if (!d || typeof d !== 'object') return { systolic: null, diastolic: null };
  const sys = d.bp_systolic ?? d.systolic ?? null;
  const dia = d.bp_diastolic ?? d.diastolic ?? null;
  return {
    systolic: sys !== null && sys !== undefined ? safeNum(sys, 0) : null,
    diastolic: dia !== null && dia !== undefined ? safeNum(dia, 0) : null,
  };
}

function showAuth() {
  $('mainApp').style.display  = 'none';
  $('authPage').style.display = 'flex';
}
function showApp() {
  $('authPage').style.display = 'none';
  $('mainApp').style.display  = 'block';
}

$('hamburgerBtn').addEventListener('click', () => {
  const nav = $('sidebarNav');
  nav.classList.toggle('open');
  const status = $('sidebarStatus');
  status.style.display = nav.classList.contains('open') ? 'flex' : 'none';
});

$('goSignup').addEventListener('click', () => {
  $('loginBox').classList.add('hidden');
  $('signupBox').classList.remove('hidden');
  $('authMsg').textContent   = '';
  $('signupMsg').textContent = '';
});
$('backLogin').addEventListener('click', () => {
  $('signupBox').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  $('authMsg').textContent   = '';
  $('signupMsg').textContent = '';
});

// Forgot password.
function showForgotBox() {
  $('loginBox').classList.add('hidden');
  $('signupBox').classList.add('hidden');
  $('forgotBox').classList.remove('hidden');
  $('forgotMsg').textContent = '';
  $('forgotMsg').style.color = '#C0352A';
  $('forgotEmail').value = '';
}
function hideForgotBox() {
  $('forgotBox').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  $('authMsg').textContent = '';
}
$('goForgot').addEventListener('click', showForgotBox);
$('backFromForgot').addEventListener('click', hideForgotBox);
$('forgotBtn').addEventListener('click', async () => {
  const email = $('forgotEmail').value.trim();
  const msgEl = $('forgotMsg');
  msgEl.style.color = '#C0352A';
  msgEl.textContent = '';
  if (!email) { msgEl.textContent = 'Please enter your email address.'; return; }
  $('forgotBtn').disabled    = true;
  $('forgotBtn').textContent = 'Sending...';
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (!error) {
    msgEl.style.color = '#1B6B3A';
    msgEl.textContent = 'Reset link sent! Check your inbox (and spam folder).';
    $('forgotBtn').textContent = 'Sent';
    setTimeout(() => {
      hideForgotBox();
      $('forgotBtn').disabled    = false;
      $('forgotBtn').textContent = 'Send Reset Link';
    }, 3000);
  } else {
    msgEl.style.color  = '#C0352A';
    msgEl.textContent  = mapAuthError(error);
    $('forgotBtn').disabled    = false;
    $('forgotBtn').textContent = 'Send Reset Link';
  }
});

const ALL_BADGE_CLASSES = [
  'badge-online','badge-offline','badge-normal',
  'badge-low','badge-critical','badge-nosignal','badge-nofinger','badge-warning'
];
function applyBadge(el, text, cls) {
  el.classList.remove(...ALL_BADGE_CLASSES);
  el.classList.add(cls || 'badge-nosignal');
  el.textContent = text;
}
function setDbBadge(connected) {
  applyBadge($('fbStatus'), connected ? 'Connected' : 'Reconnecting...', connected ? 'badge-online' : 'badge-offline');
}
function setDeviceBadge(online) {
  applyBadge($('deviceStatus'), online ? 'Online' : 'Offline', online ? 'badge-online' : 'badge-offline');
}
function setAlertBadge(alertStr) {
  const upper = String(alertStr || '').toUpperCase();
  const map = {
    'NORMAL':    { text: 'Normal',    cls: 'badge-normal'   },
    'LOW':       { text: 'Low HR',    cls: 'badge-low'      },
    'CRITICAL':  { text: 'Critical',  cls: 'badge-critical' },
    'NO_FINGER': { text: 'No Finger', cls: 'badge-nofinger' },
  };
  const entry = map[upper] || { text: 'No Signal', cls: 'badge-nosignal' };
  applyBadge($('alertBadge'), entry.text, entry.cls);
}

const ALL_SECTIONS = ['secDashboard','secHistory','secProfile','secAdmin'];
const ALL_NAV      = ['navDash','navHistory','navProfile','navAdmin'];

function showSection(sectionId, navId) {
  ALL_SECTIONS.forEach(id => $(id).classList.add('hidden'));
  ALL_NAV.forEach(id => $(id).classList.remove('active'));
  $(sectionId).classList.remove('hidden');
  if (navId) $(navId).classList.add('active');
  if (window.innerWidth <= 768) {
    $('sidebarNav').classList.remove('open');
    $('sidebarStatus').style.display = 'none';
  }
}

$('navDash').addEventListener('click',    () => showSection('secDashboard', 'navDash'));
$('navHistory').addEventListener('click', () => { showSection('secHistory', 'navHistory'); loadHistory(); });
$('navProfile').addEventListener('click', () => showSection('secProfile',   'navProfile'));
$('navAdmin').addEventListener('click',   () => { showSection('secAdmin', 'navAdmin'); loadAdminPanel(); });

// Map a Supabase auth error to a friendly message.
function mapAuthError(error) {
  const msg = (error && error.message ? error.message : String(error || '')).toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Invalid email or password.';
  if (msg.includes('email not confirmed'))       return 'Please confirm your email before signing in.';
  if (msg.includes('user already registered') ||
      msg.includes('already been registered'))   return 'This email is already registered.';
  if (msg.includes('password') && msg.includes('6')) return 'Password must be at least 6 characters.';
  if (msg.includes('unable to validate email') ||
      msg.includes('invalid email'))              return 'Please enter a valid email address.';
  if (msg.includes('rate limit') || msg.includes('too many')) return 'Too many attempts. Please wait a moment.';
  if (msg.includes('network'))                    return 'Network error. Check your connection.';
  return 'Error: ' + safeText(error && error.message ? error.message : String(error));
}

$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPassword').value;
  $('authMsg').textContent = '';
  if (!email || !pass) { $('authMsg').textContent = 'Please fill in both fields.'; return; }
  $('loginBtn').disabled    = true;
  $('loginBtn').textContent = 'Signing in...';
  const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) {
    $('authMsg').textContent  = mapAuthError(error);
    $('loginBtn').disabled    = false;
    $('loginBtn').textContent = 'Sign In';
  }
  // On success, onAuthStateChange drives the UI transition.
});

$('signupBtn').addEventListener('click', async () => {
  const first = $('signupFirst').value.trim();
  const last  = $('signupLast').value.trim();
  const age   = safeNum($('signupAge').value, 0);
  const email = $('signupEmail').value.trim();
  const pass  = $('signupPassword').value;
  const msgEl = $('signupMsg');
  msgEl.style.color = '#C0352A';
  msgEl.textContent = '';
  if (!first || !last || !age || !email || !pass) { msgEl.textContent = 'Please fill in all fields.'; return; }
  if (age < 1 || age > 120)                       { msgEl.textContent = 'Please enter a valid age (1-120).'; return; }
  if (pass.length < 6)                            { msgEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (!$('consentCheck').checked)                  { msgEl.textContent = 'Please confirm the monitoring and research consent note.'; return; }
  $('signupBtn').disabled    = true;
  $('signupBtn').textContent = 'Creating account...';
  // Profile row is created server-side by the on_auth_user_created trigger,
  // which reads these fields from the user metadata.
  const { data, error } = await supabase.auth.signUp({
    email,
    password: pass,
    options: {
      data: { first_name: first, last_name: last, age, consent_accepted: true },
    },
  });
  if (error) {
    msgEl.style.color  = '#C0352A';
    msgEl.textContent  = mapAuthError(error);
    $('signupBtn').disabled    = false;
    $('signupBtn').textContent = 'Create Account';
    return;
  }
  msgEl.style.color = '#1B6B3A';
  // If email confirmation is enabled there is no session yet.
  if (data.session) {
    msgEl.textContent = 'Account created! Signing in...';
  } else {
    msgEl.textContent = 'Account created! Check your email to confirm, then sign in.';
    $('signupBtn').disabled    = false;
    $('signupBtn').textContent = 'Create Account';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  teardown();
  await supabase.auth.signOut();
});

// Start reading button.
function speakReadingPrompt() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const msg = new SpeechSynthesisUtterance(
    'Starting health reading. Please sit properly and place your finger on the sensor. ' +
    'Getting blood pressure, and oxygen level.'
  );
  msg.rate   = 0.95;
  msg.pitch  = 1.0;
  msg.volume = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Natural')));
  if (preferred) msg.voice = preferred;
  window.speechSynthesis.speak(msg);
}

function setReadingState(active) {
  isReading = active;
  const btn      = $('startReadingBtn');
  const iconEl   = $('startReadingIcon');
  const textEl   = $('startReadingText');
  const bannerEl = $('readingBanner');
  if (active) {
    btn.classList.add('reading-active');
    iconEl.textContent = '||';
    textEl.textContent = 'Reading Active...';
    bannerEl.classList.add('active');
  } else {
    btn.classList.remove('reading-active');
    iconEl.textContent = '>';
    textEl.textContent = 'Start Reading';
    bannerEl.classList.remove('active');
  }
}

function renderSessionSummary(session) {
  if (!session) return;
  $('sessionSummary').classList.remove('hidden');
  updateRiskBadge($('sessionRisk'), { level: session.riskLevel || 'Unknown', cls: session.riskClass || 'risk-unknown' });
  const bp = session.bp_systolic ? `${session.bp_systolic}/${session.bp_diastolic || '--'} mmHg` : '--';
  const items = [
    ['Completed', isoDateTime(session.ended_at)],
    ['Heart Rate', session.heart_rate > 0 ? `${session.heart_rate} bpm` : '--'],
    ['SpO2', session.spo2 >= 70 ? `${session.spo2}%` : '--'],
    ['Temperature', session.temperature > 0 ? `${Number(session.temperature).toFixed(1)} °C` : '--'],
    ['Blood Pressure', bp],
    ['Device', session.device_online ? 'Online' : 'Offline'],
  ];
  $('sessionDetails').innerHTML = items.map(([label, value]) =>
    `<div class="session-pill"><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`
  ).join('');
}

// Upsert a START command for the device to pick up.
async function sendStartCommand() {
  if (!currentUID) return;
  return supabase.from('device_commands').upsert({
    device_id: DEVICE_ID, action: 'START', issued_by: currentUID, status: 'pending',
  }, { onConflict: 'device_id' });
}

async function finishReadingSession(reason = 'completed') {
  if (!activeSession || !currentUID) return;
  const reading = latestReading || {};
  const risk = classifyRisk(
    safeNum(reading.heart_rate, 0),
    safeNum(reading.spo2, -1),
    safeNum(reading.temperature, 0),
    reading.sensor_valid === true,
    !!latestReading,
    reading.bp_systolic ?? null,
    reading.bp_diastolic ?? null
  );
  const startedMs = activeSession.startedAt;
  const endedMs   = Date.now();
  const payload = {
    user_id: currentUID,
    device_id: DEVICE_ID,
    started_at: new Date(startedMs).toISOString(),
    ended_at: new Date(endedMs).toISOString(),
    reason,
    heart_rate: safeNum(reading.heart_rate, 0),
    spo2: safeNum(reading.spo2, -1),
    temperature: safeNum(reading.temperature, 0),
    bp_systolic: reading.bp_systolic ?? null,
    bp_diastolic: reading.bp_diastolic ?? null,
    sensor_valid: reading.sensor_valid === true,
    risk_level: risk.level,
    risk_class: risk.cls,
    device_online: !!latestReading,
  };
  const { error } = await supabase.from('sessions').insert(payload);
  const summary = { ...payload, riskLevel: risk.level, riskClass: risk.cls };
  if (error) {
    console.warn('[Session] Save failed:', error.message);
    renderSessionSummary({ ...summary, reason: 'local-only' });
  } else {
    renderSessionSummary(summary);
  }
  activeSession = null;
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  setReadingState(false);
}

$('startReadingBtn').addEventListener('click', async () => {
  if (isReading) {
    await finishReadingSession('stopped');
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    return;
  }
  setReadingState(true);
  activeSession = { startedAt: Date.now() };
  speakReadingPrompt();
  try {
    const res = await sendStartCommand();
    if (res && res.error) throw res.error;
    if (isAdmin) {
      await supabase.from('admin_logs').insert({
        action: 'Command sent: START -> ' + DEVICE_ID + ' (via Start Reading button)',
        user_id: currentUID,
      });
    }
  } catch (e) {
    console.warn('[StartReading] Command failed:', e.message);
  }
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { if (isReading) finishReadingSession('completed'); }, 60000);
});
if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
}

// ── Chart (4 tabs) ──
const METRIC_CONFIG = {
  hr:   { label: 'Heart Rate (bpm)',      color: '#E03C31', bg: 'rgba(224,60,49,0.08)',   yMin: 30,  yMax: 160, yTitle: 'bpm'  },
  spo2: { label: 'SpO2 (%)',              color: '#1B4F8A', bg: 'rgba(27,79,138,0.08)',   yMin: 85,  yMax: 100, yTitle: '%'    },
  temp: { label: 'Temperature (°C)',      color: '#7A5C1E', bg: 'rgba(122,92,30,0.08)',   yMin: 34,  yMax: 40,  yTitle: '°C'   },
  bp:   { label: 'Blood Pressure (mmHg)', color: '#922218', bg: 'rgba(146,34,24,0.08)',   yMin: 60,  yMax: 200, yTitle: 'mmHg' },
};

const TAB_ACTIVE_CLASSES = { hr:'active-hr', spo2:'active-spo2', temp:'active-temp', bp:'active-bp' };

function initChart() {
  if (chart) { chart.destroy(); chart = null; }
  const cfg = METRIC_CONFIG[activeMetric];
  chart = new Chart($('hrChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: chartBuffers[activeMetric].map(p => p.label),
      datasets: [{
        label: cfg.label,
        data:  chartBuffers[activeMetric].map(p => p.value),
        borderColor: cfg.color,
        backgroundColor: cfg.bg,
        borderWidth: 2,
        tension: 0.4,
        pointRadius: 4,
        pointBackgroundColor: cfg.color,
        fill: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { labels: { color: '#4B5563', font: { size: 12 }, boxWidth: 0, boxHeight: 0 } },
        tooltip: { mode: 'index', intersect: false,
                   backgroundColor: 'rgba(26,29,33,0.92)', titleColor: '#FAFBFC', bodyColor: '#9CA3AF' }
      },
      scales: {
        y: { min: cfg.yMin, suggestedMax: cfg.yMax,
             grid: { color: 'rgba(213,217,224,0.5)' }, ticks: { color: '#4B5563' },
             title: { display: true, text: cfg.yTitle, color: '#4B5563' } },
        x: { grid: { color: 'rgba(213,217,224,0.5)' }, ticks: { color: '#4B5563', maxTicksLimit: 6 },
             title: { display: true, text: 'Time', color: '#4B5563' } }
      }
    }
  });
}

function updateChartMetric(metric) {
  if (!chart) return;
  activeMetric = metric;
  const cfg = METRIC_CONFIG[metric];
  chart.data.labels = chartBuffers[metric].map(p => p.label);
  chart.data.datasets[0].label = cfg.label;
  chart.data.datasets[0].data  = chartBuffers[metric].map(p => p.value);
  chart.data.datasets[0].borderColor = cfg.color;
  chart.data.datasets[0].backgroundColor = cfg.bg;
  chart.data.datasets[0].pointBackgroundColor = cfg.color;
  chart.options.scales.y.min = cfg.yMin;
  chart.options.scales.y.suggestedMax = cfg.yMax;
  chart.options.scales.y.title.text = cfg.yTitle;
  chart.update('none');
}

function pushToBuffer(metric, value, tsSeconds) {
  if (!Number.isFinite(value)) return;
  const ms    = tsSeconds > 1e9 ? tsSeconds * 1000 : Date.now();
  const label = new Date(ms).toLocaleTimeString();
  const buf   = chartBuffers[metric];
  buf.push({ label, value });
  if (buf.length > 20) buf.shift();
  if (activeMetric === metric && chart) {
    chart.data.labels = buf.map(p => p.label);
    chart.data.datasets[0].data = buf.map(p => p.value);
    chart.update('none');
  }
}

['tabHR', 'tabSpo2', 'tabTemp', 'tabBP'].forEach(tabId => {
  $(tabId).addEventListener('click', () => {
    const metric = $(tabId).dataset.metric;
    $('tabHR').className   = 'chart-tab';
    $('tabSpo2').className = 'chart-tab';
    $('tabTemp').className = 'chart-tab';
    $('tabBP').className   = 'chart-tab';
    $(tabId).classList.add(TAB_ACTIVE_CLASSES[metric]);
    updateChartMetric(metric);
  });
});

// Blood pressure interpretation.
function interpBP(systolic, diastolic) {
  if (systolic === null && diastolic === null) {
    return { label: 'No reading', cls: 'interp-none' };
  }
  const sys = systolic ?? 0;
  const dia = diastolic ?? 0;
  if (sys <= 0) return { label: 'No reading', cls: 'interp-none' };
  if (sys >= 180 || dia >= 120) return { label: 'Hypertensive Crisis', cls: 'interp-above' };
  if (sys >= 140 || dia >= 90)  return { label: 'High BP (Stage 2)',   cls: 'interp-above' };
  if (sys >= 130 || dia >= 85)  return { label: 'High BP (Stage 1)',   cls: 'interp-above' };
  if (sys >= 120 && dia < 80)   return { label: 'Elevated',            cls: 'interp-elevated' };
  if (sys < 90  || dia < 60)    return { label: 'Low BP',              cls: 'interp-below'   };
  return                               { label: 'Normal',               cls: 'interp-normal'  };
}

function formatBP(systolic, diastolic) {
  if (systolic === null && diastolic === null) return '--/--';
  if (systolic !== null && diastolic !== null) return `${Math.round(systolic)}/${Math.round(diastolic)}`;
  if (systolic !== null) return `${Math.round(systolic)}/--`;
  return `--/${Math.round(diastolic)}`;
}

function classifyRisk(hr, spo2, temp, sensorValid, deviceOnline, bpSys, bpDia) {
  if (!deviceOnline || !sensorValid) return { level: 'Unknown', cls: 'risk-unknown' };
  const critical =
    (spo2 >= 70 && spo2 < 92) ||
    (hr > 0 && (hr > 120 || hr < 45)) ||
    (temp >= 38.0) ||
    (bpSys !== null && (bpSys >= 140 || bpSys < 85)) ||
    (bpDia !== null && (bpDia >= 90 || bpDia < 50));
  if (critical) return { level: 'Critical', cls: 'risk-critical' };

  const caution =
    (spo2 >= 92 && spo2 < 95) ||
    (hr > 0 && (hr > 100 || hr < 60)) ||
    (temp > 37.5 || (temp > 0 && temp < 36.0)) ||
    (bpSys !== null && (bpSys >= 130 || bpSys < 90)) ||
    (bpDia !== null && (bpDia >= 85 || bpDia < 60));
  if (caution) return { level: 'Caution', cls: 'risk-caution' };

  return { level: 'Normal', cls: 'risk-normal' };
}

function updateRiskBadge(el, risk) {
  el.className = 'risk-badge ' + risk.cls;
  el.textContent = 'Risk: ' + risk.level;
}

// Overall health status.
function computeOverallStatus(hr, spo2, temp, sensorValid, deviceOnline, alertStr, bpSys, bpDia) {
  if (!deviceOnline) return {
    text: 'Device Offline', icon: '--', rec: 'The device is not sending data. Check power and WiFi connection.',
    cardClass: 'health-status-neutral', textColor: '#9CA3AF'
  };
  if (!sensorValid) return {
    text: 'Sensor Invalid', icon: '!', rec: 'Sensor readings are invalid. Clean the sensor or re-seat your finger.',
    cardClass: 'health-status-warning', textColor: '#7A5C1E'
  };
  const upper = String(alertStr || '').toUpperCase();
  if (upper === 'NO_FINGER' || (hr <= 0 && spo2 < 70)) return {
    text: 'No Finger Detected', icon: '--', rec: 'Place your finger on the sensor to begin a reading.',
    cardClass: 'health-status-neutral', textColor: '#9CA3AF'
  };

  const issues = [];
  if (hr > 0 && hr > 100)       issues.push({ sev: 'critical', msg: 'High heart rate detected. Rest and avoid exertion.' });
  if (hr > 0 && hr < 60)        issues.push({ sev: 'warning',  msg: 'Low heart rate detected. Consult a physician if persistent.' });
  if (spo2 >= 70 && spo2 < 95)  issues.push({ sev: 'critical', msg: 'Low blood oxygen. Seek medical attention if below 90%.' });
  if (temp > 0 && temp > 37.5)  issues.push({ sev: 'warning',  msg: 'Elevated temperature. Monitor closely and stay hydrated.' });

  if (bpSys !== null && bpSys > 0) {
    if (bpSys >= 180 || (bpDia !== null && bpDia >= 120))
      issues.push({ sev: 'critical', msg: 'Hypertensive crisis! Seek immediate medical attention.' });
    else if (bpSys >= 140)
      issues.push({ sev: 'critical', msg: 'High blood pressure (Stage 2). Please consult a doctor.' });
    else if (bpSys >= 130)
      issues.push({ sev: 'warning',  msg: 'Blood pressure elevated (Stage 1). Lifestyle changes recommended.' });
    else if (bpSys < 90)
      issues.push({ sev: 'warning',  msg: 'Low blood pressure detected. Stay hydrated and avoid sudden movements.' });
  }

  if (issues.length === 0 && hr > 0) return {
    text: 'Normal', icon: 'OK', rec: "All readings are within normal range. You're looking good!",
    cardClass: 'health-status-normal', textColor: '#1B6B3A'
  };
  const hasCritical = issues.some(i => i.sev === 'critical');
  const topIssue    = issues[0];
  return {
    text: hasCritical ? 'Attention Required' : 'Monitor',
    icon: hasCritical ? '!' : '!',
    rec:  topIssue ? topIssue.msg : 'Check your readings.',
    cardClass: hasCritical ? 'health-status-critical' : 'health-status-warning',
    textColor: hasCritical ? '#C0352A' : '#7A5C1E'
  };
}

function updateOverallHealth(hr, spo2, temp, sensorValid, deviceOnline, alertStr, bpSys, bpDia) {
  const s = computeOverallStatus(hr, spo2, temp, sensorValid, deviceOnline, alertStr, bpSys, bpDia);
  const risk = classifyRisk(hr, spo2, temp, sensorValid, deviceOnline, bpSys, bpDia);
  const card = $('overallHealthCard');
  card.className = 'health-status-card ' + s.cardClass;
  $('overallStatusText').textContent     = s.text;
  $('overallStatusText').style.color     = s.textColor;
  $('overallRecommendation').textContent = s.rec;
  $('overallStatusIcon').textContent     = s.icon;
  updateRiskBadge($('riskBadge'), risk);
}

function interpHR(hr, sensorValid) {
  if (!sensorValid) return { label: 'Sensor invalid', cls: 'interp-invalid' };
  if (hr <= 0)      return { label: 'No reading',     cls: 'interp-none'    };
  if (hr < 60)      return { label: 'Below normal',   cls: 'interp-below'   };
  if (hr > 100)     return { label: 'Above normal',   cls: 'interp-above'   };
  return                   { label: 'Normal',          cls: 'interp-normal'  };
}
function interpSpO2(spo2, sensorValid) {
  if (!sensorValid)             return { label: 'Sensor invalid', cls: 'interp-invalid' };
  if (spo2 < 70 || spo2 > 100) return { label: 'No reading',     cls: 'interp-none'    };
  if (spo2 < 95)                return { label: 'Below normal',   cls: 'interp-below'   };
  return                               { label: 'Normal',          cls: 'interp-normal'  };
}
function interpTemp(temp, sensorValid) {
  if (!sensorValid) return { label: 'Sensor invalid', cls: 'interp-invalid' };
  if (temp <= 0)    return { label: 'No reading',     cls: 'interp-none'    };
  if (temp < 36.0)  return { label: 'Below normal',   cls: 'interp-below'   };
  if (temp > 37.5)  return { label: 'Above normal',   cls: 'interp-above'   };
  return                   { label: 'Normal',          cls: 'interp-normal'  };
}

function applyInterp(el, interp) {
  el.textContent = interp.label;
  el.className   = 'interp-tag ' + interp.cls;
}

// ── Recent alerts ──
const HEALTH_ALERT_KEYWORDS = [
  'high heart rate','low heart rate','low spo2','high temperature',
  'no finger','sensor invalid','device offline','high bp','low bp',
  'hypertensive','blood pressure','elevated bp'
];

function isHealthAlert(alertStr) {
  if (!alertStr) return false;
  const lower = String(alertStr).toLowerCase();
  return HEALTH_ALERT_KEYWORDS.some(kw => lower.includes(kw)) ||
    ['CRITICAL','LOW','NO_FINGER','SENSOR_INVALID','OFFLINE','HIGH_BP','LOW_BP'].includes(String(alertStr).toUpperCase());
}

function alertMeta(alertStr) {
  const upper = String(alertStr || '').toUpperCase();
  if (upper === 'CRITICAL')       return { dot: '#C0352A', label: 'High Heart Rate' };
  if (upper === 'LOW')            return { dot: '#7A5C1E', label: 'Low Heart Rate' };
  if (upper === 'NO_FINGER')      return { dot: '#9CA3AF', label: 'No Finger Detected' };
  if (upper === 'SENSOR_INVALID') return { dot: '#C0352A', label: 'Sensor Invalid' };
  if (upper === 'OFFLINE')        return { dot: '#C0352A', label: 'Device Offline' };
  if (upper === 'HIGH_BP')        return { dot: '#922218', label: 'High Blood Pressure' };
  if (upper === 'LOW_BP')         return { dot: '#7A5C1E', label: 'Low Blood Pressure' };
  const lower = String(alertStr).toLowerCase();
  if (lower.includes('spo2'))        return { dot: '#1B4F8A', label: 'Low SpO2' };
  if (lower.includes('temperature')) return { dot: '#7A5C1E', label: 'High Temperature' };
  if (lower.includes('blood pressure') || lower.includes('bp')) return { dot: '#922218', label: 'BP Alert' };
  return { dot: '#9CA3AF', label: String(alertStr) };
}

function pushAlert(alertStr, ts, hr, spo2, temp, bpSys, bpDia) {
  if (!isHealthAlert(alertStr)) return;
  recentAlertsBuffer.unshift({ alertStr, ts, hr, spo2, temp, bpSys, bpDia, addedAt: Date.now() });
  if (recentAlertsBuffer.length > 20) recentAlertsBuffer.pop();
  renderRecentAlerts();
}

function renderRecentAlerts() {
  const el = $('recentAlerts');
  if (recentAlertsBuffer.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:24px;color:#9CA3AF;font-size:13px;">
      <div style="font-size:28px;margin-bottom:8px;">!</div>No health alerts recorded yet</div>`;
    return;
  }
  el.innerHTML = '';
  recentAlertsBuffer.forEach(a => {
    const meta = alertMeta(a.alertStr);
    const item = document.createElement('div');
    item.className = 'alert-item';

    const dot = document.createElement('div');
    dot.className = 'alert-dot';
    dot.style.background = meta.dot;

    const body = document.createElement('div');
    body.style.flex = '1';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;color:#1A1D21;';
    title.textContent = meta.label;

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:11px;color:#9CA3AF;margin-top:3px;';
    const parts = [];
    if (a.hr   > 0) parts.push(`HR: ${a.hr} bpm`);
    if (a.spo2 >= 70 && a.spo2 <= 100) parts.push(`SpO2: ${a.spo2}%`);
    if (a.temp > 0) parts.push(`Temp: ${a.temp.toFixed(1)} °C`);
    if (a.bpSys !== null && a.bpSys > 0) {
      parts.push(`BP: ${a.bpDia !== null ? a.bpSys + '/' + a.bpDia : a.bpSys} mmHg`);
    }
    detail.textContent = parts.join(' · ') || '--';

    const time = document.createElement('div');
    time.style.cssText = 'font-size:11px;color:#9CA3AF;margin-top:2px;';
    time.textContent = tsLabel(a.ts);

    body.appendChild(title);
    body.appendChild(detail);
    body.appendChild(time);
    item.appendChild(dot);
    item.appendChild(body);
    el.appendChild(item);
  });
}

// ── Dashboard reset ──
function resetDashboard(statusText) {
  latestReading = null;
  $('metricHR').textContent   = '--';
  $('metricSpO2').textContent = '--';
  $('metricTemp').textContent = '--';
  $('metricBP').textContent   = '--/--';
  ['wifiSsid','wifiRssi','sensorValid','lastTs','batteryLevel'].forEach(id => $(id).textContent = '--');
  $('lastUpdatedLabel').textContent = statusText || 'Waiting for device...';
  applyBadge($('alertBadge'), statusText || 'No Signal', 'badge-nosignal');
  applyInterp($('interpHR'),   { label: 'No reading', cls: 'interp-none' });
  applyInterp($('interpSpO2'), { label: 'No reading', cls: 'interp-none' });
  applyInterp($('interpTemp'), { label: 'No reading', cls: 'interp-none' });
  applyInterp($('interpBP'),   { label: 'No reading', cls: 'interp-none' });
  updateOverallHealth(0, -1, 0, false, false, '', null, null);
}

function armOfflineTimer() {
  if (offlineTimer) clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => {
    latestReading = null;
    setDeviceBadge(false);
    applyBadge($('alertBadge'), 'Device Offline', 'badge-nosignal');
    $('lastUpdatedLabel').textContent = 'No data received in 20s';
    updateOverallHealth(0, -1, 0, false, false, '', null, null);
  }, OFFLINE_MS);
}

// Apply a single live_data row to the dashboard.
function applyLiveRow(d) {
  armOfflineTimer();

  if (!d || typeof d !== 'object') {
    resetDashboard('No data from device yet');
    setDeviceBadge(false);
    return;
  }

  const hr       = safeNum(d.heart_rate, 0);
  const spo2     = safeNum(d.spo2, -1);
  const temp     = safeNum(d.temperature, 0);
  const ts       = safeNum(d.device_timestamp, 0);
  const valid    = d.sensor_valid === true;
  const rssi     = safeNum(d.wifi_rssi, 0);
  const ssid     = typeof d.wifi_ssid === 'string' ? d.wifi_ssid : '';
  const alertStr = typeof d.alert === 'string' ? d.alert : '';

  const { systolic, diastolic } = extractBP(d);
  const batteryPercent = d.battery_percent !== null && d.battery_percent !== undefined ? safeNum(d.battery_percent, -1) : -1;
  const batteryVoltage = d.battery_voltage !== null && d.battery_voltage !== undefined ? safeNum(d.battery_voltage, 0) : 0;
  latestReading = {
    ...d,
    heart_rate: hr,
    spo2,
    temperature: temp,
    bp_systolic: systolic,
    bp_diastolic: diastolic,
    sensor_valid: valid,
  };

  $('metricHR').textContent   = hr   > 0                     ? hr              : '--';
  $('metricTemp').textContent = temp > 0                     ? temp.toFixed(1) : '--';
  $('metricSpO2').textContent = (valid && spo2 >= 70 && spo2 <= 100) ? spo2 + '%' : '--';
  $('metricBP').textContent = (systolic !== null && systolic > 0) ? formatBP(systolic, diastolic) : '--/--';
  $('wifiSsid').textContent    = ssid || '--';
  $('wifiRssi').textContent    = rssi ? rssi + ' dBm' : '--';
  $('sensorValid').textContent = valid ? 'Yes' : 'No';
  $('batteryLevel').textContent = batteryPercent >= 0
    ? `${Math.round(batteryPercent)}%`
    : (batteryVoltage > 0 ? `${batteryVoltage.toFixed(2)} V` : '--');

  if (ts > 1000000) {
    const tsMs = ts > 1e10 ? ts : ts * 1000;
    $('lastTs').textContent           = new Date(tsMs).toLocaleTimeString();
    $('lastUpdatedLabel').textContent = 'Updated ' + new Date(tsMs).toLocaleTimeString();
  } else if (d.updated_at) {
    $('lastTs').textContent           = new Date(d.updated_at).toLocaleTimeString();
    $('lastUpdatedLabel').textContent = 'Updated ' + new Date(d.updated_at).toLocaleTimeString();
  } else {
    $('lastTs').textContent           = 'Time not synced';
    $('lastUpdatedLabel').textContent = 'Device time unsynced';
  }

  applyInterp($('interpHR'),   interpHR(hr, valid));
  applyInterp($('interpSpO2'), interpSpO2(spo2, valid));
  applyInterp($('interpTemp'), interpTemp(temp, valid));
  applyInterp($('interpBP'),   interpBP(systolic, diastolic));

  setDeviceBadge(true);

  const derivedAlert = alertStr || (hr > 100 ? 'CRITICAL' : hr > 0 && hr < 60 ? 'LOW' : hr > 0 ? 'NORMAL' : 'NO_FINGER');
  setAlertBadge(derivedAlert);

  let bpAlert = null;
  if (systolic !== null && systolic > 0 && systolic >= 140) bpAlert = 'HIGH_BP';
  else if (systolic !== null && systolic > 0 && systolic < 90) bpAlert = 'LOW_BP';
  updateOverallHealth(hr, spo2, temp, valid, true, derivedAlert, systolic, diastolic);

  if (activeSession) {
    if (hr   > 0  && hr   <= 250)  pushToBuffer('hr',   hr,       ts);
    if (spo2 >= 70 && spo2 <= 100) pushToBuffer('spo2', spo2,     ts);
    if (temp > 0  && temp <= 50)   pushToBuffer('temp', temp,     ts);
    if (systolic !== null && systolic > 0) pushToBuffer('bp', systolic, ts);
  }

  const finalAlert = bpAlert || (derivedAlert !== 'NORMAL' ? derivedAlert : null);
  if (finalAlert && activeSession) pushAlert(finalAlert, ts, hr, spo2, temp, systolic, diastolic);
}

// Live data: initial fetch + Realtime subscription on the device's row.
async function attachLiveDataListener() {
  if (liveChannel) { supabase.removeChannel(liveChannel); liveChannel = null; }

  // Initial snapshot.
  const { data, error } = await supabase
    .from('live_data').select('*').eq('device_id', DEVICE_ID).maybeSingle();
  if (error) {
    console.error('[LiveData] Fetch error:', error.message);
    resetDashboard('Error loading device data');
    setDeviceBadge(false);
  } else if (data) {
    applyLiveRow(data);
  } else {
    resetDashboard('No data from device yet');
    setDeviceBadge(false);
  }

  // Realtime updates.
  liveChannel = supabase
    .channel('live_data:' + DEVICE_ID)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'live_data', filter: 'device_id=eq.' + DEVICE_ID },
      (payload) => { if (payload.new) applyLiveRow(payload.new); })
    .subscribe((status) => {
      const connected = status === 'SUBSCRIBED';
      setDbBadge(connected);
      const banner = $('fbBanner');
      if (connected) {
        banner.className = 'show conn';
        banner.textContent = 'Connected';
        setTimeout(() => { banner.className = ''; banner.textContent = ''; }, 3000);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        banner.className = 'show disc';
        banner.textContent = 'Disconnected - reconnecting...';
      }
    });
}

// Profile + admin role (replaces the Firebase Admins listener).
async function loadProfile(uid) {
  try {
    const { data: p, error } = await supabase
      .from('profiles').select('first_name,last_name,age,email,role').eq('id', uid).maybeSingle();
    if (error) throw error;
    if (p) {
      const firstName = typeof p.first_name === 'string' ? p.first_name : '';
      const lastName  = typeof p.last_name  === 'string' ? p.last_name  : '';
      $('profName').textContent  = [firstName, lastName].filter(Boolean).join(' ') || '(name not set)';
      $('profAge').textContent   = p.age != null ? String(p.age) : '--';
      $('profEmail').textContent = typeof p.email === 'string' ? p.email : '--';
      applyAdminState(p.role === 'admin');
    } else {
      $('profName').textContent  = '(profile not found)';
      $('profAge').textContent   = '--';
      $('profEmail').textContent = '--';
      applyAdminState(false);
    }
  } catch (e) {
    console.warn('[Profile] Load failed:', e.message);
    $('profName').textContent = '(load error)';
    applyAdminState(false);
  }
}

function applyAdminState(admin) {
  isAdmin = admin;
  if (isAdmin) {
    $('navAdmin').classList.remove('hidden');
    $('deviceInfoBar').style.display = 'flex';
  } else {
    $('navAdmin').classList.add('hidden');
    $('deviceInfoBar').style.display = 'none';
    if (!$('secAdmin').classList.contains('hidden')) showSection('secDashboard', 'navDash');
  }
}

// History — the signed-in user's reading sessions.
async function loadHistory() {
  if (!currentUID) return;
  const wrap = $('historyContent');
  historyEntries = [];
  wrap.innerHTML = `<div style="text-align:center;padding:32px;color:#9CA3AF;font-size:13px;">Loading history...</div>`;

  const { data, error } = await supabase
    .from('sessions').select('*').eq('user_id', currentUID)
    .order('started_at', { ascending: false }).limit(100);

  if (error) {
    wrap.innerHTML = `<div style="padding:16px;font-size:13px;color:#C0352A;">Error loading history: ${safeText(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    wrap.innerHTML = `<div style="text-align:center;padding:40px;color:#9CA3AF;">
      <div style="font-size:36px;margin-bottom:12px;">History</div>
      <div style="font-size:15px;font-weight:600;color:#4B5563;margin-bottom:6px;">No History Yet</div>
      <div style="font-size:13px;">Previous readings will appear here once the device starts saving history.</div>
    </div>`;
    return;
  }

  historyEntries = data;

  const table = document.createElement('table');
  table.className = 'hist-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Session Time', 'Heart Rate', 'SpO2', 'Temperature', 'Blood Pressure', 'Risk Level'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  data.forEach(e => {
    const tr = document.createElement('tr');
    const hr   = safeNum(e.heart_rate, 0);
    const spo2 = safeNum(e.spo2, -1);
    const temp = safeNum(e.temperature, 0);
    const { systolic, diastolic } = extractBP(e);
    const bpStr = (systolic !== null) ? formatBP(systolic, diastolic) + ' mmHg' : '--';

    const riskMap = {
      'Normal':   { text: 'Normal',   color: '#1B6B3A' },
      'Caution':  { text: 'Caution',  color: '#7A5C1E' },
      'Critical': { text: 'Critical', color: '#C0352A' },
      'Unknown':  { text: 'Unknown',  color: '#9CA3AF' },
    };
    const riskLevel = typeof e.risk_level === 'string' ? e.risk_level : 'Unknown';
    const sEntry = riskMap[riskLevel] || { text: 'Unknown', color: '#9CA3AF' };

    const cells = [
      isoDateTime(e.ended_at || e.started_at),
      hr   > 0                    ? hr + ' bpm'            : '--',
      spo2 >= 70 && spo2 <= 100  ? spo2 + '%'             : '--',
      temp > 0                    ? temp.toFixed(1) + ' °C' : '--',
      bpStr,
    ];

    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (i === 0) td.style.color = '#9CA3AF';
      td.textContent = c;
      tr.appendChild(td);
    });

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.style.cssText = `display:inline-block;padding:2px 9px;border-radius:999px;font-size:10px;
      font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
      background:${sEntry.color}18;color:${sEntry.color};border:1px solid ${sEntry.color}30;`;
    badge.textContent = sEntry.text;
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportHistoryCsv() {
  if (!historyEntries.length) {
    alert('No history data to export yet.');
    return;
  }
  const rows = [[
    'Session Time', 'Heart Rate', 'SpO2', 'Temperature', 'Systolic', 'Diastolic', 'Risk Level'
  ]];
  historyEntries.forEach(e => {
    rows.push([
      isoDateTime(e.ended_at || e.started_at),
      e.heart_rate > 0                 ? safeNum(e.heart_rate, 0)  : '',
      e.spo2 >= 70 && e.spo2 <= 100   ? safeNum(e.spo2, 0)        : '',
      e.temperature > 0                ? safeNum(e.temperature, 0) : '',
      e.bp_systolic  ?? '',
      e.bp_diastolic ?? '',
      e.risk_level   || 'Unknown',
    ]);
  });
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sit-to-check-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('exportCsvBtn').addEventListener('click', exportHistoryCsv);

// Admin panel.
async function loadAdminPanel() {
  if (!isAdmin) return;

  // Device config / calibration.
  try {
    const { data: cfg, error } = await supabase
      .from('device_config').select('*').eq('device_id', DEVICE_ID).maybeSingle();
    if (error) throw error;
    if (cfg) {
      $('calZeroAdc').value   = cfg.pressure_zero_adc ?? '';
      $('calScale').value     = cfg.pressure_mmhg_per_adc ?? '';
      $('calTargetAdc').value = cfg.bp_target_adc ?? '';
      $('calMaxAdc').value    = cfg.bp_max_adc ?? '';
      $('deviceConfig').textContent = JSON.stringify(cfg, null, 2);
    } else {
      $('deviceConfig').textContent = '(no config for ' + DEVICE_ID + ')';
    }
  } catch (e) {
    $('deviceConfig').textContent = 'Config read error: ' + safeText(e.message);
  }

  // Latest device readings (live_data rows).
  const readingsEl = $('latestUserReadings');
  try {
    const { data: rows, error } = await supabase.from('live_data').select('*');
    if (error) throw error;
    if (!rows || rows.length === 0) {
      readingsEl.innerHTML = '<div style="font-size:13px;color:#9CA3AF;padding:8px;">No device data yet.</div>';
    } else {
      const table = document.createElement('table');
      table.className = 'hist-table';
      const thead = document.createElement('thead');
      const hrow  = document.createElement('tr');
      ['Device', 'Heart Rate', 'SpO2', 'Temperature', 'Blood Pressure', 'Status', 'Last Update'].forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      rows.forEach(live => {
        const tr = document.createElement('tr');
        const hr   = safeNum(live.heart_rate, 0);
        const spo2 = safeNum(live.spo2, -1);
        const temp = safeNum(live.temperature, 0);
        const ts   = safeNum(live.device_timestamp, 0);
        const alertStr = typeof live.alert === 'string' ? live.alert : '';
        const { systolic, diastolic } = extractBP(live);
        const bpStr = (systolic !== null) ? formatBP(systolic, diastolic) + ' mmHg' : '--';

        const statusMap = {
          'NORMAL':    { t:'Normal',    c:'#1B6B3A' },
          'LOW':       { t:'Low HR',    c:'#7A5C1E' },
          'CRITICAL':  { t:'High HR',   c:'#C0352A' },
          'NO_FINGER': { t:'No Finger', c:'#9CA3AF' },
        };
        const sEntry = statusMap[String(alertStr).toUpperCase()] || { t: 'No Data', c: '#9CA3AF' };

        const cells = [
          live.device_id || '--',
          hr   > 0                   ? hr + ' bpm'             : '--',
          spo2 >= 70 && spo2 <= 100 ? spo2 + '%'              : '--',
          temp > 0                   ? temp.toFixed(1) + ' °C' : '--',
          bpStr,
        ];

        cells.forEach((c, i) => {
          const td = document.createElement('td');
          if (i === 0) { td.style.color = '#1A1D21'; td.style.fontWeight = '600'; }
          td.textContent = c;
          tr.appendChild(td);
        });

        const statusTd = document.createElement('td');
        const badge = document.createElement('span');
        badge.style.cssText = `display:inline-block;padding:2px 9px;border-radius:999px;font-size:10px;
          font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
          background:${sEntry.c}18;color:${sEntry.c};border:1px solid ${sEntry.c}30;`;
        badge.textContent = sEntry.t;
        statusTd.appendChild(badge);
        tr.appendChild(statusTd);

        const timeTd = document.createElement('td');
        timeTd.style.color = '#9CA3AF';
        timeTd.textContent = ts > 1000000 ? tsDateTime(ts) : isoDateTime(live.updated_at);
        tr.appendChild(timeTd);

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      readingsEl.innerHTML = '';
      readingsEl.appendChild(table);
    }
  } catch (e) {
    readingsEl.innerHTML = `<div style="font-size:13px;color:#C0352A;padding:8px;">Error: ${safeText(e.message)}</div>`;
  }

  // All users.
  try {
    const { data: users, error } = await supabase
      .from('profiles').select('first_name,last_name,email,age').order('created_at', { ascending: true });
    if (error) throw error;
    const listEl = $('userList');
    listEl.innerHTML = '';
    if (users && users.length) {
      users.forEach(p => {
        const firstName = typeof p.first_name === 'string' ? p.first_name : '';
        const lastName  = typeof p.last_name  === 'string' ? p.last_name  : '';
        const email     = typeof p.email      === 'string' ? p.email      : '(no email)';
        const age       = p.age != null ? String(p.age) : '--';
        const row = document.createElement('div');
        row.className = 'user-row';
        const strong = document.createElement('strong');
        strong.style.color = '#1A1D21';
        strong.textContent = [firstName, lastName].filter(Boolean).join(' ') || '(no name)';
        row.appendChild(strong);
        row.appendChild(document.createTextNode(` — ${email} — Age: ${age}`));
        listEl.appendChild(row);
      });
      if (!listEl.hasChildNodes()) listEl.textContent = 'No users found.';
    } else {
      listEl.textContent = 'No users in database.';
    }
  } catch (e) {
    $('userList').textContent = 'Error loading users: ' + safeText(e.message);
  }

  // Admin logs (latest 30).
  try {
    const { data: logs, error } = await supabase
      .from('admin_logs').select('*').order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    const logsEl = $('adminLogs');
    logsEl.innerHTML = '';
    if (!logs || logs.length === 0) { logsEl.textContent = 'No logs yet.'; return; }
    logs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'log-entry';
      const timeSpan = document.createElement('span');
      timeSpan.style.color = '#9CA3AF';
      timeSpan.textContent = `[${log.created_at ? new Date(log.created_at).toLocaleString() : 'unknown time'}] `;
      const actionSpan = document.createElement('span');
      actionSpan.style.color = '#4B5563';
      actionSpan.textContent = typeof log.action === 'string' ? log.action : '--';
      const userSpan = document.createElement('span');
      userSpan.style.color = '#1B4F8A';
      userSpan.textContent = ' — ' + (log.user_id || '');
      div.appendChild(timeSpan); div.appendChild(actionSpan); div.appendChild(userSpan);
      logsEl.appendChild(div);
    });
  } catch (e) {
    $('adminLogs').textContent = 'Logs unavailable: ' + safeText(e.message);
  }
}

const ALLOWED_COMMANDS = ['START','STOP','RESET','switch_wifi'];

$('saveCalibrationBtn').addEventListener('click', async () => {
  if (!isAdmin || !currentUID) { alert('Admin privileges required.'); return; }
  const calibration = {
    device_id: DEVICE_ID,
    pressure_zero_adc: safeNum($('calZeroAdc').value, 410),
    pressure_mmhg_per_adc: safeNum($('calScale').value, 0.22),
    bp_target_adc: safeNum($('calTargetAdc').value, 1700),
    bp_max_adc: safeNum($('calMaxAdc').value, 2500),
    updated_by: currentUID,
  };
  $('calibrationMsg').textContent = 'Saving...';
  const { error } = await supabase.from('device_config').upsert(calibration, { onConflict: 'device_id' });
  if (error) {
    $('calibrationMsg').style.color = '#C0352A';
    $('calibrationMsg').textContent = 'Save failed: ' + safeText(error.message);
    return;
  }
  await supabase.from('admin_logs').insert({ action: 'Calibration updated', user_id: currentUID });
  $('calibrationMsg').style.color = '#1B6B3A';
  $('calibrationMsg').textContent = 'Calibration saved.';
  loadAdminPanel();
});

async function sendCommand(cmd) {
  if (!isAdmin || !currentUID) { alert('Admin privileges required.'); return; }
  if (!ALLOWED_COMMANDS.includes(cmd)) { alert('Unknown command: ' + safeText(cmd)); return; }
  const { error } = await supabase.from('device_commands').upsert({
    device_id: DEVICE_ID, action: cmd, issued_by: currentUID, status: 'pending',
  }, { onConflict: 'device_id' });
  if (error) { alert('Failed to send command: ' + safeText(error.message)); return; }
  await supabase.from('admin_logs').insert({
    action: `Command sent: ${cmd} -> ${DEVICE_ID}`, user_id: currentUID,
  });
  alert(`Command "${cmd}" sent to ${DEVICE_ID} successfully.`);
}

$('cmdStart').addEventListener('click',      () => sendCommand('START'));
$('cmdStop').addEventListener('click',       () => sendCommand('STOP'));
$('cmdReset').addEventListener('click',      () => sendCommand('RESET'));
$('cmdSwitchWifi').addEventListener('click', () => sendCommand('switch_wifi'));

function teardown() {
  if (liveChannel)   { supabase.removeChannel(liveChannel); liveChannel = null; }
  if (offlineTimer)  { clearTimeout(offlineTimer); offlineTimer = null; }
  if (chart)         { chart.destroy(); chart = null; }
  chartBuffers.hr   = [];
  chartBuffers.spo2 = [];
  chartBuffers.temp = [];
  chartBuffers.bp   = [];
  recentAlertsBuffer.length = 0;
  latestReading = null;
  activeSession = null;
  historyEntries = [];
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  isReading = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

// ── Auth state ──
async function handleSession(session) {
  $('loader').style.display = 'none';
  const user = session && session.user ? session.user : null;

  if (!user) {
    teardown();
    currentUID = null;
    isAdmin    = false;
    resetDashboard('Please sign in');
    setDeviceBadge(false);
    setDbBadge(false);
    $('navAdmin').classList.add('hidden');
    $('deviceInfoBar').style.display = 'none';
    $('signupBox').classList.add('hidden');
    $('forgotBox').classList.add('hidden');
    $('loginBox').classList.remove('hidden');
    $('loginBtn').disabled     = false;
    $('loginBtn').textContent  = 'Sign In';
    $('signupBtn').disabled    = false;
    $('signupBtn').textContent = 'Create Account';
    $('authMsg').textContent   = '';
    $('signupMsg').textContent = '';
    showAuth();
    return;
  }

  // Already initialised for this user (e.g. token refresh) — don't re-setup.
  if (user.id === currentUID) return;

  teardown();
  currentUID   = user.id;
  activeMetric = 'hr';

  showApp();
  showSection('secDashboard', 'navDash');

  $('tabHR').className   = 'chart-tab active-hr';
  $('tabSpo2').className = 'chart-tab';
  $('tabTemp').className = 'chart-tab';
  $('tabBP').className   = 'chart-tab';

  loadProfile(user.id);
  initChart();
  attachLiveDataListener();
  armOfflineTimer();
}

supabase.auth.getSession().then(({ data }) => handleSession(data.session));
supabase.auth.onAuthStateChange((_event, session) => handleSession(session));
