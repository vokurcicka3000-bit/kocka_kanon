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
const FACE_TRACKER_SCRIPT    = path.join(__dirname, "scripts", "face_tracker.py");
const MOTION_TRACKER_SCRIPT  = path.join(__dirname, "scripts", "motion_tracker.py");
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
// How many servo degrees correspond to the full image width / height.
// offsetX = (cx - 0.5) is in range -0.5..+0.5, so dH = offsetX * SERVO_FOV_H.
// Tune: if the shot lands short of center → increase; if it overshoots → decrease.
const SERVO_FOV_H = 150;  // degrees per full image width
const SERVO_FOV_V = 112;  // degrees per full image height

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

app.use(express.static(path.join(__dirname, "public")));

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

// API: /cicka/status — returns { on: bool } based on persisted relay state file
app.get("/cicka/status", (_req, res) => {
  let on = false;
  try {
    const raw = fs.readFileSync(RELAY_STATE_FILE, { encoding: "utf8" }).trim();
    on = raw.toUpperCase() === "ON";
  } catch (_) {}
  res.json({ on });
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
    res.json({ running: motionAlertReady });
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
          // Don't move servos while alerting — let the camera stay still for clean GIF capture
        } else if (line === "QUIET") {
          // nothing to do — tracker is not started when alerting
        } else if (line === "ENCODING") {
          console.log("[MotionAlert] encoding started");
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

// Count of human UI clients currently watching the stream.
// The motion tracker also connects to /camera/stream, but uses ?src=tracker
// so it does NOT count here.  When uiStreamClients drops to 0 we stop the
// camera; when it rises from 0 to 1 we start it.
let uiStreamClients = 0;
let cameraIdleTimer = null;        // grace-period timer before stopping
const CAMERA_IDLE_GRACE_MS = 5000; // wait 5 s before switching the camera off

const QUALITY_PRESETS = {
  veryhigh: { width: 2592, height: 1944, fps: 15, label: "Very High" },
  high: { width: 1920, height: 1080, fps: 30, label: "High" },
  medium: { width: 1280, height: 720, fps: 30, label: "Medium" },
  low: { width: 960, height: 540, fps: 20, label: "Low" },
  verylow: { width: 640, height: 480, fps: 15, label: "Very Low" }
};

// Internal helpers — stop/start the MJPEG stream without going through HTTP.
// Used by /face-track to free the camera for rpicam-still, then restore it.
function stopCameraStream() {
  return new Promise((resolve) => {
    const pid = readCameraPid();
    if (!isProcessRunning(pid) && !cameraProcess) { resolve(); return; }
    if (cameraProcess) { cameraProcess.kill("SIGTERM"); cameraProcess = null; }
    exec(`kill ${pid} 2>/dev/null; true`, () => {
      clearCameraPid();
      cameraClients.clear();
      frameBuffer = Buffer.alloc(0);
      latestFrame = null;
      // Give the OS a moment to fully release the camera device
      setTimeout(resolve, 600);
    });
  });
}

function startCameraStream(quality) {
  return new Promise((resolve, reject) => {
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS[currentQuality] || QUALITY_PRESETS.low;
    currentQuality = quality || currentQuality;
    frameBuffer = Buffer.alloc(0);
    cameraClients.clear();
    latestFrame = null;
    cameraProcess = spawn("rpicam-vid", [
      "-t", "0", "--codec", "mjpeg",
      "--width", String(preset.width),
      "--height", String(preset.height),
      "--framerate", String(preset.fps),
      "--autofocus-mode", "continuous",
      "-o", "-"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    cameraProcess.stdout.on("data", broadcastFrame);
    cameraProcess.on("error", (err) => { console.error("[Camera] spawn error:", err); reject(err); });
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
      if (isProcessRunning(cameraProcess && cameraProcess.pid)) resolve();
      else reject(new Error("Camera failed to restart"));
    }, 500);
  });
}

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

app.get("/camera/stream", async (req, res) => {
  const isUiClient = req.query.src !== "tracker";

  // If this is a UI client and the camera isn't running, start it now.
  if (isUiClient) {
    // Cancel any pending idle-stop timer
    if (cameraIdleTimer) { clearTimeout(cameraIdleTimer); cameraIdleTimer = null; }

    const quality = String(req.query.quality || currentQuality || "low").toLowerCase();
    const needsRestart = !cameraProcess || !isProcessRunning(readCameraPid()) || quality !== currentQuality;
    if (needsRestart) {
      try {
        await stopCameraStream();
        await startCameraStream(quality);
      } catch (err) {
        console.error("[Camera] auto-start failed:", err);
        res.status(503).type("text").send("Camera failed to start\n");
        return;
      }
    }
    uiStreamClients++;
    console.log(`[Camera] UI client connected (total: ${uiStreamClients})`);
  } else {
    // Tracker / internal client — camera must already be running
    if (!isProcessRunning(readCameraPid()) || !cameraProcess) {
      res.status(503).type("text").send("Camera not running\n");
      return;
    }
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

  function cleanup() {
    cameraClients.delete(res);
    if (isUiClient) {
      uiStreamClients = Math.max(0, uiStreamClients - 1);
      console.log(`[Camera] UI client disconnected (total: ${uiStreamClients})`);
      if (uiStreamClients === 0) {
        // Start grace-period timer — stop the camera if nobody reconnects
        cameraIdleTimer = setTimeout(() => {
          cameraIdleTimer = null;
          if (uiStreamClients === 0 && cameraProcess) {
            console.log("[Camera] no UI clients — stopping camera to save power");
            cameraProcess.kill("SIGTERM");
            // stopCameraStream handles state cleanup via the exit handler
          }
        }, CAMERA_IDLE_GRACE_MS);
      }
    }
  }

  req.on("close", () => { cleanup(); res.end(); });
  req.on("error", () => { cleanup(); });
});

app.get("/camera/bandwidth-test", (req, res) => {
  const size = parseInt(req.query.size) || 100;
  const data = Buffer.alloc(size * 1024, "X");
  res.type("application/octet-stream").send(data);
});

// -------------------- Face Tracking --------------------
// Fire-and-poll pattern to avoid blocking the browser UI during the 5–8 s scan.
//
// GET /face-track         → start a scan; returns { status:"started" } immediately,
//                           or { status:"busy" } if one is already running.
// GET /face-track/result  → { status:"pending" } while running,
//                           or full result JSON when done:
//                             { found, label, cx, cy, bx, by, bw, bh, dx, dy, moved }
//                           or { error } on failure.
//
// The result is cleared when a new scan is started.

let faceTrackJob = null; // null | { status: "running" | "done", result: <obj> }

async function runFaceTrack(crop = null) {
  try {
    await _runFaceTrackInner(crop);
  } catch (err) {
    // Catch-all: guarantee faceTrackJob is never left as "running"
    console.error("[FaceTrack] unhandled error:", err);
    servoTrackingEnabled = false;
    faceTrackJob = { status: "done", result: { error: err.message } };
  }
}

async function _runFaceTrackInner(crop = null) {
  // face_tracker.py now grabs a frame from the live MJPEG stream — no camera
  // stop/restart needed; the stream keeps running throughout.
  const pyArgs = [];
  if (crop) pyArgs.push("--crop", String(crop.cx), String(crop.cy), String(crop.scale));
  let result;
  try {
    const py = await runPython(FACE_TRACKER_SCRIPT, pyArgs);
    if (!py.stdout) {
      result = { error: "face_tracker.py produced no output", stderr: py.stderr };
    } else {
      result = JSON.parse(py.stdout);
    }
  } catch (err) {
    console.error("[FaceTrack] error:", err);
    result = { error: err.message };
  }

  if (result.error) {
    servoTrackingEnabled = false;
    faceTrackJob = { status: "done", result };
    return;
  }

  if (!result.found) {
    servoTrackingEnabled = false;
    faceTrackJob = { status: "done", result: { found: false, label: "none" } };
    return;
  }

  // offsetX/Y: -0.5 (left/top) to +0.5 (right/bottom), 0 = center
  const offsetX = result.cx - 0.5;
  const offsetY = result.cy - 0.5;

  // Compute target servo position — do NOT move yet.
  // Client shows the detection box for 0.5s first, then calls /face-track/move.
  const dH = -offsetX * SERVO_FOV_H;
  const dV = -offsetY * SERVO_FOV_V;

  const state = readServoState();
  const newH = Math.max(SERVO_MIN, Math.min(SERVO_MAX, Math.round(state.horizontal + dH)));
  const newV = Math.max(SERVO_MIN, Math.min(SERVO_MAX, Math.round(state.vertical   + dV)));

  // Immediately lock out the motion tracker so it cannot jitter the servos
  // while the client is showing the detection box or waiting to fire.
  servoTrackingEnabled = false;

  faceTrackJob = {
    status: "done",
    result: {
      found: true,
      label: result.label,
      cx: result.cx, cy: result.cy,
      bx: result.bx, by: result.by, bw: result.bw, bh: result.bh,
      w: result.w, h: result.h,
    },
    pendingMove: { newH, newV },
  };
}

app.get("/face-track", (req, res) => {
  if (faceTrackJob && faceTrackJob.status === "running") {
    res.json({ status: "busy" });
    return;
  }
  // Optional crop hint: ?cx=0.5&cy=0.5&scale=0.5
  let crop = null;
  if (req.query.cx !== undefined && req.query.cy !== undefined && req.query.scale !== undefined) {
    crop = {
      cx:    Math.max(0, Math.min(1, parseFloat(req.query.cx)    || 0.5)),
      cy:    Math.max(0, Math.min(1, parseFloat(req.query.cy)    || 0.5)),
      scale: Math.max(0.1, Math.min(1, parseFloat(req.query.scale) || 1.0)),
    };
  }
  faceTrackJob = { status: "running", result: null };
  runFaceTrack(crop); // fire and forget — do NOT await
  res.json({ status: "started" });
});

app.get("/face-track/result", (req, res) => {
  if (!faceTrackJob || faceTrackJob.status === "running") {
    res.json({ status: "pending" });
    return;
  }
  // Return the result (status:"done" is implicit — client gets the raw result object)
  res.json(faceTrackJob.result);
});

// Execute the servo move computed by /face-track.
// Called by the client after showing the detection box for 0.5s.
app.get("/face-track/move", async (_req, res) => {
  if (!faceTrackJob || !faceTrackJob.pendingMove) {
    res.json({ moved: false });
    return;
  }
  const { newH, newV } = faceTrackJob.pendingMove;
  faceTrackJob.pendingMove = null;
  try {
    await Promise.all([
      servoCmd(`SET ${SERVO_H_CHANNEL} ${newH}`),
      servoCmd(servoSetCmd(SERVO_V_CHANNEL, newV)),
    ]);
    writeServoState(newH, newV);
    res.json({ moved: true });
  } catch (err) {
    console.error("[FaceTrack/move] servo error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- Motion Tracking --------------------
// Spawns motion_tracker.py which reads the MJPEG stream and emits JSON lines.
// For each active frame, Node applies a P-controller to move the servos.
// Every REFINE_INTERVAL_S seconds (signalled by refine:true from the script)
// we run a one-shot face-detect pass to sharpen the aim.
//
// P-controller tuning:
//   offsetX = cx - 0.5   (range -0.5 .. +0.5; positive = target is right of centre)
//   dH = -offsetX * TRACK_GAIN  (negative: target right → decrease H angle)
//   dV = -offsetY * TRACK_GAIN  (negative: target below → decrease V angle)
//   clamped to ±TRACK_MAX_STEP degrees per cycle

const TRACK_GAIN     = 70;   // proportional gain (degrees per unit offset)
const TRACK_MAX_STEP = 10;   // max degrees to move in one cycle

let motionTrackerProcess  = null;
let motionTrackingActive  = false;
let motionTrackerBuffer   = "";
// Servo moves from motion tracker are only applied when SEEK is active
let servoTrackingEnabled  = false;
// True while a motion-tracker servo move is in-flight (awaiting servoCmd).
// Prevents a new async invocation from piling up behind the current one.
let motionTrackerMoveInFlight = false;

function stopMotionTracking() {
  if (motionTrackerProcess) {
    try { motionTrackerProcess.kill("SIGTERM"); } catch (_) {}
    motionTrackerProcess = null;
  }
  motionTrackingActive = false;
  motionTrackerBuffer  = "";
  motionTrackerMoveInFlight = false;
}

function startMotionTracking() {
  if (motionTrackerProcess) return; // already running

  motionTrackerProcess = spawn("python3", ["-u", MOTION_TRACKER_SCRIPT], {
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  motionTrackingActive = true;
  motionTrackerBuffer  = "";

  motionTrackerProcess.stderr.on("data", (d) =>
    console.error("[MotionTracker stderr]", d.toString().trim())
  );

  motionTrackerProcess.stdout.on("data", async (d) => {
    motionTrackerBuffer += d.toString();
    const lines = motionTrackerBuffer.split("\n");
    motionTrackerBuffer = lines.pop();

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { continue; }

      if (msg.ready) {
        console.log("[MotionTracker] stream connected");
        continue;
      }

      if (msg.error) {
        console.error("[MotionTracker] error:", msg.error);
        // Python reconnects itself — don't kill the process here
        continue;
      }

      if (!msg.active) continue; // quiet frame — nothing to do

      // Only move servos when SEEK is active
      if (!servoTrackingEnabled) continue;

      // Skip this frame if a previous move is still awaiting — avoids
      // piling up async invocations that could fire after SEEK ends.
      if (motionTrackerMoveInFlight) continue;

      // ---- Apply P-controller ----
      const offsetX = msg.cx - 0.5;
      const offsetY = msg.cy - 0.5;

      const rawDH = -offsetX * TRACK_GAIN;
      const rawDV = -offsetY * TRACK_GAIN;
      const dH = Math.max(-TRACK_MAX_STEP, Math.min(TRACK_MAX_STEP, rawDH));
      const dV = Math.max(-TRACK_MAX_STEP, Math.min(TRACK_MAX_STEP, rawDV));

      const state = readServoState();
      const newH  = Math.max(SERVO_MIN, Math.min(SERVO_MAX, Math.round(state.horizontal + dH)));
      const newV  = Math.max(SERVO_MIN, Math.min(SERVO_MAX, Math.round(state.vertical   + dV)));

      const cmds = [];
      if (newH !== state.horizontal) cmds.push(servoCmd(`SET ${SERVO_H_CHANNEL} ${newH}`));
      if (newV !== state.vertical)   cmds.push(servoCmd(servoSetCmd(SERVO_V_CHANNEL, newV)));
      if (cmds.length) {
        // Re-check the flag synchronously right before going async.
        // servoTrackingEnabled could have been cleared between the check
        // above and here (same tick), but this is the safest we can be
        // without making the handler synchronous.
        if (!servoTrackingEnabled) continue;
        motionTrackerMoveInFlight = true;
        try {
          await Promise.all(cmds);
          // Only persist if SEEK is still active — discard stale moves.
          if (servoTrackingEnabled) writeServoState(newH, newV);
        } catch (e) {
          console.error("[MotionTracker] servo error:", e.message);
        } finally {
          motionTrackerMoveInFlight = false;
        }
      }

      // ---- Face-detection refinement ----
      if (msg.refine && (!faceTrackJob || faceTrackJob.status !== "running")) {
        faceTrackJob = { status: "running", result: null };
        // Fire-and-forget — _runFaceTrackInner handles camera stop/restart
        runFaceTrack();
      }
    }
  });

  motionTrackerProcess.on("error", (e) => {
    console.error("[MotionTracker] spawn error:", e);
    stopMotionTracking();
  });

  motionTrackerProcess.on("exit", (code) => {
    console.log("[MotionTracker] exited with code", code);
    motionTrackerProcess = null;
    motionTrackingActive = false;
    motionTrackerBuffer  = "";
  });

  console.log("[MotionTracker] started");
}

// API: /motion-track/status
app.get("/motion-track/status", (_req, res) => {
  res.json({ active: motionTrackingActive });
});

// API: /motion-track/start
app.get("/motion-track/start", (_req, res) => {
  startMotionTracking();
  res.json({ started: true });
});

// API: /motion-track/stop
app.get("/motion-track/stop", (_req, res) => {
  stopMotionTracking();
  res.json({ stopped: true });
});

// API: /motion-track/servo-enable  — called when SEEK becomes active
app.get("/motion-track/servo-enable", (_req, res) => {
  servoTrackingEnabled = true;
  res.json({ servoTracking: true });
});

// API: /motion-track/servo-disable  — called when SEEK is cancelled or face found
app.get("/motion-track/servo-disable", (_req, res) => {
  servoTrackingEnabled = false;
  res.json({ servoTracking: false });
});

// Simple UI
app.get("/ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kočka kanón</title>
  <link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/ui.css">
</head>
<body>
  <h1>
    <svg class="cat-icon" viewBox="0 0 100 100" fill="currentColor">
      <path d="M20 90 L20 50 L10 20 L30 35 L50 25 L70 35 L90 20 L80 50 L80 90 Z"/>
      <circle cx="35" cy="55" r="5" fill="#111"/>
      <circle cx="65" cy="55" r="5" fill="#111"/>
      <ellipse cx="50" cy="68" rx="5" ry="3" fill="#ff9999"/>
    </svg>
    Kočka kanón
  </h1>

  <div class="main-card">

    <!-- Camera area (video + controls) -->
    <div id="cameraArea" class="hidden">

      <!-- Video -->
      <div class="video-wrapper" id="videoWrapper">
        <img id="videoStream" src="">
        <canvas class="crosshair-canvas" id="crosshairCanvas"></canvas>
        <!-- Quality selector — bottom-left corner overlay -->
        <div class="quality-bar">
          <select id="qualitySelect" title="Video quality">
            <option value="veryhigh">Very High</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low" selected>Low</option>
            <option value="verylow">Very Low</option>
          </select>
        </div>
      </div>

      <!-- Camera controls: D-pad + FIRE -->
      <div class="controls-row">
        <!-- D-pad -->
        <div class="dpad">
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dUp"    data-dir="up"    title="Up (↑)">▲</button>
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dLeft"  data-dir="left"  title="Left (←)">◀</button>
          <button class="dpad-btn center-btn" id="dCenter" title="Center servos">⊕</button>
          <button class="dpad-btn" id="dRight" data-dir="right" title="Right (→)">▶</button>
          <div class="dpad-empty"></div>
          <button class="dpad-btn" id="dDown"  data-dir="down"  title="Down (↓)">▼</button>
          <div class="dpad-empty"></div>
        </div>

        <!-- FIRE button + Find-face button -->
        <div class="fire-wrap">
          <!-- Face-track button: same design as FIRE, smiley face SVG -->
          <div class="face-col">
            <div class="face-guard" id="faceTrackBtn" role="button" title="Find face">
              <svg class="face-svg" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                <!-- face circle outline -->
                <circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width="2.5" fill="none"/>
                <!-- eyes -->
                <circle class="face-eye" cx="13" cy="15" r="2.5" fill="currentColor"/>
                <circle class="face-eye" cx="27" cy="15" r="2.5" fill="currentColor"/>
                <!-- mouth: normal smile -->
                <path class="face-smile" d="M12 24 Q20 32 28 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/>
                <!-- mouth: seeking — straight line, hidden by default -->
                <path class="face-meh" d="M13 26 L27 26" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/>
                <!-- mouth: notfound — sad, hidden by default -->
                <path class="face-sad" d="M12 28 Q20 20 28 28" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/>
                <!-- seeking: spinning scan arc, hidden by default -->
                <circle class="face-scan" cx="20" cy="20" r="17" stroke="currentColor" stroke-width="3"
                        fill="none" stroke-dasharray="28 80" stroke-linecap="round"/>
              </svg>
            </div>
            <span class="face-label">SEEK</span>
          </div>

          <div class="fire-col">
            <div class="fire-guard">
              <button class="fire-btn" id="fireBtn">FIRE</button>
            </div>
            <span class="fire-label">&#9888; ARMED</span>
          </div>
        </div>
      </div>

      <!-- Actions bar: motion alert + camera toggle -->
      <div class="actions-bar">
        <div class="alert-group">
          <button class="alert-btn" id="alertBtn">🔔 MOTION ALERT</button>
        </div>
        <div class="alert-group">
          <button class="camera-btn" id="cameraToggleBtn">📷 CAMERA</button>
        </div>
      </div>

      <!-- Watering controls -->
      <div class="watering-bar">
        <span class="watering-label">&#128167; WATERING</span>
        <div class="watering-btns">
          <button class="water-btn water-on-btn" id="waterOnBtn">&#9654; START</button>
          <button class="water-btn water-off-btn" id="waterOffBtn" disabled>&#9632; STOP</button>
        </div>
      </div>

    </div>


  </div>

  <!-- Telegram credentials — fixed bottom-left, intentionally unobtrusive -->
  <div class="tg-cfg">
    <input id="tgToken"  type="text" placeholder="Telegram bot token" autocomplete="off" spellcheck="false">
    <input id="tgChatId" type="text" placeholder="Telegram chat ID"   autocomplete="off" spellcheck="false">
  </div>

  <script>
    const apiBase = () => location.protocol + "//" + location.hostname + ":3000";

    const videoStream = document.getElementById("videoStream");

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

    function setAlertState(on) {
      alerting = on;
      alertBtn.classList.toggle("alerting", alerting);
      alertBtn.textContent = alerting ? "🔔 ALERTING..." : "🔔 MOTION ALERT";
    }

    async function toggleAlert() {
      const action = alerting ? "stop" : "start";
      alertBtn.disabled = true;
      try {
        let url = apiBase() + "/motion-alert?action=" + action;
        if (action === "start") {
          const token  = tgToken.value.trim();
          const chatId = tgChatId.value.trim();
          if (!token || !chatId) {
            alertBtn.textContent = "🔔 NEED TOKEN+ID";
            setTimeout(() => { alertBtn.textContent = "🔔 MOTION ALERT"; }, 2000);
            return;
          }
          url += "&token=" + encodeURIComponent(token) + "&chat_id=" + encodeURIComponent(chatId);
        }
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) setAlertState(!alerting);
      } catch (e) {
        console.error("Alert error:", e);
      } finally {
        alertBtn.disabled = false;
      }
    }

    // Restore motion alert state from server on page load
    fetch(apiBase() + "/motion-alert?action=status", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.running) setAlertState(true); })
      .catch(() => {});

    alertBtn.addEventListener("click", toggleAlert);

    // ---- Camera toggle ----
    const cameraToggleBtn = document.getElementById("cameraToggleBtn");
    let cameraOn = true; // default on — auto-started on page load

    function setCameraState(on) {
      cameraOn = on;
      cameraToggleBtn.classList.toggle("cam-off", !on);
      cameraToggleBtn.textContent = on ? "📷 CAMERA" : "📷 CAMERA OFF";
    }

    cameraToggleBtn.addEventListener("click", async () => {
      cameraToggleBtn.disabled = true;
      try {
        if (cameraOn) {
          await fetch(apiBase() + "/camera?action=stop", { cache: "no-store" });
          videoStream.src = "";
          setCameraState(false);
        } else {
          // Re-connect the stream — server auto-starts the camera on first UI connection
          videoStream.src = apiBase() + "/camera/stream?src=ui&quality=" + detectedQuality + "&t=" + Date.now();
          setCameraState(true);
        }
      } catch (e) {
        console.error("Camera toggle error:", e);
      } finally {
        cameraToggleBtn.disabled = false;
      }
    });

    async function testConnectionQuality() {
      try {
        const start = performance.now();
        await (await fetch(apiBase() + "/camera/bandwidth-test?size=200", { cache: "no-store" })).arrayBuffer();
        const mbps = (200 * 8) / ((performance.now() - start) / 1000);
        if (mbps > 50) detectedQuality = "veryhigh";
        else if (mbps > 30) detectedQuality = "high";
        else if (mbps > 15) detectedQuality = "medium";
        else if (mbps > 5) detectedQuality = "low";
        else detectedQuality = "verylow";
      } catch (e) {
        detectedQuality = "verylow";
      }
    }

    async function cameraCheckStatus() {
      try {
        const t = await (await fetch(apiBase() + "/camera?action=status", { cache: "no-store" })).text();
        const cameraArea = document.getElementById("cameraArea");
        if (t.includes("running")) {
          cameraArea.classList.remove("hidden");
          if (!videoStream.src || videoStream.src.indexOf("/camera/stream") === -1) {
            videoStream.src = apiBase() + "/camera/stream?src=ui&t=" + Date.now();
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
        setTimeout(() => { videoStream.src = apiBase() + "/camera/stream?src=ui&t=" + Date.now(); }, 1000);
      }
    };

    // ---- Servo control ----
    // servoDir sends one step. servoStep is throttled so rapid calls
    // don't flood the server while a hold or drag is active.
    let servoInflight = false;
    async function servoDir(dir) {
      if (servoInflight) return;
      servoInflight = true;
      try {
        await fetch(apiBase() + "/servo?dir=" + dir, { cache: "no-store" });
      } catch (e) {
        console.error("Servo error:", e);
      } finally {
        servoInflight = false;
      }
    }

    // ---- Hold-to-move D-pad ----
    // Fires immediately on press, then repeats every REPEAT_MS while held.
    const REPEAT_MS = 120;
    let holdTimer = null;

    function startHold(dir) {
      if (holdTimer) return;
      servoDir(dir);
      holdTimer = setInterval(() => servoDir(dir), REPEAT_MS);
    }

    function stopHold() {
      if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    }

    document.querySelectorAll(".dpad-btn[data-dir]").forEach(btn => {
      const dir = btn.dataset.dir;
      btn.addEventListener("mousedown",  (e) => { e.preventDefault(); startHold(dir); });
      btn.addEventListener("touchstart", (e) => { e.preventDefault(); startHold(dir); }, { passive: false });
    });
    document.addEventListener("mouseup",   stopHold);
    document.addEventListener("touchend",  stopHold);
    document.addEventListener("touchcancel", stopHold);

    document.getElementById("dCenter").addEventListener("click", () => {
      fetch(apiBase() + "/servo/center", { cache: "no-store" }).catch(console.error);
    });

    // ---- FIRE (relay pulse) ----
    let fireInFlight = false;
    async function fireCannon() {
      if (fireInFlight) return;
      const btn = document.getElementById("fireBtn");
      fireInFlight = true;
      btn.disabled = true;
      btn.textContent = "...";
      // Safety net: always re-enable after 2 s even if fetch hangs
      const safetyTimer = setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "FIRE";
        fireInFlight = false;
      }, 2000);
      flashCrosshair();
      try {
        await fetch(apiBase() + "/cicka?mode=pulse&ms=1500", { cache: "no-store" });
      } catch (e) {
        console.error("Fire error:", e);
      } finally {
        clearTimeout(safetyTimer);
        btn.disabled = false;
        btn.textContent = "FIRE";
        fireInFlight = false;
      }
    }
    document.getElementById("fireBtn").addEventListener("click", fireCannon);

    // ---- Watering (continuous on/off) ----
    let wateringOn = false;
    const waterOnBtn  = document.getElementById("waterOnBtn");
    const waterOffBtn = document.getElementById("waterOffBtn");

    function setWateringState(on) {
      wateringOn = on;
      waterOnBtn.classList.toggle("running", on);
      waterOnBtn.disabled  = on;
      waterOffBtn.disabled = !on;
    }

    async function startWatering() {
      waterOnBtn.disabled = true;
      try {
        await fetch(apiBase() + "/cicka?mode=on", { cache: "no-store" });
        setWateringState(true);
      } catch (e) {
        console.error("Watering start error:", e);
        waterOnBtn.disabled = false;
      }
    }

    async function stopWatering() {
      waterOffBtn.disabled = true;
      try {
        await fetch(apiBase() + "/cicka?mode=off", { cache: "no-store" });
        setWateringState(false);
      } catch (e) {
        console.error("Watering stop error:", e);
        waterOffBtn.disabled = false;
      }
    }

    // Restore watering state from server on page load
    fetch(apiBase() + "/cicka/status", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.on) setWateringState(true); })
      .catch(() => {});

    waterOnBtn.addEventListener("click", startWatering);
    waterOffBtn.addEventListener("click", stopWatering);

     // ---- Crosshair + face-detection overlay ----
     const crosshairCanvas = document.getElementById("crosshairCanvas");
     const crosshairCtx = crosshairCanvas.getContext("2d");

     // Last face-detect result to overlay; cleared after FACE_BOX_LINGER_MS
     let faceBox = null;           // { bx,by,bw,bh,label,score } all normalised 0-1
     let faceBoxTimer = null;
     const FACE_BOX_LINGER_MS = 4000;

     function clearFaceBox() {
       faceBox = null;
       if (faceBoxTimer) { clearTimeout(faceBoxTimer); faceBoxTimer = null; }
       drawCrosshair(false);
     }

     function showFaceBox(data) {
       if (faceBoxTimer) clearTimeout(faceBoxTimer);
       faceBox = data.found ? data : null;
       drawCrosshair(false);
       if (faceBox) {
         faceBoxTimer = setTimeout(clearFaceBox, FACE_BOX_LINGER_MS);
       }
     }

     function drawFaceBox(canvasW, canvasH) {
       if (!faceBox) return;
       const { bx, by, bw, bh, label, score, w: frameW, h: frameH } = faceBox;

       const natW = frameW || canvasW;
       const natH = frameH || canvasH;
       const imgAspect    = natW / natH;
       const canvasAspect = canvasW / canvasH;

       let imgW, imgH, imgX, imgY;
       if (imgAspect > canvasAspect) {
         imgW = canvasW;
         imgH = canvasW / imgAspect;
         imgX = 0;
         imgY = (canvasH - imgH) / 2;
       } else {
         imgH = canvasH;
         imgW = canvasH * imgAspect;
         imgX = (canvasW - imgW) / 2;
         imgY = 0;
       }

       const px = imgX + bx * imgW;
       const py = imgY + by * imgH;
       const pw = bw * imgW;
       const ph = bh * imgH;

       const isCat = label === "cat";
       const boxColor  = isCat ? "rgba(255,200,0,0.95)"  : "rgba(0,220,255,0.95)";
       const glowColor = isCat ? "#ffc800"                : "#00dcff";
       const bracketLen = Math.min(pw, ph) * 0.28;
       const lw = 2.5;

       crosshairCtx.strokeStyle = boxColor;
       crosshairCtx.lineWidth   = lw;
       crosshairCtx.shadowColor = glowColor;
       crosshairCtx.shadowBlur  = 10;

       // Corner brackets — TL, TR, BL, BR
       [
         [px,      py,      1,  1],
         [px + pw, py,     -1,  1],
         [px,      py + ph, 1, -1],
         [px + pw, py + ph,-1, -1],
       ].forEach(([ox, oy, sx, sy]) => {
         crosshairCtx.beginPath();
         crosshairCtx.moveTo(ox + sx * bracketLen, oy);
         crosshairCtx.lineTo(ox, oy);
         crosshairCtx.lineTo(ox, oy + sy * bracketLen);
         crosshairCtx.stroke();
       });

       // Centre dot
       const dotX = px + pw / 2;
       const dotY = py + ph / 2;
       crosshairCtx.beginPath();
       crosshairCtx.arc(dotX, dotY, lw * 1.5, 0, Math.PI * 2);
       crosshairCtx.fillStyle = boxColor;
       crosshairCtx.shadowBlur = 8;
       crosshairCtx.fill();

       // Label + score pill above the box
       const labelText = label.toUpperCase() + "  " + Math.round(score * 100) + "%";
       const fontSize  = Math.max(11, Math.min(16, pw * 0.18));
       crosshairCtx.font         = "bold " + fontSize + "px monospace";
       crosshairCtx.shadowBlur   = 0;
       const textW = crosshairCtx.measureText(labelText).width;
       const padX = 6, padY = 4;
       const pillX = px;
       const pillY = py - fontSize - padY * 2 - 2;
       // pill background
       crosshairCtx.fillStyle = "rgba(0,0,0,0.55)";
       crosshairCtx.beginPath();
       crosshairCtx.roundRect(pillX, pillY, textW + padX * 2, fontSize + padY * 2, 4);
       crosshairCtx.fill();
       // pill border
       crosshairCtx.strokeStyle = boxColor;
       crosshairCtx.lineWidth   = 1;
       crosshairCtx.stroke();
       // text
       crosshairCtx.fillStyle  = boxColor;
       crosshairCtx.shadowColor = glowColor;
       crosshairCtx.shadowBlur  = 6;
       crosshairCtx.fillText(labelText, pillX + padX, pillY + fontSize + padY - 1);
       crosshairCtx.shadowBlur = 0;
     }

     // cx/cy in canvas pixels — normally center, offset while dragging
     let chX = null, chY = null;

     function drawCrosshair(flash, ox, oy) {
       const w = crosshairCanvas.width  = crosshairCanvas.offsetWidth;
       const h = crosshairCanvas.height = crosshairCanvas.offsetHeight;
       // Default to center
       const cx = (ox != null) ? ox : w / 2;
       const cy = (oy != null) ? oy : h / 2;
       const gap = Math.min(w, h) * 0.045;
       const arm = Math.min(w, h) * 0.13;
       const r   = Math.min(w, h) * 0.055;
       const color = flash ? "rgba(255,80,80,0.95)" : "rgba(0,255,80,0.85)";

       crosshairCtx.clearRect(0, 0, w, h);

       // Face detection box (drawn first, behind crosshair)
       drawFaceBox(w, h);

       // If dragging, draw a faint line from center to crosshair
       if (ox != null && oy != null) {
         crosshairCtx.beginPath();
         crosshairCtx.moveTo(w / 2, h / 2);
         crosshairCtx.lineTo(cx, cy);
         crosshairCtx.strokeStyle = "rgba(0,255,80,0.25)";
         crosshairCtx.lineWidth = 1;
         crosshairCtx.shadowBlur = 0;
         crosshairCtx.stroke();
       }

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
     videoStream.addEventListener("load", () => drawCrosshair(false));

     function flashCrosshair() {
       drawCrosshair(true);
       setTimeout(() => drawCrosshair(false), 200);
     }

    // ---- Drag-to-aim on the video ----
    // Dragging maps the offset from center to servo direction.
    // A "zone" threshold prevents tiny jitters from firing.
    // While dragging, servo steps are sent continuously based on offset magnitude.
    const DRAG_DEAD_PX  = 15;   // px from center before servo starts moving
    const DRAG_STEP_MS  = 130;  // how often to send a servo step while dragging
    const DRAG_FAST_PX  = 80;   // offset beyond which we send 2 steps per tick

    let dragging = false;
    let dragTimer = null;
    let dragOffX = 0, dragOffY = 0;

    function getCanvasPos(e) {
      const rect = crosshairCanvas.getBoundingClientRect();
      const src  = e.touches ? e.touches[0] : e;
      return {
        x: src.clientX - rect.left,
        y: src.clientY - rect.top,
      };
    }

    function dragStep() {
      const w = crosshairCanvas.offsetWidth;
      const h = crosshairCanvas.offsetHeight;
      const absX = Math.abs(dragOffX), absY = Math.abs(dragOffY);
      const steps = (Math.max(absX, absY) > DRAG_FAST_PX) ? 2 : 1;
      // Send the dominant axis (or both if roughly equal)
      for (let i = 0; i < steps; i++) {
        if (absX >= DRAG_DEAD_PX && absX >= absY * 0.5) {
          servoDir(dragOffX > 0 ? "right" : "left");
        }
        if (absY >= DRAG_DEAD_PX && absY >= absX * 0.5) {
          servoDir(dragOffY > 0 ? "down" : "up");
        }
      }
    }

    function onDragStart(e) {
      if (e.target === crosshairCanvas || e.target === videoStream) {
        e.preventDefault();
        dragging = true;
        const pos = getCanvasPos(e);
        const w = crosshairCanvas.offsetWidth, h = crosshairCanvas.offsetHeight;
        dragOffX = pos.x - w / 2;
        dragOffY = pos.y - h / 2;
        drawCrosshair(false, pos.x, pos.y);
        dragTimer = setInterval(dragStep, DRAG_STEP_MS);
      }
    }

    function onDragMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const pos = getCanvasPos(e);
      const w = crosshairCanvas.offsetWidth, h = crosshairCanvas.offsetHeight;
      dragOffX = pos.x - w / 2;
      dragOffY = pos.y - h / 2;
      drawCrosshair(false, pos.x, pos.y);
    }

    function onDragEnd(e) {
      if (!dragging) return;
      dragging = false;
      dragOffX = 0; dragOffY = 0;
      if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
      drawCrosshair(false); // snap back to center
    }

    crosshairCanvas.addEventListener("mousedown",   onDragStart);
    crosshairCanvas.addEventListener("touchstart",  onDragStart, { passive: false });
    document.addEventListener("mousemove",  onDragMove);
    document.addEventListener("touchmove",  onDragMove, { passive: false });
    document.addEventListener("mouseup",    onDragEnd);
    document.addEventListener("touchend",   onDragEnd);
    document.addEventListener("touchcancel",onDragEnd);

    // Make the canvas show a grab cursor when hoverable
    crosshairCanvas.style.cursor = "crosshair";

    // ---- Keyboard: hold-to-repeat arrows + spacebar fire ----
    const heldKeys = {};
    document.addEventListener("keydown", (e) => {
      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      if (map[e.key] && !heldKeys[e.key]) {
        e.preventDefault();
        heldKeys[e.key] = true;
        startHold(map[e.key]);
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) fireCannon();
      }
    });
    document.addEventListener("keyup", (e) => {
      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      if (map[e.key]) {
        delete heldKeys[e.key];
        // Only stop hold if no other arrow is still pressed
        if (!Object.keys(heldKeys).length) stopHold();
      }
    });

    // ---- Face tracking ----
    const faceTrackBtn = document.getElementById("faceTrackBtn");

    // Initialise the switch to SAFE position
    faceTrackBtn.dataset.state = "safe";

    // ---- Face tracking — fire-and-poll ----
    // SEEK keeps re-scanning until a face is found, then fires and stops.
    // Clicking SEEK again while active cancels the loop.
    let faceTrackPolling = null;

    function stopFaceTrackPolling() {
      if (faceTrackPolling !== null) {
        clearInterval(faceTrackPolling);
        faceTrackPolling = null;
      }
    }

    function setSwitch(state) {
      faceTrackBtn.dataset.state = state;
    }

    async function kickFaceScan(crop = null) {
      try {
        let url = apiBase() + "/face-track";
        if (crop) url += "?cx=" + crop.cx + "&cy=" + crop.cy + "&scale=" + crop.scale;
        const kickoff = await fetch(url, { cache: "no-store" });
        const kickData = await kickoff.json();
        if (kickData.status !== "started" && kickData.status !== "busy") {
          throw new Error("Unexpected kickoff response: " + JSON.stringify(kickData));
        }
      } catch (e) {
        console.error("FaceTrack kickoff error:", e);
        setSwitch("safe");
        stopFaceTrackPolling();
      }
    }

    function startFaceTrackPoll() {
      stopFaceTrackPolling();
      faceTrackPolling = setInterval(async () => {
        // If user cancelled manually, stop
        if (faceTrackBtn.dataset.state === "safe") { stopFaceTrackPolling(); return; }
        try {
          const r = await fetch(apiBase() + "/face-track/result", { cache: "no-store" });
          const d = await r.json();
          if (d.status === "pending") return; // still scanning
          onFaceTrackResult(d);
        } catch (e) {
          console.error("FaceTrack poll error:", e);
          stopFaceTrackPolling();
          setSwitch("safe");
        }
      }, 500);
    }

    async function onFaceTrackResult(data) {
      stopFaceTrackPolling();

      if (data.error) {
        setSwitch("safe");
        return;
      }

      if (!data.found) {
        // Nothing found — kick another scan and keep seeking
        if (faceTrackBtn.dataset.state === "seeking") {
          await kickFaceScan();
          startFaceTrackPoll();
        }
        return;
      }

      // Face found — refine aim with up to 3 scan+move passes.
      // Pass 1: full frame. Pass 2: ¼ area (scale 0.5). Pass 3: ⅕ area (scale 0.447).
      // The crop centres on the last known face position so the detector works on a
      // progressively tighter window, giving a more accurate centroid each time.
      const CROP_SCALES = [null, 0.5, 0.447]; // index = pass-1; null = no crop
      let lastData = data; // track the most recent detection result for the final box
      for (let pass = 1; pass <= CROP_SCALES.length; pass++) {
        if (faceTrackBtn.dataset.state !== "seeking" && faceTrackBtn.dataset.state !== "track") return; // cancelled

        // Move servos to the position computed by this scan
        await fetch(apiBase() + "/face-track/move", { cache: "no-store" }).catch(e => {
          console.error("FaceTrack move error:", e);
        });

        if (pass === CROP_SCALES.length) break; // no need to re-scan after the last move

        // Kick next scan with a tighter crop centred on the face we just found
        const scale = CROP_SCALES[pass]; // pass is 1-indexed, so CROP_SCALES[pass] = next pass scale
        const crop = scale ? { cx: lastData.cx, cy: lastData.cy, scale } : null;
        await kickFaceScan(crop);
        const nextData = await new Promise((resolve) => {
          const poll = setInterval(async () => {
            if (faceTrackBtn.dataset.state !== "seeking" && faceTrackBtn.dataset.state !== "track") {
              clearInterval(poll);
              resolve(null); // cancelled
              return;
            }
            try {
              const r = await fetch(apiBase() + "/face-track/result", { cache: "no-store" });
              const d = await r.json();
              if (d.status !== "pending") { clearInterval(poll); resolve(d); }
            } catch (e) {
              console.error("FaceTrack poll error:", e);
              clearInterval(poll);
              resolve({ error: e.message });
            }
          }, 500);
        });

        if (!nextData) return; // cancelled
        if (nextData.error || !nextData.found) {
          // Lost the face on a refinement pass — use whatever position we already moved to
          break;
        }

        lastData = nextData; // server has a new pendingMove ready for next iteration
      }

      if (faceTrackBtn.dataset.state !== "seeking" && faceTrackBtn.dataset.state !== "track") return; // cancelled

      // All passes done — show detection box, lock on, fire
      setSwitch("track");
      showFaceBox(lastData);
      await new Promise(r => setTimeout(r, 1000));
      if (faceTrackBtn.dataset.state !== "track") return; // cancelled
      clearFaceBox();
      setSwitch("safe");
      fireCannon();
    }

    faceTrackBtn.addEventListener("click", async () => {
      const state = faceTrackBtn.dataset.state;

       // TRACK/SEEKING → SAFE: cancel everything
       if (state === "track" || state === "seeking") {
         stopFaceTrackPolling();
         clearFaceBox();
         setSwitch("safe");
         return;
       }

      // SAFE → SEEK: start the continuous scan loop
      setSwitch("seeking");
      await kickFaceScan();
      startFaceTrackPoll();
    });

    // ---- Motion tracking indicator ----
    // ---- Quality dropdown ----
    const qualitySelect = document.getElementById("qualitySelect");

    function applyQuality(quality) {
      detectedQuality = quality;
      qualitySelect.value = quality;
      // Reconnect the stream at the new quality — server restarts the camera
      videoStream.src = apiBase() + "/camera/stream?src=ui&quality=" + quality + "&t=" + Date.now();
    }

    qualitySelect.addEventListener("change", () => applyQuality(qualitySelect.value));

    // Connect the video stream — the server will auto-start the camera for us.
    // Quality is detected first so the server knows what resolution to use.
    testConnectionQuality().then(() => {
      const cameraArea = document.getElementById("cameraArea");
      cameraArea.classList.remove("hidden");
      qualitySelect.value = detectedQuality;
      videoStream.src = apiBase() + "/camera/stream?src=ui&quality=" + detectedQuality + "&t=" + Date.now();
      requestAnimationFrame(() => drawCrosshair(false));
    });
  </script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Express running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://<pi-ip>:${PORT}/ui`);
  // Start motion tracking immediately — it will wait for the stream internally
  startMotionTracking();
  console.log("[Boot] motion tracker started");
});