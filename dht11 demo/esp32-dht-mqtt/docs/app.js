/* ESP32 Climate Monitor — dashboard logic
   Subscribes to <base>/data, <base>/status, <base>/config/threshold
   Publishes   <base>/config/threshold (retained), <base>/cmd            */
(() => {
  "use strict";

  // ---------- Settings ----------
  const DEFAULTS = {
    url: "wss://broker.hivemq.com:8884/mqtt",
    base: "esp32s3dht/change-me-7f3k",
    user: "",
    pass: "",
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let cfg = { ...DEFAULTS, ...store.get("cfg", {}) };

  const STALE_MS = 7000;       // device "offline" if no data for this long
  const MAX_POINTS = 900;      // 30 min at 2 s

  // ---------- State ----------
  let client = null;
  let threshold = 36;
  let deviceThreshold = null;
  let lastData = null;
  let lastSeen = 0;
  let statusMsg = "unknown";
  let msgCount = 0;
  let alertCount = 0;
  let wasAlert = false;
  let viewN = store.get("viewN", 60);
  let demoTimer = null;
  const history = [];          // {t: Date, temp, hum}

  const $ = (id) => document.getElementById(id);
  const topic = (s) => `${cfg.base}/${s}`;

  // ---------- Log ----------
  function log(msg, cls = "") {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString();
    li.append(time, document.createTextNode(msg));
    $("log").prepend(li);
    while ($("log").children.length > 200) $("log").lastChild.remove();
  }

  // ---------- Theme ----------
  const savedTheme = store.get("theme", null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    restyleChart();
  };

  // ---------- Chart ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Temperature °C", data: [], yAxisID: "y", borderWidth: 2, tension: .3, pointRadius: 0 },
        { label: "Humidity %", data: [], yAxisID: "y1", borderWidth: 2, tension: .3, pointRadius: 0 },
        { label: "Threshold", data: [], yAxisID: "y", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { boxWidth: 12 } } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { position: "left", suggestedMin: 15, suggestedMax: 45, title: { display: true, text: "°C" } },
        y1: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
      },
    },
  });
  function restyleChart() {
    const text = css("--muted"), grid = css("--line");
    const [t, h, thr] = chart.data.datasets;
    t.borderColor = css("--temp"); t.backgroundColor = t.borderColor;
    h.borderColor = css("--hum"); h.backgroundColor = h.borderColor;
    thr.borderColor = css("--bad"); thr.backgroundColor = thr.borderColor;
    for (const s of Object.values(chart.options.scales)) {
      s.ticks.color = text; s.grid.color = grid;
      if (s.title) s.title.color = text;
    }
    chart.options.plugins.legend.labels.color = css("--text");
    chart.update("none");
  }
  function redrawChart() {
    const pts = history.slice(-viewN);
    chart.data.labels = pts.map((p) => p.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    chart.data.datasets[0].data = pts.map((p) => p.temp);
    chart.data.datasets[1].data = pts.map((p) => p.hum);
    chart.data.datasets[2].data = pts.map(() => threshold);
    chart.update("none");

    if (pts.length) {
      const temps = pts.map((p) => p.temp);
      $("tMin").textContent = Math.min(...temps).toFixed(1) + "°";
      $("tMax").textContent = Math.max(...temps).toFixed(1) + "°";
      $("tAvg").textContent = (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) + "°";
    } else {
      $("tMin").textContent = $("tMax").textContent = $("tAvg").textContent = "--";
    }
  }
  document.querySelectorAll("#rangeSeg button").forEach((b) => {
    b.classList.toggle("on", +b.dataset.n === viewN);
    b.onclick = () => {
      viewN = +b.dataset.n; store.set("viewN", viewN);
      document.querySelectorAll("#rangeSeg button").forEach((x) => x.classList.toggle("on", x === b));
      redrawChart();
    };
  });

  // ---------- Rendering ----------
  function setPill(id, cls, text) {
    const el = $(id);
    el.className = "pill " + cls;
    el.querySelector("span").textContent = text;
  }
  function setLed(id, mode, label) {
    const el = $(id);
    el.classList.remove("on", "fast", "slow", "flash");
    if (mode === "flash") { void el.offsetWidth; el.classList.add("flash"); }  // restart animation
    else if (mode) el.classList.add(mode);
    $(id + "Txt").textContent = label;
  }
  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return (d ? d + "d " : "") + `${h}h ${m}m ${sec}s`;
  }
  function comfortText(t, h) {
    if (h < 30) return "Dry air";
    if (h > 70) return "Very humid";
    if (t > 30) return "Warm";
    if (t < 18) return "Cool";
    return "Comfortable";
  }

  function deviceOnline() {
    return statusMsg !== "offline" && Date.now() - lastSeen < STALE_MS;
  }

  function renderStatus() {
    const online = deviceOnline();
    if (online) setPill("devicePill", "ok", "online");
    else if (statusMsg === "offline") setPill("devicePill", "bad", "offline");
    else setPill("devicePill", lastSeen ? "warn" : "", lastSeen ? "no data" : "waiting");

    // Green LED mirrors the board: blinks fast when it is offline (Wi-Fi down).
    if (!online && lastSeen) setLed("ledGreen", "fast", "device offline / Wi-Fi down");
    else if (!online) setLed("ledGreen", "", "waiting for data");
    else setLed("ledGreen", "", "connected");

    $("lastSeen").textContent = lastSeen ? Math.round((Date.now() - lastSeen) / 1000) + " s ago" : "never";
    ["thrApply", "identifyBtn", "rebootBtn"].forEach((id) => ($(id).disabled = !client?.connected && !demoTimer));
  }

  function onData(d) {
    lastSeen = Date.now();
    msgCount++;
    $("msgCount").textContent = msgCount;

    if (d.error) {
      setLed("ledRed", "on", "sensor error");
      setLed("ledBlue", "", "—");
      log("Device reports DHT11 read error", "bad");
      renderStatus();
      return;
    }
    lastData = d;
    const t = +d.temp, h = +d.hum;
    if (typeof d.threshold === "number") {
      deviceThreshold = d.threshold;
      $("thrDevice").textContent = `(device: ${d.threshold.toFixed(1)})`;
    }
    const alert = typeof d.alert === "boolean" ? d.alert : t > threshold;

    $("tempVal").textContent = t.toFixed(1);
    $("humVal").textContent = h.toFixed(0);
    $("hiVal").textContent = d.hi != null ? (+d.hi).toFixed(1) : "--";
    $("tempBar").style.width = Math.min(100, Math.max(0, t / 50 * 100)) + "%";
    $("humBar").style.width = Math.min(100, Math.max(0, h)) + "%";
    $("comfort").textContent = comfortText(t, h);
    $("tempCard").classList.toggle("hot", alert);

    if (d.rssi != null) {
      $("rssiVal").textContent = d.rssi + " dBm";
      const lvl = d.rssi > -55 ? 4 : d.rssi > -67 ? 3 : d.rssi > -75 ? 2 : 1;
      $("rssiBars").innerHTML = [4, 7, 10, 13].map((px, i) => `<i style="height:${px}px" class="${i < lvl ? "on" : ""}"></i>`).join("");
    }
    if (d.uptime != null) $("uptimeVal").textContent = fmtUptime(d.uptime);
    if (d.heap != null) $("heapVal").textContent = (d.heap / 1024).toFixed(0) + " KB";

    // LEDs
    if (alert) { setLed("ledRed", "fast", "temp > limit"); setLed("ledBlue", "", "—"); }
    else { setLed("ledRed", "", "off"); setLed("ledBlue", "flash", "normal · sent"); }

    // Alert handling
    $("alertBanner").hidden = !alert;
    $("alertTemp").textContent = t.toFixed(1);
    $("alertLimit").textContent = (deviceThreshold ?? threshold).toFixed(1);
    if (alert && !wasAlert) {
      alertCount++;
      $("alertCount").textContent = alertCount;
      log(`HIGH TEMPERATURE ${t.toFixed(1)} °C`, "bad");
      notify(`High temperature: ${t.toFixed(1)} °C`);
      beep();
    } else if (!alert && wasAlert) {
      log(`Temperature back to normal (${t.toFixed(1)} °C)`, "ok");
    }
    wasAlert = alert;

    history.push({ t: new Date(), temp: t, hum: h });
    if (history.length > MAX_POINTS) history.shift();
    redrawChart();
    renderStatus();
  }

  // ---------- Alerts ----------
  $("notifyChk").checked = store.get("notify", false);
  $("soundChk").checked = store.get("sound", false);
  $("notifyChk").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") e.target.checked = false;
    }
    store.set("notify", e.target.checked);
  };
  $("soundChk").onchange = (e) => store.set("sound", e.target.checked);
  function notify(text) {
    if ($("notifyChk").checked && "Notification" in window && Notification.permission === "granted") {
      new Notification("ESP32 Climate Monitor", { body: text });
    }
  }
  let audioCtx;
  function beep() {
    if (!$("soundChk").checked) return;
    try {
      audioCtx ||= new AudioContext();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(.2, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .6);
      o.start(); o.stop(audioCtx.currentTime + .6);
    } catch { /* audio blocked */ }
  }

  // ---------- Threshold & commands ----------
  function setThresholdUI(v) {
    threshold = v;
    $("thrRange").value = v;
    $("thrOut").textContent = v.toFixed(1);
    $("tempBarLimit").style.left = Math.min(100, v / 50 * 100) + "%";
    $("alertLimit").textContent = v.toFixed(1);
    redrawChart();
  }
  $("thrRange").oninput = (e) => setThresholdUI(+e.target.value);
  $("thrApply").onclick = () => {
    if (demoTimer) { deviceThreshold = threshold; log(`[demo] threshold set to ${threshold.toFixed(1)} °C`); return; }
    client.publish(topic("config/threshold"), threshold.toFixed(1), { qos: 1, retain: true });
    log(`Threshold → ${threshold.toFixed(1)} °C sent`, "ok");
  };
  function sendCmd(cmd) {
    if (demoTimer) { log(`[demo] command "${cmd}"`); return; }
    client.publish(topic("cmd"), cmd);
    log(`Command "${cmd}" sent`);
  }
  $("identifyBtn").onclick = () => sendCmd("identify");
  $("rebootBtn").onclick = () => { if (confirm("Reboot the ESP32?")) sendCmd("reboot"); };

  // ---------- CSV ----------
  $("csvBtn").onclick = () => {
    if (!history.length) return log("No data to export");
    const rows = ["time,temperature_c,humidity_pct", ...history.map((p) => `${p.t.toISOString()},${p.temp},${p.hum}`)];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `dht11-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("clearBtn").onclick = () => { history.length = 0; redrawChart(); log("History cleared"); };

  // ---------- MQTT ----------
  function connect() {
    if (client) { client.end(true); client = null; }
    $("topicLabel").textContent = cfg.base + "/#";
    setPill("brokerPill", "warn", "connecting…");
    log(`Connecting to ${cfg.url}`);

    const c = mqtt.connect(cfg.url, {
      clientId: "dash-" + Math.random().toString(16).slice(2, 10),
      username: cfg.user || undefined,
      password: cfg.pass || undefined,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      clean: true,
    });
    client = c;
    const live = () => c === client;   // ignore events from a client we already replaced
    c.on("connect", () => {
      if (!live()) return;
      setPill("brokerPill", "ok", "connected");
      log("Broker connected", "ok");
      c.subscribe([topic("data"), topic("status"), topic("config/threshold")], { qos: 0 });
      renderStatus();
    });
    c.on("reconnect", () => live() && setPill("brokerPill", "warn", "reconnecting…"));
    c.on("close", () => { if (live()) { setPill("brokerPill", "bad", "disconnected"); renderStatus(); } });
    c.on("error", (e) => live() && log("MQTT error: " + e.message, "bad"));
    c.on("message", (t, buf) => {
      if (!live()) return;
      const msg = buf.toString();
      if (t === topic("data")) {
        try { onData(JSON.parse(msg)); } catch { log("Bad JSON: " + msg.slice(0, 80), "bad"); }
      } else if (t === topic("status")) {
        statusMsg = msg;
        log(`Device ${msg}`, msg === "online" ? "ok" : "bad");
        if (msg === "online") lastSeen = Date.now();
        renderStatus();
      } else if (t === topic("config/threshold")) {
        const v = parseFloat(msg);
        if (!isNaN(v)) setThresholdUI(v);
      }
    });
  }

  // ---------- Demo mode ----------
  function startDemo() {
    if (client) { client.end(true); client = null; }
    setPill("brokerPill", "warn", "demo");
    statusMsg = "online";
    let t = 30, h = 55, up = 0;
    log("Demo mode on (simulated device)");
    demoTimer = setInterval(() => {
      up += 2;
      t += (Math.random() - .45) * 0.8;
      if (Math.random() < .02) t += 6;                 // occasional spike
      t = Math.max(22, Math.min(42, t));
      if (t > 39) t -= 1.2;
      h = Math.max(25, Math.min(90, h + (Math.random() - .5) * 2));
      const thr = deviceThreshold ?? threshold;
      onData({ temp: +t.toFixed(1), hum: Math.round(h), hi: +(t + (h - 40) * 0.05).toFixed(1),
               alert: t > thr, threshold: thr, rssi: -50 - Math.round(Math.random() * 20), uptime: up, heap: 210000 });
    }, 2000);
    renderStatus();
  }
  function stopDemo() {
    clearInterval(demoTimer); demoTimer = null;
    statusMsg = "unknown"; lastSeen = 0; deviceThreshold = null;
    $("thrDevice").textContent = "";
    log("Demo mode off");
    connect();
  }
  $("demoChk").onchange = (e) => (e.target.checked ? startDemo() : stopDemo());

  // ---------- Settings dialog ----------
  $("settingsBtn").onclick = () => {
    $("sUrl").value = cfg.url; $("sBase").value = cfg.base;
    $("sUser").value = cfg.user; $("sPass").value = cfg.pass;
    $("settingsDlg").showModal();
  };
  $("settingsDlg").addEventListener("close", () => {
    if ($("settingsDlg").returnValue !== "save") return;
    cfg = {
      url: $("sUrl").value.trim(),
      base: $("sBase").value.trim().replace(/\/+$/, ""),
      user: $("sUser").value.trim(),
      pass: $("sPass").value,
    };
    store.set("cfg", cfg);
    if ($("demoChk").checked) { $("demoChk").checked = false; clearInterval(demoTimer); demoTimer = null; }
    history.length = 0; lastSeen = 0; statusMsg = "unknown"; redrawChart();
    connect();
  });

  // ---------- Boot ----------
  restyleChart();
  setThresholdUI(threshold);
  setInterval(renderStatus, 1000);
  if (typeof mqtt === "undefined") log("mqtt.js failed to load (check internet / CDN)", "bad");
  else connect();
  if (cfg.base === DEFAULTS.base) log("Tip: open ⚙ settings and set your own unique topic base");
})();
