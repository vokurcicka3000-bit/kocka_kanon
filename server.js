const express = require("express");
const path = require("path");
const { spawn, exec } = require("child_process");
const fs = require("fs");

// -------------------- State files --------------------
const RELAY_STATE_FILE = "/tmp/relay_state.txt";
const OLED_PID_FILE = "/tmp/oled_stats.pid";
const CAMERA_PID_FILE = "/tmp/camera.pid";

function writeRelayState(state) {
  try {
    fs.writeFileSync(RELAY_STATE_FILE, state + "\n", { encoding: "utf8" });
  } catch (e) {
    console.error("Failed to write relay state:", e);
  }
}

function readOledPid() {
  try {
    return parseInt(fs.readFileSync(OLED_PID_FILE, "utf8").trim(), 10);
  } catch (e) {
    return null;
  }
}

function writeOledPid(pid) {
  try {
    fs.writeFileSync(OLED_PID_FILE, String(pid), { encoding: "utf8" });
  } catch (e) {
    console.error("Failed to write OLED PID:", e);
  }
}

function clearOledPid() {
  try {
    fs.unlinkSync(OLED_PID_FILE);
  } catch (e) {
    // ignore
  }
}

function readCameraPid() {
  try {
    return parseInt(fs.readFileSync(CAMERA_PID_FILE, "utf8").trim(), 10);
  } catch (e) {
    return null;
  }
}

function writeCameraPid(pid) {
  try {
    fs.writeFileSync(CAMERA_PID_FILE, String(pid), { encoding: "utf8" });
  } catch (e) {
    console.error("Failed to write camera PID:", e);
  }
}

