#!/usr/bin/env python3
"""
tracker.py — servo tracking controller.

Reads the MJPEG stream already served by Node (so it never opens the camera
directly and never conflicts with rpicam-vid).

Two modes selectable via --mode argument:

  face   (default) — Haar cascade face detector.  Locks onto the largest
                     detected face.  Very precise, requires a frontal face view.

  motion           — Frame-differencing motion detector.  Compares frames
                     that are N frames apart, finds the centroid of the largest
                     region of change.  Tracks anything large that moves.
                     Reference frame is frozen after each MOVE so camera pans
                     don't feed back into the detector.

Output protocol (stdout, line-buffered):
  READY               emitted after the first frame is decoded
  MOVE <delta>        signed int degrees  (+ = pan left, - = pan right)
  LOST                no target found this frame

Usage:
  python3 tracker.py [--mode face|motion] [stream_url]
"""

import sys
import time
import urllib.request
import numpy as np
import cv2

# ---- Parse args ----
MODE       = "face"
STREAM_URL = "http://localhost:3000/camera/stream"
args = sys.argv[1:]
while args:
    a = args.pop(0)
    if a == "--mode" and args:
        MODE = args.pop(0)
    elif not a.startswith("--"):
        STREAM_URL = a

CASCADE_XML = "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"

# ---- Shared tuning ----
# Proportional gain: servo degrees per pixel of horizontal error.
# Higher = more aggressive tracking.
KP             = 0.09
# Dead zone: fraction of frame width around centre — no correction inside this band.
# Smaller = reacts to smaller offsets.
DEAD_ZONE_FRAC = 0.07
# Minimum servo move in degrees — steps smaller than this are ignored.
# Prevents 1-degree corrections that immediately overshoot.
MIN_DELTA      = 2
# After a MOVE, wait this long before the next one (lets servo settle).
# Shorter = more responsive, but too short causes oscillation.
COOLDOWN_S     = 0.25
# Maximum single-step servo move in degrees.  Prevents wild jumps.
MAX_DELTA      = 20

# ---- Face-mode tuning ----
# Minimum face bounding-box width as fraction of frame width (filters far-away faces).
MIN_FACE_FRAC  = 0.04
# Resize factor before running detection (speed vs accuracy trade-off).
DETECT_SCALE   = 0.5

# ---- Motion-mode tuning ----
# Pixel intensity difference threshold (0-255): changes below this are ignored.
# Higher = only strong/fast movement triggers, lower = more sensitive.
DIFF_THRESHOLD = 25
# Minimum contiguous changed area in pixels. Filters out noise, small insects etc.
# At 320px wide a person torso is roughly 50x80 = 4000px minimum.
MIN_AREA       = 3000
# Compare current frame against a reference taken this many frames ago.
# More frames apart = detects slower movement but is less twitchy.
FRAME_GAP      = 3
# After a MOVE, freeze the reference frame for this many frames so the camera
# pan itself isn't detected as motion.
FREEZE_FRAMES  = 10


# ---- Idle scan tuning ----
# How long (seconds) without a detected face before idle scan kicks in.
IDLE_TIMEOUT_S  = 2.0
# Degrees to step per scan tick.
SCAN_STEP       = 3
# Seconds between scan steps.
SCAN_INTERVAL_S = 0.35
# Horizontal limits for the scan sweep (degrees, within 0-270 range).
SCAN_MIN        = 60
SCAN_MAX        = 210


# ---- MJPEG stream reader ----
def iter_mjpeg_frames(url, timeout=15):
    req = urllib.request.urlopen(url, timeout=timeout)
    buf = b""
    SOI = b"\xff\xd8"
    EOI = b"\xff\xd9"
    while True:
        chunk = req.read(8192)
        if not chunk:
            break
        buf += chunk
        while True:
            s = buf.find(SOI)
            if s == -1:
                buf = b""
                break
            e = buf.find(EOI, s + 2)
            if e == -1:
                buf = buf[s:]
                break
            yield buf[s:e + 2]
            buf = buf[e + 2:]


def wait_for_stream():
    for _ in range(20):
        try:
            urllib.request.urlopen(STREAM_URL, timeout=2).close()
            return
        except Exception:
            time.sleep(0.5)
    print("ERROR could not connect to stream", file=sys.stderr, flush=True)
    sys.exit(1)


