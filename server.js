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
    
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (const client of cameraClients) {
      try {
        client.write(header);
        client.write(frame);
        client.write("\r\n");
      } catch (e) {
        cameraClients.delete(client);
      }
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
    frameBuffer = Buffer.alloc(0);
    cameraClients.clear();
    
    cameraProcess = spawn("rpicam-vid", [
      "-t", "0",
      "--codec", "mjpeg",
      "--width", "1280",
      "--height", "720",
      "--framerate", "30",
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

  res.type("text").send(`Camera status: ${running ? `running (PID ${pid})` : "stopped"}\n`);
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

  cameraClients.add(res);
  
  req.on("close", () => {
    cameraClients.delete(res);
    res.end();
  });
  
  req.on("error", () => {
    cameraClients.delete(res);
  });
});

// Simple UI
app.get("/ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Simpsons Relay Control</title>

  <!-- Simpsons-like font -->
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
      padding: 20px;
      font-family: "Luckiest Guy", system-ui, sans-serif;
      background: var(--yellow);
      color: var(--dark);
      text-align: center;
    }

    h1 {
      font-size: 42px;
      margin-bottom: 20px;
      text-shadow: 2px 2px 0 #00000022;
    }

    .card {
      background: var(--card);
      border-radius: 20px;
      padding: 20px;
      max-width: 420px;
      margin: 0 auto;
      box-shadow: 0 8px 0 #00000020;
      border: 4px solid #000;
    }

    .row { margin: 14px 0; }

    label {
      display: block;
      font-size: 20px;
      margin-bottom: 6px;
    }

    input {
      width: 120px;
      font-size: 18px;
      padding: 10px;
      border-radius: 12px;
      border: 3px solid #000;
      text-align: center;
    }

    button {
      font-family: "Luckiest Guy", system-ui, sans-serif;
      font-size: 20px;
      padding: 12px 18px;
      border-radius: 14px;
      border: 4px solid #000;
      cursor: pointer;
      margin: 6px;
      box-shadow: 0 4px 0 #000;
      transition: transform 0.05s ease, box-shadow 0.05s ease;
    }

    button:active {
      transform: translateY(4px);
      box-shadow: 0 0 0 #000;
    }

    button.blue { background: var(--blue); color: white; }
    button.green { background: var(--green); color: #000; }
    button.red { background: var(--red); color: white; }

    button:disabled { opacity: 0.6; cursor: not-allowed; }

    #out, .out-box {
      margin-top: 16px;
      background: white;
      border-radius: 14px;
      padding: 12px;
      border: 3px solid #000;
      font-family: monospace;
      font-size: 14px;
      white-space: pre-wrap;
      text-align: left;
    }

    .out-box:empty { display: none; }

    .hint { margin-top: 12px; font-size: 14px; opacity: 0.7; }

    #videoContainer:fullscreen {
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #videoContainer:fullscreen img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
    }
  </style>
