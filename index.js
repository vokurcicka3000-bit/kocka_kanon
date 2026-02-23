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
const MOTION_ALERT_SCRIPT = path.join(__dirname, "scripts", "motion_alert.py");
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
const SERVO_V_SETTLE_MS = 500; // ms to hold position before cutting PWM on vertical servo

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

// Sends SET for the given channel, then schedules an OFF after SERVO_V_SETTLE_MS for
// the vertical channel so it holds its position briefly and then relaxes (no idle jitter).
// The delayed OFF is fire-and-forget; a newer move cancels the pending OFF via the timer ref.
const servoVOffTimer = { ref: null };
function servoSetCmd(channel, angle) {
  if (channel !== SERVO_V_CHANNEL) return `SET ${channel} ${angle}`;
  // Cancel any pending OFF from a previous move, then re-arm after this move resolves.
  if (servoVOffTimer.ref) { clearTimeout(servoVOffTimer.ref); servoVOffTimer.ref = null; }
  servoVOffTimer.ref = setTimeout(() => {
    servoVOffTimer.ref = null;
    servoCmd(`OFF ${SERVO_V_CHANNEL}`).catch((e) => console.error("[Servo] delayed OFF error:", e));
  }, SERVO_V_SETTLE_MS);
  return `SET ${channel} ${angle}`;
}


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
      servoCmd(servoSetCmd(SERVO_V_CHANNEL, SERVO_CENTER))
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
    if (newV !== state.vertical) cmds.push(servoCmd(servoSetCmd(SERVO_V_CHANNEL, newV)));

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
      servoCmd(servoSetCmd(SERVO_V_CHANNEL, SERVO_CENTER))
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
      servoCmd(servoSetCmd(SERVO_V_CHANNEL, v)),
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

// -------------------- Motion Alert --------------------
let motionAlertProcess = null;
let motionAlertReady   = false;
let motionAlertBuffer  = "";

function stopMotionAlert() {
  if (motionAlertProcess) {
    motionAlertProcess.kill("SIGTERM");
    motionAlertProcess = null;
    motionAlertReady   = false;
    motionAlertBuffer  = "";
  }
}