# ---- Face tracking ----
def run_face():
    cascade = cv2.CascadeClassifier(CASCADE_XML)
    if cascade.empty():
        print(f"ERROR failed to load {CASCADE_XML}", file=sys.stderr, flush=True)
        sys.exit(1)

    wait_for_stream()

    ready_sent   = False
    frame_cx     = dead_zone_px = min_face_px = None
    last_move_t  = 0.0
    last_seen_t  = 0.0   # last time a face was detected
    last_scan_t  = 0.0   # last idle scan step
    scan_dir     = 1     # +1 = sweeping right (increasing degrees), -1 = left
    # Local estimate of the horizontal servo position (degrees).
    # Initialised to centre; updated whenever we emit a MOVE.
    servo_est    = 135

    for jpeg in iter_mjpeg_frames(STREAM_URL):
        arr   = np.frombuffer(jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if frame is None:
            continue

        h, w = frame.shape
        if not ready_sent:
            frame_cx     = w // 2
            dead_zone_px = w * DEAD_ZONE_FRAC
            min_face_px  = int(w * MIN_FACE_FRAC)
            last_seen_t  = time.monotonic()  # don't scan immediately on start
            print("READY", flush=True)
            ready_sent = True

        now = time.monotonic()

        # ---- Detection ----
        small = cv2.resize(frame, (int(w * DETECT_SCALE), int(h * DETECT_SCALE)))
        small = cv2.equalizeHist(small)

        faces = cascade.detectMultiScale(
            small,
            scaleFactor  = 1.1,
            minNeighbors = 4,
            minSize      = (min_face_px, min_face_px),
        )

        face_found = len(faces) > 0

        # ---- Tracking move (face visible) ----
        if face_found:
            last_seen_t = now

            if now - last_move_t >= COOLDOWN_S:
                x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                cx = int((x + fw / 2) / DETECT_SCALE)

                error_px = cx - frame_cx  # type: ignore[operator]
                if abs(error_px) >= dead_zone_px:  # type: ignore[operator]
                    delta = -round(error_px * KP)
                    delta = max(-MAX_DELTA, min(MAX_DELTA, delta))
                    if abs(delta) >= MIN_DELTA:
                        print(f"MOVE {delta}", flush=True)
                        servo_est   = max(SCAN_MIN, min(SCAN_MAX, servo_est + delta))
                        last_move_t = now

        # ---- Idle scan (no face for IDLE_TIMEOUT_S) ----
        else:
            print("LOST", flush=True)
            idle = now - last_seen_t
            if idle >= IDLE_TIMEOUT_S and now - last_scan_t >= SCAN_INTERVAL_S:
                # Bounce at limits
                if servo_est >= SCAN_MAX:
                    scan_dir = -1
                elif servo_est <= SCAN_MIN:
                    scan_dir = 1
                delta = scan_dir * SCAN_STEP
                print(f"MOVE {delta}", flush=True)
                servo_est   = max(SCAN_MIN, min(SCAN_MAX, servo_est + delta))
                last_scan_t = now


# ---- Motion tracking ----
def run_motion():
    wait_for_stream()

    morph_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))

    ready_sent   = False
    frame_cx     = dead_zone_px = None
    last_move_t  = 0.0

    # Ring buffer of recent frames for frame-differencing
    ring         = []
    freeze       = 0   # frames remaining where reference is not updated

    for jpeg in iter_mjpeg_frames(STREAM_URL):
        arr   = np.frombuffer(jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if frame is None:
            continue

        # Blur to reduce per-pixel JPEG noise before differencing
        frame = cv2.GaussianBlur(frame, (7, 7), 0)

        h, w = frame.shape
        if not ready_sent:
            frame_cx     = w // 2
            dead_zone_px = w * DEAD_ZONE_FRAC
            print("READY", flush=True)
            ready_sent = True

        # Build up ring buffer before we can diff
        ring.append(frame)
        if len(ring) <= FRAME_GAP:
            continue
        if len(ring) > FRAME_GAP + 1:
            ring.pop(0)

        # During freeze we still accumulate frames but don't act
        if freeze > 0:
            freeze -= 1
            continue

        now = time.monotonic()
        if now - last_move_t < COOLDOWN_S:
            continue

        # Absolute difference between current frame and the one FRAME_GAP ago
        ref  = ring[0]
        curr = ring[-1]
        diff = cv2.absdiff(curr, ref)
        _, mask = cv2.threshold(diff, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)

        # Clean up speckle noise with morphological ops
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, morph_kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  morph_kernel)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            print("LOST", flush=True)
            continue

        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) < MIN_AREA:
            print("LOST", flush=True)
            continue

        M  = cv2.moments(largest)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])

        error_px = cx - frame_cx  # type: ignore[operator]
        if abs(error_px) < dead_zone_px:  # type: ignore[operator]
            continue

        delta = -round(error_px * KP)
        delta = max(-MAX_DELTA, min(MAX_DELTA, delta))
        if abs(delta) >= MIN_DELTA:
            print(f"MOVE {delta}", flush=True)
            last_move_t = now
            # Freeze reference so the pan itself isn't detected as motion
            freeze = FREEZE_FRAMES
            ring.clear()


# ---- Entry point ----
if __name__ == "__main__":
    try:
        if MODE == "motion":
            run_motion()
        else:
            run_face()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"ERROR {e}", file=sys.stderr, flush=True)
        sys.exit(1)