</head>
<body>

  <h1>🍩 Relay Control</h1>

  <div class="card">
    <div class="row">
      <label for="ms">Pulse (ms)</label>
      <input id="ms" type="number" min="50" max="5000" value="500">
      <button class="blue" id="pulseBtn">PULSE</button>
    </div>

    <div class="row">
      <button class="green" id="onBtn">ON</button>
      <button class="red" id="offBtn">OFF</button>
    </div>

    <div id="out">D'oh! Ready.</div>
    <div class="hint">Simpsons mode activated 💛</div>
  </div>

  <h1 style="margin-top:30px;">📺 OLED Display</h1>

  <div class="card">
    <div class="row">
      <span id="oledStatus">Checking...</span>
    </div>
    <div class="row">
      <button class="green" id="oledStartBtn">START</button>
      <button class="red" id="oledStopBtn">STOP</button>
    </div>
    <div id="oledOut" class="out-box"></div>
  </div>

  <h1 style="margin-top:30px;">📹 Camera</h1>

  <div class="card">
    <div class="row">
      <span id="cameraStatus">Checking...</span>
    </div>
    <div class="row">
      <button class="green" id="cameraStartBtn">START</button>
      <button class="red" id="cameraStopBtn">STOP</button>
    </div>
    <div id="cameraOut" class="out-box"></div>
    <div class="row" id="videoContainer" style="display:none;">
      <img id="videoStream" style="width:100%; border-radius:10px; border:3px solid #000;">
    </div>
    <div class="row" id="fullscreenRow" style="display:none;">
      <button class="blue" id="fullscreenBtn">⛶ FULLSCREEN</button>
    </div>
  </div>

  <script>
    const out = document.getElementById("out");
    const msInput = document.getElementById("ms");
    const buttons = [...document.querySelectorAll("button")];

    function setBusy(busy) {
      buttons.forEach(b => b.disabled = busy);
    }

    function apiBase() {
      return location.protocol + "//" + location.hostname + ":3000";
    }

    async function call(path) {
      const url = apiBase() + path;
      out.textContent = "Calling: " + url + "\\n\\n...";
      setBusy(true);

      try {
        const r = await fetch(url, { cache: "no-store" });
        const t = await r.text();
        out.textContent = t;
      } catch (e) {
        out.textContent = "Request failed: " + e;
      } finally {
        setBusy(false);
      }
    }

    document.getElementById("pulseBtn").addEventListener("click", () => {
      const ms = Math.max(50, Math.min(Number(msInput.value || 500), 5000));
      call("/cicka?mode=pulse&ms=" + encodeURIComponent(ms));
    });

    document.getElementById("onBtn").addEventListener("click", () => call("/cicka?mode=on"));
    document.getElementById("offBtn").addEventListener("click", () => call("/cicka?mode=off"));

    // OLED controls
    const oledStatus = document.getElementById("oledStatus");
    const oledOut = document.getElementById("oledOut");
    const oledStartBtn = document.getElementById("oledStartBtn");
    const oledStopBtn = document.getElementById("oledStopBtn");

    async function oledApi(action) {
      const url = apiBase() + "/oled?action=" + action;
      oledOut.textContent = "...";
      try {
        const r = await fetch(url, { cache: "no-store" });
        const t = await r.text();
        oledOut.textContent = t;
      } catch (e) {
        oledOut.textContent = "Request failed: " + e;
      }
      oledCheckStatus();
    }

    async function oledCheckStatus() {
      try {
        const r = await fetch(apiBase() + "/oled?action=status", { cache: "no-store" });
        const t = await r.text();
        oledStatus.textContent = t.trim();
      } catch (e) {
        oledStatus.textContent = "Error: " + e;
      }
    }

    oledStartBtn.addEventListener("click", () => oledApi("start"));
    oledStopBtn.addEventListener("click", () => oledApi("stop"));
    oledCheckStatus();

    // Camera controls
    const cameraStatus = document.getElementById("cameraStatus");
    const cameraOut = document.getElementById("cameraOut");
    const cameraStartBtn = document.getElementById("cameraStartBtn");
    const cameraStopBtn = document.getElementById("cameraStopBtn");
    const videoContainer = document.getElementById("videoContainer");
    const videoStream = document.getElementById("videoStream");
    const fullscreenRow = document.getElementById("fullscreenRow");
    const fullscreenBtn = document.getElementById("fullscreenBtn");

    async function cameraApi(action) {
      const url = apiBase() + "/camera?action=" + action;
      cameraOut.textContent = "...";
      try {
        const r = await fetch(url, { cache: "no-store" });
        const t = await r.text();
        cameraOut.textContent = t;
      } catch (e) {
        cameraOut.textContent = "Request failed: " + e;
      }
      cameraCheckStatus();
    }

    async function cameraCheckStatus() {
      try {
        const r = await fetch(apiBase() + "/camera?action=status", { cache: "no-store" });
        const t = await r.text();
        cameraStatus.textContent = t.trim();
        if (t.includes("running")) {
          videoContainer.style.display = "block";
          fullscreenRow.style.display = "block";
          if (!videoStream.src || videoStream.src.indexOf("/camera/stream") === -1) {
            videoStream.src = apiBase() + "/camera/stream?" + Date.now();
          }
        } else {
          videoContainer.style.display = "none";
          fullscreenRow.style.display = "none";
          videoStream.src = "";
        }
      } catch (e) {
        cameraStatus.textContent = "Error: " + e;
      }
    }

    videoStream.onerror = function() {
      setTimeout(function() {
        if (videoContainer.style.display !== "none") {
          videoStream.src = apiBase() + "/camera/stream?" + Date.now();
        }
      }, 1000);
    };

    fullscreenBtn.addEventListener("click", function() {
      if (videoContainer.requestFullscreen) {
        videoContainer.requestFullscreen();
      } else if (videoContainer.webkitRequestFullscreen) {
        videoContainer.webkitRequestFullscreen();
      }
    });

    document.addEventListener("fullscreenchange", function() {
      const isFullscreen = document.fullscreenElement === videoContainer;
      videoStream.style.borderRadius = isFullscreen ? "0" : "10px";
      videoStream.style.objectFit = isFullscreen ? "contain" : "fill";
    });

    cameraStartBtn.addEventListener("click", () => cameraApi("start"));
    cameraStopBtn.addEventListener("click", () => cameraApi("stop"));
    cameraCheckStatus();
  </script>

</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Express running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://<pi-ip>:${PORT}/ui`);
});