// API: /motion-alert?action=start|stop|status
// Optional query params for start: token=<bot_token>&chat_id=<chat_id>
app.get("/motion-alert", async (req, res) => {
  const action = String(req.query.action || "status").toLowerCase();

  if (action === "status") {
    res.type("text").send(`Motion alert: ${motionAlertReady ? "running" : "stopped"}\n`);
    return;
  }

  if (action === "stop") {
    stopMotionAlert();
    res.type("text").send("Motion alert stopped\n");
    return;
  }

  if (action === "start") {
    if (motionAlertReady) {
      res.type("text").send("Motion alert already running\n");
      return;
    }

    const camPid = readCameraPid();
    if (!isProcessRunning(camPid)) {
      res.status(409).type("text").send("Camera is not running. Start the camera first.\n");
      return;
    }

    const token  = String(req.query.token   || process.env.TELEGRAM_TOKEN   || "");
    const chatId = String(req.query.chat_id || process.env.TELEGRAM_CHAT_ID || "");

    motionAlertProcess = spawn("python3", ["-u", MOTION_ALERT_SCRIPT], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED:  "1",
        TELEGRAM_TOKEN:    token,
        TELEGRAM_CHAT_ID:  chatId,
      },
    });

    motionAlertProcess.stderr.on("data", (d) =>
      console.error("[MotionAlert stderr]", d.toString().trim())
    );

    motionAlertProcess.stdout.on("data", (d) => {
      motionAlertBuffer += d.toString();
      const lines = motionAlertBuffer.split("\n");
      motionAlertBuffer = lines.pop();

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line === "READY") {
          motionAlertReady = true;
          console.log("[MotionAlert] ready");
        } else if (line === "MOTION") {
          console.log("[MotionAlert] motion detected");
        }
      }
    });

    motionAlertProcess.on("error", (e) => console.error("[MotionAlert] spawn error:", e));
    motionAlertProcess.on("exit", (code) => {
      console.log("[MotionAlert] exited with code", code);
      motionAlertProcess = null;
      motionAlertReady   = false;
      motionAlertBuffer  = "";
    });

    // Wait up to 15 s for READY
    const started = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 15000);
      const check    = setInterval(() => {
        if (motionAlertReady) { clearInterval(check); clearTimeout(deadline); resolve(true); }
      }, 100);
    });

    if (started) {
      res.type("text").send("Motion alert started\n");
    } else {
      stopMotionAlert();
      res.status(500).type("text").send("Motion alert failed to start (timeout)\n");
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
    .crosshair-canvas {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      border-radius: 10px;
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
    .actions-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      margin: 12px 0 4px;
    }
    .alert-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .alert-cfg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: rgba(255,255,255,0.7);
    }
    .alert-cfg input {
      font-family: monospace;
      font-size: 11px;
      padding: 4px 6px;
      border-radius: 6px;
      border: 2px solid #000;
      background: rgba(255,255,255,0.15);
      color: #fff;
      width: 200px;
    }
    .alert-cfg input::placeholder { color: rgba(255,255,255,0.35); }
    .arrow-pad {
      display: grid;
      grid-template-columns: repeat(3, 50px);
      grid-template-rows: repeat(3, 50px);
      gap: 5px;
      justify-content: center;
    }
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
    .alert-btn {
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
    .alert-btn:active { transform: translateY(4px); box-shadow: 0 0 0 #000; }
    .alert-btn.alerting {
      background: #e53935;
      color: #fff;
      animation: alert-pulse 1.2s ease-in-out infinite;
    }
    @keyframes alert-pulse {
      0%, 100% { box-shadow: 0 4px 0 #000, 0 0 0px rgba(229,57,53,0); }
      50%       { box-shadow: 0 4px 0 #000, 0 0 16px rgba(229,57,53,0.8); }
    }

    /* ---- D-pad + FIRE ---- */
    .controls-row {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 32px;
      margin: 14px 0 6px;
      flex-wrap: wrap;
    }
    .dpad {
      display: grid;
      grid-template-columns: repeat(3, 52px);
      grid-template-rows: repeat(3, 52px);
      gap: 4px;
    }
    .dpad-btn {
      width: 52px;
      height: 52px;
      font-size: 22px;
      padding: 0;
      border-radius: 10px;
      border: 3px solid #000;
      cursor: pointer;
      box-shadow: 0 4px 0 #000;
      transition: transform 0.05s ease;
      background: #4A90E2;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .dpad-btn:active { transform: translateY(4px); box-shadow: 0 0 0 #000; }
    .dpad-btn.center-btn {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.3);
      color: rgba(255,255,255,0.3);
      cursor: default;
      box-shadow: none;
      font-size: 13px;
    }
    .dpad-empty { width: 52px; height: 52px; }

    /* Aircraft FIRE button */
    .fire-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .fire-guard {
      position: relative;
      width: 84px;
      height: 84px;
    }
    /* Safety guard arc */
    .fire-guard::before {
      content: "";
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      border: 5px solid #ff9800;
      border-bottom-color: transparent;
      border-left-color: transparent;
      transform: rotate(-45deg);
      pointer-events: none;
      box-shadow: 0 0 8px rgba(255,152,0,0.6);
    }
    .fire-btn {
      width: 84px;
      height: 84px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #ff5252, #b71c1c);
      border: 4px solid #000;
      color: #fff;
      font-family: "Luckiest Guy", system-ui, sans-serif;
      font-size: 13px;
      letter-spacing: 1px;
      cursor: pointer;
      box-shadow: 0 6px 0 #7f0000, 0 0 20px rgba(255,82,82,0.5);
      transition: transform 0.05s ease, box-shadow 0.05s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1.1;
    }
    .fire-btn:active {
      transform: translateY(6px);
      box-shadow: 0 0 0 #7f0000, 0 0 28px rgba(255,82,82,0.9);
    }
    .fire-label {
      font-size: 10px;
      color: #ff9800;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    .fire-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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
        <canvas class="crosshair-canvas" id="crosshairCanvas"></canvas>
      </div>

      <!-- Camera controls: D-pad + FIRE -->
      <div class="controls-row">
        <!-- D-pad -->
        <div class="dpad">
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dUp"    title="Up (↑)"    onclick="servoDir('up')">▲</button>
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dLeft"  title="Left (←)"  onclick="servoDir('left')">◀</button>
          <button class="dpad-btn center-btn"  title="Camera aim">⊕</button>
          <button class="dpad-btn" id="dRight" title="Right (→)" onclick="servoDir('right')">▶</button>
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dDown"  title="Down (↓)"  onclick="servoDir('down')">▼</button>
          <div class="dpad-empty"></div>
        </div>

        <!-- FIRE button -->
        <div class="fire-wrap">
          <div class="fire-guard">
            <button class="fire-btn" id="fireBtn" onclick="fireCannon()">FIRE</button>
          </div>
          <span class="fire-label">&#9888; ARMED</span>
        </div>
      </div>

      <!-- Actions bar: motion alert -->
      <div class="actions-bar">
        <div class="alert-group">
          <button class="alert-btn" id="alertBtn">🔔 MOTION ALERT</button>
          <div class="alert-cfg">
            <input id="tgToken"  type="text" placeholder="Telegram bot token" autocomplete="off" spellcheck="false">
            <input id="tgChatId" type="text" placeholder="Telegram chat ID"   autocomplete="off" spellcheck="false">
          </div>
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

    const cameraOut = document.getElementById("cameraOut");
    const cameraStartBtn = document.getElementById("cameraStartBtn");
    const cameraStopBtn = document.getElementById("cameraStopBtn");
    const videoStream = document.getElementById("videoStream");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const qualitySelect = document.getElementById("qualitySelect");
    const connectionQuality = document.getElementById("connectionQuality");

    let detectedQuality = "low";

    // ---- Motion Alert ----
    const alertBtn  = document.getElementById("alertBtn");
    const tgToken   = document.getElementById("tgToken");
    const tgChatId  = document.getElementById("tgChatId");
    let alerting = false;

    // Persist token/chat_id in localStorage so the user doesn't retype them
    tgToken.value  = localStorage.getItem("tgToken")  || "";
    tgChatId.value = localStorage.getItem("tgChatId") || "";
    tgToken.addEventListener("input",  () => localStorage.setItem("tgToken",  tgToken.value));
    tgChatId.addEventListener("input", () => localStorage.setItem("tgChatId", tgChatId.value));

    async function toggleAlert() {
      const action = alerting ? "stop" : "start";
      alertBtn.disabled = true;
      try {
        let url = apiBase() + "/motion-alert?action=" + action;
        if (action === "start") {
          const token  = tgToken.value.trim();
          const chatId = tgChatId.value.trim();
          if (!token || !chatId) {
            cameraOut.textContent = "Enter your Telegram bot token and chat ID first.";
            return;
          }
          url += "&token=" + encodeURIComponent(token) + "&chat_id=" + encodeURIComponent(chatId);
        }
        const res  = await fetch(url, { cache: "no-store" });
        const text = await res.text();
        if (res.ok) {
          alerting = !alerting;
          alertBtn.classList.toggle("alerting", alerting);
          alertBtn.textContent = alerting ? "🔔 ALERTING..." : "🔔 MOTION ALERT";
        }
        cameraOut.textContent = text.trim();
      } catch (e) {
        cameraOut.textContent = "Alert error: " + e;
      } finally {
        alertBtn.disabled = false;
      }
    }

    alertBtn.addEventListener("click", toggleAlert);

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
          // Ensure crosshair is drawn now that the area is visible
          requestAnimationFrame(() => drawCrosshair(false));
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

    // ---- Servo D-pad ----
    async function servoDir(dir) {
      try {
        await fetch(apiBase() + "/servo?dir=" + dir, { cache: "no-store" });
      } catch (e) {
        cameraOut.textContent = "Servo error: " + e;
      }
    }

    // ---- FIRE (relay pulse) ----
    async function fireCannon() {
      const btn = document.getElementById("fireBtn");
      btn.disabled = true;
      btn.textContent = "...";
      flashCrosshair();
      try {
        const res = await fetch(apiBase() + "/cicka?mode=pulse&ms=300", { cache: "no-store" });
        cameraOut.textContent = (await res.text()).trim();
      } catch (e) {
        cameraOut.textContent = "Fire error: " + e;
      } finally {
        btn.disabled = false;
        btn.textContent = "FIRE";
      }
    }

    // ---- Crosshair overlay ----
    const crosshairCanvas = document.getElementById("crosshairCanvas");
    const crosshairCtx = crosshairCanvas.getContext("2d");

    function drawCrosshair(flash) {
      const w = crosshairCanvas.width  = crosshairCanvas.offsetWidth;
      const h = crosshairCanvas.height = crosshairCanvas.offsetHeight;
      const cx = w / 2, cy = h / 2;
      const gap = Math.min(w, h) * 0.045;
      const arm = Math.min(w, h) * 0.13;
      const r   = Math.min(w, h) * 0.055;
      const color = flash ? "rgba(255,80,80,0.95)" : "rgba(0,255,80,0.85)";

      crosshairCtx.clearRect(0, 0, w, h);
      crosshairCtx.strokeStyle = color;
      crosshairCtx.lineWidth = 2;
      crosshairCtx.shadowColor = flash ? "#ff2020" : "#00ff50";
      crosshairCtx.shadowBlur = 6;

      // Center circle
      crosshairCtx.beginPath();
      crosshairCtx.arc(cx, cy, r, 0, Math.PI * 2);
      crosshairCtx.stroke();

      // Four arms
      [[cx, cy - gap, cx, cy - gap - arm],
       [cx, cy + gap, cx, cy + gap + arm],
       [cx - gap, cy, cx - gap - arm, cy],
       [cx + gap, cy, cx + gap + arm, cy]].forEach(([x1,y1,x2,y2]) => {
        crosshairCtx.beginPath();
        crosshairCtx.moveTo(x1, y1);
        crosshairCtx.lineTo(x2, y2);
        crosshairCtx.stroke();
      });
    }

    drawCrosshair(false);
    window.addEventListener("resize", () => drawCrosshair(false));
    // Redraw once the video has actual dimensions (first frame decoded)
    videoStream.addEventListener("load", () => drawCrosshair(false));

    // Flash red on fire
    function flashCrosshair() {
      drawCrosshair(true);
      setTimeout(() => drawCrosshair(false), 200);
    }

    // ---- Arrow key + spacebar support ----
    document.addEventListener("keydown", (e) => {
      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      if (map[e.key]) {
        e.preventDefault();
        servoDir(map[e.key]);
      }
      if (e.code === "Space") {
        e.preventDefault();
        fireCannon();
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