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

const QUALITY_PRESETS = {
  veryhigh: { width: 2592, height: 1944, fps: 15, quality: 50, label: "Very High" },
  high:     { width: 1920, height: 1080, fps: 30, quality: 60, label: "High"      },
  medium:   { width: 1280, height: 720,  fps: 30, quality: 70, label: "Medium"    },
  low:      { width: 960,  height: 540,  fps: 20, quality: 75, label: "Low"       },
  verylow:  { width: 640,  height: 480,  fps: 15, quality: 80, label: "Very Low"  },
  cellular: { width: 480,  height: 270,  fps: 10, quality: 88, label: "Cellular"  },
};

// Internal helpers — stop/start the MJPEG stream without going through HTTP.
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
      "--quality", String(preset.quality),
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
      "--quality", String(preset.quality),
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


// -------------------- Motion Tracking --------------------
// Spawns motion_tracker.py which reads the MJPEG stream and emits JSON lines.
// For each active motion frame, Node applies a P-controller to track the
// motion centroid with the servos, then fires the cannon.
//
// Fire-and-cooldown state machine:
//   - When motion is detected and NOT in cooldown: track with P-controller,
//     then fire after FIRE_SETTLE_MS (to allow servo to settle on target).
//   - After firing: cooldown for FIRE_COOLDOWN_MS — ignore all motion frames.
//   - During cooldown: skip P-controller and fire entirely.
//
// P-controller tuning:
//   offsetX = cx - 0.5   (range -0.5 .. +0.5; positive = target is right of centre)
//   dH = -offsetX * TRACK_GAIN  (negative: target right → decrease H angle)
//   dV = -offsetY * TRACK_GAIN  (negative: target below → decrease V angle)
//   clamped to ±TRACK_MAX_STEP degrees per cycle

const TRACK_GAIN       = 70;    // proportional gain (degrees per unit offset)
const TRACK_MAX_STEP   = 10;    // max degrees to move in one cycle
const FIRE_SETTLE_MS   = 300;   // ms to track before firing (let servo settle)
const FIRE_COOLDOWN_MS = 2000;  // ms to ignore motion after a shot

let motionTrackerProcess  = null;
let motionTrackingActive  = false;
let motionTrackerBuffer   = "";

// Fire-and-cooldown state
let motionCooldown      = false;  // true while in post-fire sleep
let motionCooldownTimer = null;   // clearTimeout handle
let motionSettleTimer   = null;   // clearTimeout handle for pre-fire settle delay
let motionBoutActive    = false;  // true while motion is currently detected
let motionServoInflight = false;  // true while a servo command is awaiting — skip new ones

function stopMotionTracking() {
  if (motionTrackerProcess) {
    try { motionTrackerProcess.kill("SIGTERM"); } catch (_) {}
    motionTrackerProcess = null;
  }
  motionTrackingActive = false;
  motionTrackerBuffer  = "";
  motionCooldown       = false;
  motionBoutActive     = false;
  motionServoInflight  = false;
  if (motionCooldownTimer) { clearTimeout(motionCooldownTimer); motionCooldownTimer = null; }
  if (motionSettleTimer)   { clearTimeout(motionSettleTimer);   motionSettleTimer   = null; }
}

