const express = require("express");
const path = require("path");
const { spawn, exec } = require("child_process");
const fs = require("fs");

// -------------------- State files --------------------
const RELAY_STATE_FILE = "/tmp/relay_state.txt";
const CAMERA_PID_FILE = "/tmp/camera.pid";
const SERVO_STATE_FILE = "/tmp/servo_state.txt";

function writeRelayState(state) {
  try {
    fs.writeFileSync(RELAY_STATE_FILE, state + "\n", { encoding: "utf8" });
  } catch (e) {
    console.error("Failed to write relay state:", e);
  }
}

function readServoState() {
  try {
    const data = fs.readFileSync(SERVO_STATE_FILE, "utf8").trim();
    const parts = data.split(",");
    const h = parseFloat(parts[0]);
    const v = parseFloat(parts[1]);
    return {
      horizontal: Number.isFinite(h) ? Math.max(SERVO_MIN, Math.min(SERVO_MAX, h)) : SERVO_CENTER,
      vertical:   Number.isFinite(v) ? Math.max(SERVO_MIN, Math.min(SERVO_MAX, v)) : SERVO_CENTER
    };
  } catch (e) {
    return { horizontal: SERVO_CENTER, vertical: SERVO_CENTER };
  }
}

function writeServoState(horizontal, vertical) {
  try {
    fs.writeFileSync(SERVO_STATE_FILE, `${horizontal},${vertical}\n`, { encoding: "utf8" });
  } catch (e) {
    console.error("Failed to write servo state:", e);
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
const SERVO_SCRIPT = path.join(__dirname, "scripts", "servo.py");
const BEEP_SCRIPT    = path.join(__dirname, "scripts", "beep.py");
const TRACKER_SCRIPT = path.join(__dirname, "scripts", "tracker.py");
const SERVO_PYTHON = path.join(__dirname, "scripts", "servo-env", "bin", "python");
const MODES = new Set(["on", "off", "pulse"]);
const PULSE_MIN_MS = 50;
const PULSE_MAX_MS = 5000;
const PULSE_DEFAULT_MS = 500;
const SERVO_STEP = 5;
const SERVO_MIN = 0;
const SERVO_MAX = 270;
const SERVO_CENTER = 135;
const SERVO_H_CHANNEL = 0;
const SERVO_V_CHANNEL = 1;

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

// -------------------- Servo daemon --------------------
// Single persistent process - avoids set_pwm_freq() glitch on every call.
let servoDaemon = null;
let servoReady = false;
let servoCallbacks = new Map(); // pending response callbacks keyed by seq id
let servoSeq = 0;
let servoBuffer = "";

function startServoDaemon() {
  servoDaemon = spawn(SERVO_PYTHON, ["-u", SERVO_SCRIPT], {
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  servoDaemon.stdout.on("data", (d) => {
    servoBuffer += d.toString();
    const lines = servoBuffer.split("\n");
    servoBuffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "READY") {
        servoReady = true;
        console.log("[Servo] daemon ready");
        continue;
      }
      // Responses are tagged: "SEQ:<id> OK/ERR ..."
      const m = trimmed.match(/^SEQ:(\d+)\s+(.*)/);
      if (m) {
        const cb = servoCallbacks.get(Number(m[1]));
        if (cb) { servoCallbacks.delete(Number(m[1])); cb(m[2]); }
      }
    }
  });

  servoDaemon.stderr.on("data", (d) => console.error("[Servo stderr]", d.toString().trim()));
  servoDaemon.on("error", (err) => console.error("[Servo] spawn error:", err));
  servoDaemon.on("exit", (code) => {
    console.log("[Servo] daemon exited with code", code);
    servoReady = false;
    servoDaemon = null;
    // restart after 1s
    setTimeout(startServoDaemon, 1000);
  });
}

function servoCmd(cmd) {
  return new Promise((resolve, reject) => {
    if (!servoReady || !servoDaemon) {
      reject(new Error("Servo daemon not ready"));
      return;
    }
    const id = ++servoSeq;
    const timeout = setTimeout(() => {
      servoCallbacks.delete(id);
      reject(new Error("Servo command timed out"));
    }, 3000);
    servoCallbacks.set(id, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    servoDaemon.stdin.write(`SEQ:${id} ${cmd}\n`);
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
writeServoState(SERVO_CENTER, SERVO_CENTER);
startServoDaemon();

async function initServos() {
  // Wait for daemon to be ready
  await new Promise((resolve) => {
    const check = () => servoReady ? resolve() : setTimeout(check, 100);
    check();
  });
  try {
    await Promise.all([
      servoCmd(`SET ${SERVO_H_CHANNEL} ${SERVO_CENTER}`),
      servoCmd(`SET ${SERVO_V_CHANNEL} ${SERVO_CENTER}`)
    ]);
    console.log(`[Servo] initialized to ${SERVO_CENTER}°`);
  } catch (e) {
    console.error("Failed to initialize servos:", e);
  }
}
initServos();

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

// API: /servo?dir=up|down|left|right|off
app.get("/servo", async (req, res) => {
  const dir = String(req.query.dir || "").toLowerCase();
  const state = readServoState();

  if (!["up", "down", "left", "right", "off"].includes(dir)) {
    res.status(400).type("text").send(`Invalid direction. Use: up, down, left, right, off\nCurrent: H=${state.horizontal}° V=${state.vertical}°\n`);
    return;
  }

  if (dir === "off") {
    try {
      await Promise.all([
        servoCmd(`OFF ${SERVO_H_CHANNEL}`),
        servoCmd(`OFF ${SERVO_V_CHANNEL}`)
      ]);
      res.type("text").send("Servos disabled (PWM off)\n");
    } catch (err) {
      console.error(err);
      res.status(500).type("text").send(`Node error:\n${err.message}\n`);
    }
    return;
  }

  let newH = state.horizontal;
  let newV = state.vertical;

  if (dir === "left") newH = Math.min(SERVO_MAX, newH + SERVO_STEP);
  if (dir === "right") newH = Math.max(SERVO_MIN, newH - SERVO_STEP);
  if (dir === "up") newV = Math.min(SERVO_MAX, newV + SERVO_STEP);
  if (dir === "down") newV = Math.max(SERVO_MIN, newV - SERVO_STEP);

  if (newH === state.horizontal && newV === state.vertical) {
    res.type("text").send(`H: ${newH}° (limit)\nV: ${newV}° (limit)\n`);
    return;
  }

  try {
    const cmds = [];
    if (newH !== state.horizontal) cmds.push(servoCmd(`SET ${SERVO_H_CHANNEL} ${newH}`));
    if (newV !== state.vertical) cmds.push(servoCmd(`SET ${SERVO_V_CHANNEL} ${newV}`));

    await Promise.all(cmds);
    writeServoState(newH, newV);
    res.type("text").send(`H: ${state.horizontal}° → ${newH}°\nV: ${state.vertical}° → ${newV}°\n`);
  } catch (err) {
    console.error(err);
    res.status(500).type("text").send(`Node error:\n${err.message}\n`);
  }
});

// API: /servo/status
app.get("/servo/status", (_req, res) => {
  const state = readServoState();
  res.type("text").send(`H: ${state.horizontal}° V: ${state.vertical}°\n`);
});

// API: /servo/center
app.get("/servo/center", async (_req, res) => {
  try {
    await Promise.all([
      servoCmd(`SET ${SERVO_H_CHANNEL} ${SERVO_CENTER}`),
      servoCmd(`SET ${SERVO_V_CHANNEL} ${SERVO_CENTER}`)
    ]);
    writeServoState(SERVO_CENTER, SERVO_CENTER);
    res.type("text").send(`Centered: H=${SERVO_CENTER}° V=${SERVO_CENTER}°\n`);
  } catch (err) {
    console.error(err);
    res.status(500).type("text").send(`Node error:\n${err.message}\n`);
  }
});

// API: /servo/dance  — Johnny Five boogies to a rhythm
let danceActive = false;

app.get("/servo/dance", async (_req, res) => {
  if (danceActive) {
    res.status(409).type("text").send("Already dancing!\n");
    return;
  }
  danceActive = true;

  // Spawn one beep.py note and return a Promise that resolves when aplay exits.
  // This takes exactly duration_ms of wall-clock time — the audio IS the timer.
  function playNote(note, durationMs) {
    return new Promise((resolve) => {
      const proc = spawn("python3", ["-u", BEEP_SCRIPT, note, String(durationMs), "80"], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.stderr.on("data", (d) => console.error("[Dance/beep]", d.toString().trim()));
      proc.on("error", (e) => { console.error("[Dance/beep] spawn error:", e); resolve(); });
      proc.on("exit", resolve);
    });
  }

  // Move both servos and return a Promise that resolves when the daemon ACKs.
  function moveServo(h, v) {
    h = Math.max(SERVO_MIN, Math.min(SERVO_MAX, h));
    v = Math.max(SERVO_MIN, Math.min(SERVO_MAX, v));
    writeServoState(h, v);
    return Promise.all([
      servoCmd(`SET ${SERVO_H_CHANNEL} ${h}`),
      servoCmd(`SET ${SERVO_V_CHANNEL} ${v}`),
    ]);
  }

  // ---- Unified timeline ----
  // Each step: [note, h, v, duration_ms]
  // servo move + note play are started simultaneously with Promise.all —
  // the step ends when BOTH the servo ACKs AND the note finishes playing.
  // Because aplay blocks for exactly duration_ms, audio is the clock.
  //
  // Positions: C=center(135), L=left(165), R=right(105), U=up(160), D=down(110)
  // BPM 120 → Q=500ms  E=250ms  S=125ms
  const C = 135, L = 165, R = 105, U = 160, D = 110;
  const Q = 500, E = 250, S = 125;

  // note, h,  v,  ms
  const steps = [
    // ---- Bar 1: head-bob left-right ----
    ["E",  L, C, E], ["G",  R, C, E], ["A",  L, C, E], ["B",  R, C, E],
    ["A",  L, C, E], ["G",  R, C, E], ["E",  C, C, Q],
    ["R",  C, C, E],
    // ---- Bar 2: nod up-down ----
    ["D",  C, U, E], ["E",  C, D, E], ["G",  C, U, E], ["E",  C, D, Q],
    ["D",  C, U, E], ["C",  C, D, Q],
    ["R",  C, C, E],
    // ---- Bar 3: diagonal shimmy ----
    ["C",  L, U, S], ["D",  R, D, S], ["E",  L, U, S], ["G",  R, D, S],
    ["A",  L, D, S], ["B",  R, U, S], ["A",  L, D, S], ["G",  R, U, S],
    ["F#", C, C, Q], ["E",  C, C, Q],
    // ---- Bar 4: fast stutter shake ----
    ["E",  L, C, S], ["E",  C, C, S], ["G",  R, C, S], ["G",  C, C, S],
    ["A",  L, C, S], ["A",  C, C, S], ["B",  R, C, S], ["B",  C, C, S],
    ["A",  L, C, S], ["A",  C, C, S], ["G",  R, C, S], ["G",  C, C, S],
    ["E",  L, C, S], ["E",  C, C, S], ["D",  R, C, S], ["D",  C, C, S],
    // ---- Bar 5: full-circle sweep ----
    ["C",  L, U, E], ["D",  C, U, E], ["E",  R, U, E],
    ["G",  R, C, E], ["A",  R, D, E],
    ["G",  C, D, E], ["E",  L, D, E],
    ["D",  L, C, E],
    // ---- Bar 6: victory wiggle ----
    ["E",  L, U, S], ["G",  R, D, S], ["E",  L, U, S], ["G",  R, D, S],
    ["A",  L, U, S], ["B",  R, D, S], ["A",  L, U, S], ["B",  R, D, S],
    // ---- Finale: snap to center ----
    ["E",  C, C, Q], ["R",  C, C, Q],
  ];

  try {
    for (const [note, h, v, ms] of steps) {
      await Promise.all([moveServo(h, v), playNote(note, ms)]);
    }
    res.type("text").send("Dance complete!\n");
  } catch (err) {
    console.error("[Dance] error:", err);
    res.status(500).type("text").send(`Node error:\n${err.message}\n`);
  } finally {
    danceActive = false;
  }
});

// -------------------- Tracker --------------------
let trackerProcess  = null;
let trackerReady    = false;
let trackerBuffer   = "";

function stopTracker() {
  if (trackerProcess) {
    trackerProcess.kill("SIGTERM");
    trackerProcess = null;
    trackerReady   = false;
    trackerBuffer  = "";
  }
}

// API: /tracker?action=start|stop|status
app.get("/tracker", async (req, res) => {
  const action = String(req.query.action || "status").toLowerCase();

  if (action === "status") {
    res.type("text").send(`Tracker: ${trackerReady ? "running" : "stopped"}\n`);
    return;
  }

  if (action === "stop") {
    stopTracker();
    res.type("text").send("Tracker stopped\n");
    return;
  }

  if (action === "start") {
    if (trackerReady) {
      res.type("text").send("Tracker already running\n");
      return;
    }

    // Tracker reads from the MJPEG stream — camera must be running first
    const camPid = readCameraPid();
    if (!isProcessRunning(camPid)) {
      res.status(409).type("text").send("Camera is not running. Start the camera first.\n");
      return;
    }

    trackerProcess = spawn("python3", ["-u", TRACKER_SCRIPT, "--mode", String(req.query.mode || "face")], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    trackerProcess.stderr.on("data", (d) =>
      console.error("[Tracker stderr]", d.toString().trim())
    );

    trackerProcess.stdout.on("data", (d) => {
      trackerBuffer += d.toString();
      const lines = trackerBuffer.split("\n");
      trackerBuffer = lines.pop();

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line === "READY") {
          trackerReady = true;
          console.log("[Tracker] ready");
          continue;
        }

        if (line === "LOST") continue;  // nothing to do

        const m = line.match(/^MOVE (-?\d+)(?: (-?\d+))?$/);
        if (m && trackerReady && servoReady) {
          const dH    = parseInt(m[1], 10);
          const dV    = m[2] !== undefined ? parseInt(m[2], 10) : 0;
          const state = readServoState();
          const newH  = Math.max(SERVO_MIN, Math.min(SERVO_MAX, state.horizontal + dH));
          const newV  = Math.max(SERVO_MIN, Math.min(SERVO_MAX, state.vertical   + dV));
          const cmds  = [];
          if (newH !== state.horizontal) cmds.push(servoCmd(`SET ${SERVO_H_CHANNEL} ${newH}`));
          if (newV !== state.vertical)   cmds.push(servoCmd(`SET ${SERVO_V_CHANNEL} ${newV}`));
          if (cmds.length) {
            writeServoState(newH, newV);
            Promise.all(cmds).catch((e) => console.error("[Tracker] servo error:", e));
          }
        }
      }
    });

    trackerProcess.on("error", (e) => console.error("[Tracker] spawn error:", e));
    trackerProcess.on("exit", (code) => {
      console.log("[Tracker] exited with code", code);
      trackerProcess = null;
      trackerReady   = false;
      trackerBuffer  = "";
    });

    // Wait up to 5 s for READY
    const started = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 15000);
      const check    = setInterval(() => {
        if (trackerReady) { clearInterval(check); clearTimeout(deadline); resolve(true); }
      }, 100);
    });

    if (started) {
      res.type("text").send("Tracker started\n");
    } else {
      stopTracker();
      res.status(500).type("text").send("Tracker failed to start (timeout)\n");
    }
    return;
  }

  res.status(400).type("text").send("Invalid action. Use: start, stop, status\n");
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
      "--autofocus-mode", "continuous",
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
    .camera-row {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    #connectionQuality {
      font-size: 12px;
      opacity: 0.8;
    }
    .aim-panel {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 24px;
      margin: 12px 0;
    }
    .fire-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .actions-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      margin: 6px 0 4px;
    }
    .track-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .arrow-pad {
      display: grid;
      grid-template-columns: repeat(3, 50px);
      grid-template-rows: repeat(3, 50px);
      gap: 5px;
      justify-content: center;
    }
    .fire-btn {
      width: 70px;
      height: 70px;
      font-size: 13px;
      font-family: "Luckiest Guy", system-ui, sans-serif;
      border-radius: 10px;
      border: 3px solid #000;
      cursor: not-allowed;
      background: #333;
      color: #666;
      box-shadow: 0 4px 0 #000;
      transition: background 0.15s, color 0.15s, transform 0.05s;
    }
    .fire-btn.armed {
      background: var(--red);
      color: #fff;
      cursor: pointer;
      animation: pulse-glow 1s infinite;
    }
    .fire-btn.armed:active {
      transform: translateY(4px);
      box-shadow: 0 0 0 #000;
    }
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 4px 0 #000, 0 0 0px rgba(229,57,53,0); }
      50% { box-shadow: 0 4px 0 #000, 0 0 14px rgba(229,57,53,0.8); }
    }
    .fire-label {
      font-size: 10px;
      color: rgba(255,255,255,0.5);
      text-align: center;
    }
    .ms-input {
      width: 54px;
      font-size: 12px;
      padding: 4px;
      border-radius: 6px;
      border: 2px solid #000;
      text-align: center;
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
    .dance-btn {
      background: linear-gradient(135deg, #ff6ec7, #ff9500, #ffe600, #00e0ff);
      background-size: 300% 300%;
      color: #000;
      font-size: 18px;
      padding: 12px 22px;
      border-radius: 14px;
      border: 3px solid #000;
      cursor: pointer;
      box-shadow: 0 4px 0 #000;
      transition: transform 0.05s ease, box-shadow 0.05s ease;
      animation: rainbow-shift 2s linear infinite;
    }
    .dance-btn:active {
      transform: translateY(4px);
      box-shadow: 0 0 0 #000;
    }
    .dance-btn.dancing {
      animation: rainbow-shift 0.4s linear infinite, jiggle 0.15s ease-in-out infinite;
      cursor: not-allowed;
    }
    @keyframes rainbow-shift {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes jiggle {
      0%   { transform: rotate(-4deg) scale(1.04); }
      50%  { transform: rotate( 4deg) scale(1.04); }
      100% { transform: rotate(-4deg) scale(1.04); }
    }
    .track-btn {
      background: #555;
      color: #aaa;
      font-size: 15px;
      padding: 12px 18px;
      border-radius: 14px;
      border: 3px solid #000;
      cursor: pointer;
      box-shadow: 0 4px 0 #000;
      transition: background 0.2s, color 0.2s, transform 0.05s;
    }
    .track-btn:active { transform: translateY(4px); box-shadow: 0 0 0 #000; }
    .track-btn.tracking {
      background: #00e0a0;
      color: #000;
      animation: tracking-pulse 1.2s ease-in-out infinite;
    }
    @keyframes tracking-pulse {
      0%, 100% { box-shadow: 0 4px 0 #000, 0 0 0px rgba(0,224,160,0); }
      50%       { box-shadow: 0 4px 0 #000, 0 0 16px rgba(0,224,160,0.7); }
    }
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

    <!-- Camera row -->
    <div class="camera-row">
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
      <span id="connectionQuality">Testing...</span>
    </div>

    <!-- Camera area (video + controls) -->
    <div id="cameraArea" class="hidden">

      <!-- Video -->
      <div class="video-wrapper" id="videoWrapper">
        <img id="videoStream" src="">
        <div class="crosshair"></div>
        <div class="crosshair-circle"></div>
      </div>

      <!-- Aim panel: d-pad left, FIRE right -->
      <div class="aim-panel">
        <div class="arrow-pad">
          <div class="arrow-btn empty"></div>
          <button class="arrow-btn" id="aimUp">▲</button>
          <div class="arrow-btn empty"></div>
          <button class="arrow-btn" id="aimLeft">◀</button>
          <button class="arrow-btn" id="aimCenter" style="font-size:18px;background:var(--green);">⊙</button>
          <button class="arrow-btn" id="aimRight">▶</button>
          <div class="arrow-btn empty"></div>
          <button class="arrow-btn" id="aimDown">▼</button>
          <div class="arrow-btn empty"></div>
        </div>

        <div class="fire-panel">
          <button class="fire-btn armed" id="fireBtn">FIRE</button>
          <div class="fire-label">
            <input class="ms-input" id="ms" type="number" min="50" max="5000" value="500">
            <span>ms</span>
          </div>
        </div>
      </div>

      <!-- Actions bottom bar -->
      <div class="actions-bar">
        <button class="dance-btn" id="danceBtn">💃 DANCE</button>
        <div class="track-group">
          <button class="track-btn" id="trackBtn">🎯 TRACK</button>
          <select id="trackMode">
            <option value="face">Face</option>
            <option value="motion">Motion</option>
          </select>
        </div>
      </div>

    </div>

    <div id="cameraOut" class="out-box"></div>
  </div>

  <div id="iosFullscreen">
    <button id="iosClose">✕ CLOSE</button>
    <img id="iosFullscreenImg">
  </div>

  <script>
    const apiBase = () => location.protocol + "//" + location.hostname + ":3000";

    const msInput = document.getElementById("ms");
    const cameraOut = document.getElementById("cameraOut");
    const cameraStartBtn = document.getElementById("cameraStartBtn");
    const cameraStopBtn = document.getElementById("cameraStopBtn");
    const videoStream = document.getElementById("videoStream");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const qualitySelect = document.getElementById("qualitySelect");
    const connectionQuality = document.getElementById("connectionQuality");
    const fireBtn = document.getElementById("fireBtn");

    let detectedQuality = "low";

    function doFire() {
      const ms = Math.max(50, Math.min(Number(msInput.value || 500), 5000));
      fetch(apiBase() + "/cicka?mode=pulse&ms=" + ms, { cache: "no-store" }).catch(console.error);
    }

    fireBtn.addEventListener("click", doFire);

    const danceBtn = document.getElementById("danceBtn");

    async function doDance() {
      if (danceBtn.classList.contains("dancing")) return;
      danceBtn.classList.add("dancing");
      danceBtn.textContent = "🕺 DANCING...";
      try {
        const res = await fetch(apiBase() + "/servo/dance", { cache: "no-store" });
        const text = await res.text();
        cameraOut.textContent = text;
      } catch (e) {
        cameraOut.textContent = "Dance error: " + e;
      } finally {
        danceBtn.classList.remove("dancing");
        danceBtn.textContent = "💃 DANCE";
      }
    }

    danceBtn.addEventListener("click", doDance);

    // ---- Tracker ----
    const trackBtn  = document.getElementById("trackBtn");
    const trackMode = document.getElementById("trackMode");
    let tracking = false;

    async function toggleTrack() {
      const action = tracking ? "stop" : "start";
      trackBtn.disabled = true;
      try {
        const mode = trackMode.value;
        const url  = apiBase() + "/tracker?action=" + action + (action === "start" ? "&mode=" + mode : "");
        const res  = await fetch(url, { cache: "no-store" });
        const text = await res.text();
        if (res.ok) {
          tracking = !tracking;
          trackBtn.classList.toggle("tracking", tracking);
          trackBtn.textContent = tracking ? "🎯 TRACKING..." : "🎯 TRACK";
          trackMode.disabled   = tracking;
        }
        cameraOut.textContent = text.trim();
      } catch (e) {
        cameraOut.textContent = "Tracker error: " + e;
      } finally {
        trackBtn.disabled = false;
      }
    }

    trackBtn.addEventListener("click", toggleTrack);

    async function moveServo(dir) {
      const url = apiBase() + "/servo?dir=" + dir;
      try {
        await fetch(url, { cache: "no-store" });
      } catch (e) {
        console.error("Servo error:", e);
      }
    }
    async function centerServo() {
      const url = apiBase() + "/servo/center";
      try {
        await fetch(url, { cache: "no-store" });
      } catch (e) {
        console.error("Servo error:", e);
      }
    }
    document.getElementById("aimUp").addEventListener("click", () => moveServo("up"));
    document.getElementById("aimDown").addEventListener("click", () => moveServo("down"));
    document.getElementById("aimLeft").addEventListener("click", () => moveServo("left"));
    document.getElementById("aimRight").addEventListener("click", () => moveServo("right"));
    document.getElementById("aimCenter").addEventListener("click", centerServo);

    // ---- Keyboard arrow control (hold to repeat) + Space to fire ----
    const KEY_DIRS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const heldKeys = {};

    document.addEventListener("keydown", (e) => {
      if (e.key === " ") { e.preventDefault(); if (!e.repeat) doFire(); return; }
      const dir = KEY_DIRS[e.key];
      if (!dir) return;
      e.preventDefault();
      if (heldKeys[e.key]) return;
      moveServo(dir);
      heldKeys[e.key] = setInterval(() => moveServo(dir), 150);
    });

    document.addEventListener("keyup", (e) => {
      const dir = KEY_DIRS[e.key];
      if (!dir) return;
      clearInterval(heldKeys[e.key]);
      delete heldKeys[e.key];
    });

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

    // Auto-start camera on load
    testConnectionQuality().then(() => cameraApi("start"));
  </script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Express running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://<pi-ip>:${PORT}/ui`);
});