function clearCameraPid() {
  try {
    fs.unlinkSync(CAMERA_PID_FILE);
  } catch (e) {
    // ignore
  }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// -------------------- Config --------------------
const PORT = 3000;
const SCRIPT = path.join(__dirname, "scripts", "relecko.py");
const OLED_SCRIPT = path.join(__dirname, "scripts", "oled_stats.py");
const MODES = new Set(["on", "off", "pulse"]);
const PULSE_MIN_MS = 50;
const PULSE_MAX_MS = 5000;
const PULSE_DEFAULT_MS = 500;

// -------------------- Helpers --------------------
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function pickMode(value) {
  const m = String(value ?? "pulse");
  return MODES.has(m) ? m : "pulse";
}

function textResponse({ code, stdout, stderr }) {
  return (
    `exit code: ${code}\n\n` +
    `--- STDOUT ---\n${stdout || "(empty)"}\n\n` +
    `--- STDERR ---\n${stderr || "(empty)"}\n`
  );
}

// Run python and collect stdout/stderr.
// -u + PYTHONUNBUFFERED makes prints appear immediately.
function runPython(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["-u", scriptPath, ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));

    py.on("error", (err) => {
      reject(new Error(`Failed to start python3: ${err.message}`));
    });

    py.on("close", (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

// -------------------- App --------------------
const app = express();

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// set initial state
writeRelayState("OFF");

app.get("/", (_req, res) => {
  res.type("text").send("Hello from Express on Raspberry Pi!\nTry /ui\n");
});

// API: /cicka?mode=on|off|pulse&ms=500
app.get("/cicka", async (req, res) => {
  const mode = pickMode(req.query.mode);
  const ms = clampInt(req.query.ms, PULSE_MIN_MS, PULSE_MAX_MS, PULSE_DEFAULT_MS);

  try {
    const result = await runPython(SCRIPT, [mode, String(ms)]);

    // Update state file based on requested mode.
    // For pulse, final state is OFF.
    if (mode === "on") writeRelayState("ON");
    else writeRelayState("OFF");

    // If python returned non-zero, show output (but state file still updated above).
    if (result.code !== 0) {
      res.status(500).type("text").send(textResponse(result));
      return;
    }

    res.type("text").send(textResponse(result));
  } catch (err) {
    console.error(err);
    res.status(500).type("text").send(`Node error:\n${err.message}\n`);
  }
});

// API: /oled?action=start|stop|status
app.get("/oled", (req, res) => {
  const action = String(req.query.action || "status").toLowerCase();
  const pid = readOledPid();
  const running = isProcessRunning(pid);
  console.log(`[OLED] action=${action}, pid=${pid}, running=${running}`);

  if (action === "start") {
    if (running) {
      res.type("text").send(`OLED already running (PID ${pid})\n`);
      return;
    }
    const venvPython = path.join(__dirname, "scripts", "oled-env", "bin", "python");
    const py = spawn(venvPython, ["-u", OLED_SCRIPT], {
      detached: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    
    py.stdout.on("data", (d) => console.log("[OLED stdout]", d.toString().trim()));
    py.stderr.on("data", (d) => console.error("[OLED stderr]", d.toString().trim()));
    py.on("error", (err) => console.error("[OLED] spawn error:", err));
    py.on("exit", (code) => console.log("[OLED] exited with code", code));
    
    py.unref();
    writeOledPid(py.pid);
    setTimeout(() => {
      if (isProcessRunning(py.pid)) {
        res.type("text").send(`OLED started (PID ${py.pid})\n`);
      } else {
        res.status(500).type("text").send("OLED failed to start\n");
      }
    }, 500);
    return;
  }

  if (action === "stop") {
    if (!running) {
      clearOledPid();
      res.type("text").send("OLED not running\n");
      return;
    }
    exec(`kill ${pid} 2>/dev/null || pkill -f "oled_stats.py"`, (err) => {
      if (err) console.error("[OLED] kill error:", err);
      else console.log("[OLED] kill succeeded for PID", pid);
      clearOledPid();
      res.type("text").send(`OLED stopped (PID ${pid})\n`);
    });
    return;
  }

  // status
  res.type("text").send(`OLED status: ${running ? `running (PID ${pid})` : "stopped"}\n`);
});

let cameraProcess = null;
let cameraClients = new Set();
let frameBuffer = Buffer.alloc(0);
let latestFrame = null;
let currentQuality = "low";

const QUALITY_PRESETS = {
  veryhigh: { width: 2592, height: 1944, fps: 15, label: "Very High" },
  high: { width: 1920, height: 1080, fps: 30, label: "High" },
  medium: { width: 1280, height: 720, fps: 30, label: "Medium" },
  low: { width: 960, height: 540, fps: 20, label: "Low" },
  verylow: { width: 640, height: 480, fps: 15, label: "Very Low" }
};

function broadcastFrame(chunk) {
  frameBuffer = Buffer.concat([frameBuffer, chunk]);
  
  const jpegStart = Buffer.from([0xff, 0xd8]);
  const jpegEnd = Buffer.from([0xff, 0xd9]);
  
  while (true) {
    const startIdx = frameBuffer.indexOf(jpegStart);
    if (startIdx === -1) break;
    
    const endIdx = frameBuffer.indexOf(jpegEnd, startIdx);
    if (endIdx === -1) break;
    
    const frame = frameBuffer.subarray(startIdx, endIdx + 2);
    frameBuffer = frameBuffer.subarray(endIdx + 2);
    
    latestFrame = frame;
    
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (const client of cameraClients) {
      if (client.busy) continue;
      client.busy = true;
      client.write(header);
      client.write(frame);
      client.write("\r\n", () => { client.busy = false; });
    }
  }
}

// API: /camera?action=start|stop|status
app.get("/camera", (req, res) => {
  const action = String(req.query.action || "status").toLowerCase();
  const pid = readCameraPid();
  const running = isProcessRunning(pid);
  console.log(`[Camera] action=${action}, pid=${pid}, running=${running}`);

  if (action === "start") {
    if (running) {
      res.type("text").send(`Camera already running (PID ${pid})\n`);
      return;
    }
    
    const quality = String(req.query.quality || "low").toLowerCase();
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.low;
    currentQuality = quality;
    
    frameBuffer = Buffer.alloc(0);
    cameraClients.clear();
    latestFrame = null;
    
    cameraProcess = spawn("rpicam-vid", [
      "-t", "0",
      "--codec", "mjpeg",
      "--width", String(preset.width),
      "--height", String(preset.height),
      "--framerate", String(preset.fps),
      "-o", "-"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    cameraProcess.stdout.on("data", broadcastFrame);
    cameraProcess.on("error", (err) => console.error("[Camera] spawn error:", err));
    cameraProcess.on("exit", (code) => {
      console.log("[Camera] exited with code", code);
      clearCameraPid();
      cameraProcess = null;
      cameraClients.clear();
      frameBuffer = Buffer.alloc(0);
      latestFrame = null;
    });

    writeCameraPid(cameraProcess.pid);
    setTimeout(() => {
      if (isProcessRunning(cameraProcess.pid)) {
        res.type("text").send(`Camera started (PID ${cameraProcess.pid})\n`);
      } else {
        res.status(500).type("text").send("Camera failed to start\n");
      }
    }, 500);
    return;
  }

  if (action === "stop") {
    if (!running) {
      clearCameraPid();
      res.type("text").send("Camera not running\n");
      return;
    }
    if (cameraProcess) {
      cameraProcess.kill("SIGTERM");
      cameraProcess = null;
    }
    exec(`kill ${pid} 2>/dev/null || pkill -f "rpicam-vid"`, (err) => {
      if (err) console.error("[Camera] kill error:", err);
      else console.log("[Camera] kill succeeded for PID", pid);
      clearCameraPid();
      res.type("text").send(`Camera stopped (PID ${pid})\n`);
    });
    return;
  }

  res.type("text").send(`Camera status: ${running ? `running (PID ${pid}, ${QUALITY_PRESETS[currentQuality].label})` : "stopped"}\n`);
});

app.get("/camera/stream", (req, res) => {
  const pid = readCameraPid();
  if (!isProcessRunning(pid) || !cameraProcess) {
    res.status(503).type("text").send("Camera not running\n");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Connection": "close",
    "Pragma": "no-cache"
  });

  res.busy = false;
  cameraClients.add(res);
  
  if (latestFrame) {
    res.busy = true;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
    res.write(latestFrame);
    res.write("\r\n", () => { res.busy = false; });
  }
  
  req.on("close", () => {
    cameraClients.delete(res);
    res.end();
  });
  
  req.on("error", () => {
    cameraClients.delete(res);
  });
});

app.get("/camera/bandwidth-test", (req, res) => {
  const size = parseInt(req.query.size) || 100;
  const data = Buffer.alloc(size * 1024, "X");
  res.type("application/octet-stream").send(data);
});

// Simple UI
app.get("/ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kocka Kanon</title>
  <link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&display=swap" rel="stylesheet">
  <style>
    :root {
      --yellow: #FFD90F;
      --blue: #4A90E2;
      --dark: #222;
      --card: #fff6c9;
      --red: #E53935;
      --green: #2ecc71;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px;
      font-family: "Luckiest Guy", system-ui, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      text-align: center;
      min-height: 100vh;
    }
    h1 {
      font-size: 32px;
      margin: 10px 0;
      text-shadow: 2px 2px 0 #000;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .cat-icon {
      width: 40px;
      height: 40px;
      display: inline-block;
    }
    .main-card {
      background: rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 15px;
      max-width: 800px;
      margin: 0 auto;
      border: 3px solid rgba(255,255,255,0.2);
    }
    .video-wrapper {
      position: relative;
      display: inline-block;
      width: 100%;
      max-width: 640px;
    }
    #videoStream {
      width: 100%;
      border-radius: 10px;
      border: 3px solid #000;
      background: #000;
    }
    .crosshair {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    .crosshair::before, .crosshair::after {
      content: '';
      position: absolute;
      background: rgba(255,0,0,0.8);
    }
    .crosshair::before {
      width: 2px;
      height: 40px;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }
    .crosshair::after {
      width: 40px;
      height: 2px;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }
    .crosshair-circle {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 60px;
      height: 60px;
      border: 2px solid rgba(255,0,0,0.8);
      border-radius: 50%;
      pointer-events: none;
    }
    .controls {
      margin: 15px 0;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .arrow-pad {
      display: grid;
      grid-template-columns: repeat(3, 50px);
      grid-template-rows: repeat(3, 50px);
      gap: 5px;
      margin: 15px auto;
      justify-content: center;
    }
    .arrow-btn {
      width: 50px;
      height: 50px;
      font-size: 24px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--blue);
      color: white;
      border: 3px solid #000;
      border-radius: 10px;
      cursor: pointer;
    }
    .arrow-btn:active {
      transform: scale(0.95);
      background: #3a7bc8;
    }
    .arrow-btn.empty { visibility: hidden; }
    select {
      font-family: "Luckiest Guy", system-ui, sans-serif;
      font-size: 14px;
      padding: 8px;
      border-radius: 10px;
      border: 3px solid #000;
      background: white;
      cursor: pointer;
    }
    button {
      font-family: "Luckiest Guy", system-ui, sans-serif;
      font-size: 16px;
      padding: 10px 16px;
      border-radius: 12px;
      border: 3px solid #000;
      cursor: pointer;
      box-shadow: 0 3px 0 #000;
      transition: transform 0.05s ease;
    }
    button:active { transform: translateY(3px); box-shadow: 0 0 0 #000; }
    button.blue { background: var(--blue); color: white; }
    button.green { background: var(--green); color: #000; }
    button.red { background: var(--red); color: white; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .small-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 10px;
      margin: 10px auto;
      max-width: 350px;
      border: 2px solid rgba(255,255,255,0.1);
      font-size: 12px;
    }
    .small-card h3 {
      margin: 5px 0;
      font-size: 14px;
    }
    .small-card button {
      font-size: 12px;
      padding: 6px 12px;
    }
    .small-card .row { margin: 8px 0; }
    .status-text { font-size: 11px; opacity: 0.8; }
    .out-box {
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
      padding: 8px;
      font-family: monospace;
      font-size: 10px;
      white-space: pre-wrap;
      text-align: left;
      max-height: 60px;
      overflow-y: auto;
    }
    .out-box:empty { display: none; }
    #connectionQuality { font-size: 12px; }
    #videoWrapper:fullscreen {
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #videoWrapper:fullscreen img {
      max-width: 100%;
      max-height: 100%;
    }
    #iosFullscreen {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: #000;
      z-index: 9999;
      align-items: center;
      justify-content: center;
    }
    #iosFullscreen.active { display: flex; }
    #iosFullscreen img { max-width: 100%; max-height: 100%; }
    #iosClose {
      position: absolute;
      top: 10px; right: 10px;
      background: var(--red);
      color: white;
      border: 3px solid #000;
      border-radius: 10px;
      padding: 10px 15px;
      font-family: "Luckiest Guy", system-ui, sans-serif;
      font-size: 16px;
      cursor: pointer;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <h1>
    <svg class="cat-icon" viewBox="0 0 100 100" fill="currentColor">
      <path d="M20 90 L20 50 L10 20 L30 35 L50 25 L70 35 L90 20 L80 50 L80 90 Z"/>
      <circle cx="35" cy="55" r="5" fill="#111"/>
      <circle cx="65" cy="55" r="5" fill="#111"/>
      <ellipse cx="50" cy="68" rx="5" ry="3" fill="#ff9999"/>
    </svg>
    Kocka Kanon
  </h1>

  <div class="main-card">
    <div class="controls">
      <select id="qualitySelect">
        <option value="auto">Auto</option>
        <option value="verylow">Very Low</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="veryhigh">Very High</option>
      </select>
      <button class="green" id="cameraStartBtn">START</button>
      <button class="red" id="cameraStopBtn">STOP</button>
      <button class="blue" id="fullscreenBtn">⛶</button>
    </div>
    <div id="connectionQuality">Connection: Testing...</div>
    
    <div id="cameraArea" class="hidden">
      <div class="video-wrapper" id="videoWrapper">
        <img id="videoStream" src="">
        <div class="crosshair"></div>
        <div class="crosshair-circle"></div>
      </div>
      
      <div class="arrow-pad">
        <div class="arrow-btn empty"></div>
        <button class="arrow-btn" id="aimUp">▲</button>
        <div class="arrow-btn empty"></div>
        <button class="arrow-btn" id="aimLeft">◀</button>
        <div class="arrow-btn empty"></div>
        <button class="arrow-btn" id="aimRight">▶</button>
        <div class="arrow-btn empty"></div>
        <button class="arrow-btn" id="aimDown">▼</button>
        <div class="arrow-btn empty"></div>
      </div>
    </div>
    <div id="cameraOut" class="out-box"></div>
  </div>

  <div class="small-card">
    <h3>🎯 Airgun Relay</h3>
    <div class="row">
      <input id="ms" type="number" min="50" max="5000" value="500" style="width:60px;font-size:12px;padding:4px;border-radius:6px;border:2px solid #000;text-align:center;">
      <button class="blue" id="pulseBtn">PULSE</button>
      <button class="green" id="onBtn">ON</button>
      <button class="red" id="offBtn">OFF</button>
    </div>
    <div id="out" class="out-box">Ready.</div>
  </div>

  <div class="small-card">
    <h3>📺 OLED Display</h3>
    <span id="oledStatus" class="status-text">Checking...</span>
    <div class="row">
      <button class="green" id="oledStartBtn">START</button>
      <button class="red" id="oledStopBtn">STOP</button>
    </div>
    <div id="oledOut" class="out-box"></div>
  </div>

  <div id="iosFullscreen">
    <button id="iosClose">✕ CLOSE</button>
    <img id="iosFullscreenImg">
  </div>

  <script>
    const apiBase = () => location.protocol + "//" + location.hostname + ":3000";
    
    const out = document.getElementById("out");
    const msInput = document.getElementById("ms");
    const cameraOut = document.getElementById("cameraOut");
    const cameraStatus = document.getElementById("cameraStatus");
    const cameraStartBtn = document.getElementById("cameraStartBtn");
    const cameraStopBtn = document.getElementById("cameraStopBtn");
    const videoStream = document.getElementById("videoStream");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const qualitySelect = document.getElementById("qualitySelect");
    const connectionQuality = document.getElementById("connectionQuality");
    const oledStatus = document.getElementById("oledStatus");
    const oledOut = document.getElementById("oledOut");

    let detectedQuality = "low";

    async function call(path) {
      const url = apiBase() + path;
      out.textContent = "...";
      try {
        const r = await fetch(url, { cache: "no-store" });
        out.textContent = await r.text();
      } catch (e) {
        out.textContent = "Error: " + e;
      }
    }

    document.getElementById("pulseBtn").addEventListener("click", () => {
      const ms = Math.max(50, Math.min(Number(msInput.value || 500), 5000));
      call("/cicka?mode=pulse&ms=" + ms);
    });
    document.getElementById("onBtn").addEventListener("click", () => call("/cicka?mode=on"));
    document.getElementById("offBtn").addEventListener("click", () => call("/cicka?mode=off"));

    async function oledApi(action) {
      const url = apiBase() + "/oled?action=" + action;
      oledOut.textContent = "...";
      try {
        oledOut.textContent = await (await fetch(url, { cache: "no-store" })).text();
      } catch (e) {
        oledOut.textContent = "Error: " + e;
      }
      oledCheckStatus();
    }
    async function oledCheckStatus() {
      try {
        oledStatus.textContent = await (await fetch(apiBase() + "/oled?action=status", { cache: "no-store" })).text();
      } catch (e) {
        oledStatus.textContent = "Error: " + e;
      }
    }
    document.getElementById("oledStartBtn").addEventListener("click", () => oledApi("start"));
    document.getElementById("oledStopBtn").addEventListener("click", () => oledApi("stop"));

    async function testConnectionQuality() {
      connectionQuality.textContent = "Testing...";
      try {
        const start = performance.now();
        await (await fetch(apiBase() + "/camera/bandwidth-test?size=200", { cache: "no-store" })).arrayBuffer();
        const mbps = (200 * 8) / ((performance.now() - start) / 1000);
        
        if (mbps > 50) detectedQuality = "veryhigh";
        else if (mbps > 30) detectedQuality = "high";
        else if (mbps > 15) detectedQuality = "medium";
        else if (mbps > 5) detectedQuality = "low";
        else detectedQuality = "verylow";
        
        connectionQuality.textContent = mbps.toFixed(1) + " Mbps";
        connectionQuality.style.color = mbps > 15 ? "#2ecc71" : mbps > 5 ? "#f1c40f" : "#e74c3c";
        updateQualitySelect();
      } catch (e) {
        connectionQuality.textContent = "Test failed";
        detectedQuality = "verylow";
      }
    }

    function updateQualitySelect() {
      if (qualitySelect.value === "auto") {
        qualitySelect.innerHTML = '<option value="auto" selected>Auto (' + detectedQuality + ')</option>' +
          '<option value="verylow">Very Low</option><option value="low">Low</option>' +
          '<option value="medium">Medium</option><option value="high">High</option>' +
          '<option value="veryhigh">Very High</option>';
      }
    }

    function getSelectedQuality() {
      return qualitySelect.value === "auto" ? detectedQuality : qualitySelect.value;
    }

    async function cameraApi(action) {
      let url = apiBase() + "/camera?action=" + action;
      if (action === "start") url += "&quality=" + getSelectedQuality();
      cameraOut.textContent = "...";
      try {
        cameraOut.textContent = await (await fetch(url, { cache: "no-store" })).text();
      } catch (e) {
        cameraOut.textContent = "Error: " + e;
      }
      cameraCheckStatus();
    }

    async function cameraCheckStatus() {
      try {
        const t = await (await fetch(apiBase() + "/camera?action=status", { cache: "no-store" })).text();
        const cameraArea = document.getElementById("cameraArea");
        if (t.includes("running")) {
          cameraArea.classList.remove("hidden");
          if (!videoStream.src || videoStream.src.indexOf("/camera/stream") === -1) {
            videoStream.src = apiBase() + "/camera/stream?" + Date.now();
          }
        } else {
          cameraArea.classList.add("hidden");
          videoStream.src = "";
        }
      } catch (e) {}
    }

    videoStream.onerror = () => {
      const cameraArea = document.getElementById("cameraArea");
      if (!cameraArea.classList.contains("hidden")) {
        setTimeout(() => { videoStream.src = apiBase() + "/camera/stream?" + Date.now(); }, 1000);
      }
    };

    const iosFullscreen = document.getElementById("iosFullscreen");
    const iosFullscreenImg = document.getElementById("iosFullscreenImg");
    const iosClose = document.getElementById("iosClose");
    const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    fullscreenBtn.addEventListener("click", () => {
      const videoWrapper = document.getElementById("videoWrapper");
      if (isIOS()) {
        iosFullscreenImg.src = videoStream.src;
        iosFullscreen.classList.add("active");
        document.body.style.overflow = "hidden";
      } else if (videoWrapper.requestFullscreen) {
        videoWrapper.requestFullscreen();
      }
    });
    iosClose.addEventListener("click", () => { iosFullscreen.classList.remove("active"); document.body.style.overflow = ""; });
    iosFullscreen.addEventListener("click", (e) => { if (e.target === iosFullscreen) { iosFullscreen.classList.remove("active"); document.body.style.overflow = ""; } });

    cameraStartBtn.addEventListener("click", () => cameraApi("start"));
    cameraStopBtn.addEventListener("click", () => cameraApi("stop"));
    qualitySelect.addEventListener("change", function() {
      if (this.value !== "auto") {
        this.innerHTML = '<option value="auto">Auto (' + detectedQuality + ')</option>' +
          '<option value="verylow"' + (this.value === "verylow" ? " selected" : "") + '>Very Low</option>' +
          '<option value="low"' + (this.value === "low" ? " selected" : "") + '>Low</option>' +
          '<option value="medium"' + (this.value === "medium" ? " selected" : "") + '>Medium</option>' +
          '<option value="high"' + (this.value === "high" ? " selected" : "") + '>High</option>' +
          '<option value="veryhigh"' + (this.value === "veryhigh" ? " selected" : "") + '>Very High</option>';
      }
    });

    // Arrow buttons (placeholder - can be connected to servos later)
    document.getElementById("aimUp").addEventListener("click", () => console.log("Aim Up"));
    document.getElementById("aimDown").addEventListener("click", () => console.log("Aim Down"));
    document.getElementById("aimLeft").addEventListener("click", () => console.log("Aim Left"));
    document.getElementById("aimRight").addEventListener("click", () => console.log("Aim Right"));

    // Auto-start camera on load
    oledCheckStatus();
    testConnectionQuality().then(() => cameraApi("start"));
  </script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Express running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://<pi-ip>:${PORT}/ui`);
});