function startMotionTracking() {
  if (motionTrackerProcess) return; // already running

  motionTrackerProcess = spawn("python3", ["-u", MOTION_TRACKER_SCRIPT], {
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  motionTrackingActive = true;
  motionTrackerBuffer  = "";
  motionCooldown       = false;
  motionBoutActive     = false;

  motionTrackerProcess.stderr.on("data", (d) =>
    console.error("[MotionTracker stderr]", d.toString().trim())
  );

  motionTrackerProcess.stdout.on("data", (d) => {
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
        stopMotionTracking();
        return;
      }

      if (!msg.active) {
        // Motion went quiet — cancel any pending settle timer
        if (motionBoutActive) {
          motionBoutActive = false;
          if (motionSettleTimer) { clearTimeout(motionSettleTimer); motionSettleTimer = null; }
        }
        continue;
      }

      // ---- In cooldown — skip everything ----
      if (motionCooldown) continue;

      // ---- Apply P-controller (fire-and-forget — never await in the data handler) ----
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
      if (cmds.length && !motionServoInflight) {
        motionServoInflight = true;
        writeServoState(newH, newV); // update state file immediately so next frame reads new position
        Promise.all(cmds)
          .catch((e) => console.error("[MotionTracker] servo error:", e.message))
          .finally(() => { motionServoInflight = false; });
      }

      // ---- Schedule fire after settle delay (first frame of each bout only) ----
      if (!motionBoutActive) {
        motionBoutActive = true;
        motionSettleTimer = setTimeout(async () => {
          motionSettleTimer = null;
          if (motionCooldown || !motionTrackingActive) return;
          // Enter cooldown immediately so no further shots are queued
          motionCooldown = true;
          console.log("[MotionTracker] firing cannon");
          try {
            await fetch(`http://localhost:${PORT}/cicka?mode=pulse&ms=1500`, { cache: "no-store" });
          } catch (e) {
            console.error("[MotionTracker] fire error:", e.message);
          }
          // Release cooldown after FIRE_COOLDOWN_MS
          motionCooldownTimer = setTimeout(() => {
            motionCooldownTimer = null;
            motionCooldown      = false;
            motionBoutActive    = false;
            console.log("[MotionTracker] cooldown over — armed");
          }, FIRE_COOLDOWN_MS);
        }, FIRE_SETTLE_MS);
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
    motionCooldown       = false;
    motionBoutActive     = false;
    motionServoInflight  = false;
    if (motionCooldownTimer) { clearTimeout(motionCooldownTimer); motionCooldownTimer = null; }
    if (motionSettleTimer)   { clearTimeout(motionSettleTimer);   motionSettleTimer   = null; }
  });

  console.log("[MotionTracker] started");
}

// API: /motion-track/start
app.get("/motion-track/start", (_req, res) => {
  startMotionTracking();
  res.json({ started: true });
});

// API: /motion-track/status
app.get("/motion-track/status", (_req, res) => {
  res.json({
    active:   motionTrackingActive,
    cooldown: motionCooldown,
  });
});

// API: /motion-track/stop
app.get("/motion-track/stop", (_req, res) => {
  stopMotionTracking();
  res.json({ stopped: true });
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
        <div class="quality-bar">
          <select id="qualitySelect">
            <option value="auto">Auto</option>
            <option value="cellular">Cellular</option>
            <option value="verylow">Very Low</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="veryhigh">Very High</option>
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

        <!-- FIRE button -->
          <div class="fire-wrap">
            <div class="fire-col">
              <div class="fire-guard">
                <button class="fire-btn" id="fireBtn">FIRE</button>
              </div>
              <span class="fire-label">&#9888; ARMED</span>
            </div>
          </div>
      </div>

      <!-- Actions bar: motion alert + AUTO tracking toggle -->
        <div class="actions-bar">
          <div class="alert-group">
            <button class="alert-btn" id="alertBtn">🔔 MOTION ALERT</button>
          </div>
          <!-- AUTO toggle — starts/stops motion-tracking auto-fire -->
          <div class="track-group" id="trackGroup">
            <button class="track-auto-btn" id="trackAutoBtn" data-state="off">&#9654; AUTO</button>
            <div class="track-status" id="trackStatus"></div>
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
    const qualitySelect = document.getElementById("qualitySelect");

    // Restore last manual choice if any
    const savedQuality = localStorage.getItem("quality");
    if (savedQuality) qualitySelect.value = savedQuality;

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
            alertBtn.textContent = "🔔 NEED TOKEN+ID";
            setTimeout(() => { alertBtn.textContent = "🔔 MOTION ALERT"; }, 2000);
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
      } catch (e) {
        console.error("Alert error:", e);
      } finally {
        alertBtn.disabled = false;
      }
    }

    alertBtn.addEventListener("click", toggleAlert);

    async function testConnectionQuality() {
      try {
        const start = performance.now();
        await (await fetch(apiBase() + "/camera/bandwidth-test?size=50", { cache: "no-store" })).arrayBuffer();
        const mbps = (50 * 8) / ((performance.now() - start) / 1000);
        if (mbps > 50) detectedQuality = "veryhigh";
        else if (mbps > 30) detectedQuality = "high";
        else if (mbps > 15) detectedQuality = "medium";
        else if (mbps > 5)  detectedQuality = "low";
        else if (mbps > 1)  detectedQuality = "verylow";
        else                detectedQuality = "cellular";
      } catch (e) {
        detectedQuality = "cellular";
      }
    }

    async function cameraApi(action) {
      let url = apiBase() + "/camera?action=" + action;
      if (action === "start") {
        const chosen = qualitySelect.value;
        const q = chosen === "auto" ? detectedQuality : chosen;
        url += "&quality=" + q;
        // Reflect actual quality in the dropdown when auto
        if (chosen === "auto") qualitySelect.title = "Auto: " + q;
        else qualitySelect.title = "";
      }
      try {
        await fetch(url, { cache: "no-store" });
      } catch (e) {
        console.error("Camera error:", e);
      }
      cameraCheckStatus();
    }

    qualitySelect.addEventListener("change", async () => {
      const v = qualitySelect.value;
      if (v === "auto") localStorage.removeItem("quality");
      else localStorage.setItem("quality", v);
      await fetch(apiBase() + "/camera?action=stop", { cache: "no-store" }).catch(() => {});
      cameraApi("start");
    });

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

    async function startWatering() {
      waterOnBtn.disabled = true;
      try {
        await fetch(apiBase() + "/cicka?mode=on", { cache: "no-store" });
        wateringOn = true;
        waterOnBtn.classList.add("running");
        waterOffBtn.disabled = false;
      } catch (e) {
        console.error("Watering start error:", e);
        waterOnBtn.disabled = false;
      }
    }

    async function stopWatering() {
      waterOffBtn.disabled = true;
      try {
        await fetch(apiBase() + "/cicka?mode=off", { cache: "no-store" });
        wateringOn = false;
        waterOnBtn.classList.remove("running");
        waterOnBtn.disabled = false;
      } catch (e) {
        console.error("Watering stop error:", e);
        waterOffBtn.disabled = false;
      }
    }

    waterOnBtn.addEventListener("click", startWatering);
    waterOffBtn.addEventListener("click", stopWatering);

     // ---- Crosshair ----
     const crosshairCanvas = document.getElementById("crosshairCanvas");
     const crosshairCtx = crosshairCanvas.getContext("2d");

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

    // ---- AUTO motion-tracking toggle ----
    const trackAutoBtn = document.getElementById("trackAutoBtn");
    const trackStatus  = document.getElementById("trackStatus");
    let trackingActive = false;
    let trackingCooldown = false;
    let trackStatusInterval = null;

    function setTrackingUI(active, cooldown) {
      trackingActive   = active;
      trackingCooldown = cooldown;
      if (!active) {
        trackAutoBtn.dataset.state = "off";
        trackAutoBtn.textContent   = "\u25BA AUTO";
        trackAutoBtn.classList.remove("auto-armed", "auto-cooldown");
        trackStatus.textContent = "";
      } else if (cooldown) {
        trackAutoBtn.dataset.state = "cooldown";
        trackAutoBtn.textContent   = "\u23F3 COOLDOWN";
        trackAutoBtn.classList.remove("auto-armed");
        trackAutoBtn.classList.add("auto-cooldown");
        trackStatus.textContent = "";
      } else {
        trackAutoBtn.dataset.state = "armed";
        trackAutoBtn.textContent   = "\u25A0 ARMED";
        trackAutoBtn.classList.add("auto-armed");
        trackAutoBtn.classList.remove("auto-cooldown");
        trackStatus.textContent = "";
      }
    }

    async function pollTrackingStatus() {
      try {
        const r = await fetch(apiBase() + "/motion-track/status", { cache: "no-store" });
        const d = await r.json();
        setTrackingUI(!!d.active, !!d.cooldown);
      } catch (_) {}
    }

    trackAutoBtn.addEventListener("click", async () => {
      if (trackingActive) {
        // Stop
        try {
          await fetch(apiBase() + "/motion-track/stop", { cache: "no-store" });
          setTrackingUI(false, false);
        } catch (e) {
          console.error("Track stop error:", e);
        }
      } else {
        // Start
        try {
          await fetch(apiBase() + "/motion-track/start", { cache: "no-store" });
          setTrackingUI(true, false);
        } catch (e) {
          console.error("Track start error:", e);
        }
      }
    });

    // Poll tracking status every 1.5 s (picks up cooldown transitions)
    setInterval(pollTrackingStatus, 1500);

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