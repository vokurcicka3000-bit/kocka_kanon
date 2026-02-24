#!/usr/bin/env python3
"""
motion_tracker.py — continuous motion centroid tracker for servo pan/tilt.

Reads the MJPEG stream served by Node, detects motion via frame differencing,
and emits JSON lines on stdout describing where the motion is.

Output protocol (stdout, one JSON line per cycle):
  {"active": true,  "cx": 0.52, "cy": 0.38, "area": 14500}
      → motion detected; cx/cy are normalised (0–1) centroid of the largest
        moving region.
  {"active": true,  "cx": …, "cy": …, "area": …, "refine": true}
      → same, but also request a face-detection refinement pass from Node.
  {"active": false}
      → no motion this cycle (or motion just stopped).
  {"ready": true}
      → stream connected, first frame decoded.
  {"error": "<msg>"}
      → non-fatal stream error; script will attempt to reconnect.

Usage:
  python3 motion_tracker.py [stream_url]
"""

import sys
import os
import time
import json
import signal
import urllib.request
import urllib.error
import numpy as np
import cv2

# ---- Config ----
STREAM_URL      = "http://localhost:3000/camera/stream?src=tracker"

args = sys.argv[1:]
while args:
    a = args.pop(0)
    if not a.startswith("--"):
        STREAM_URL = a

# Pixel intensity difference threshold (0-255)
DIFF_THRESHOLD  = 20
# Minimum contiguous changed area (in detection-scale pixels) to count as motion
MIN_AREA        = 2500
# Compare current frame to one FRAME_GAP frames back
FRAME_GAP       = 2
# Downscale factor before detection (smaller = faster, less accurate centroid)
DETECT_SCALE    = 0.5
# How long (seconds) motion must be absent before we declare tracking inactive
QUIET_DEBOUNCE_S = 3.0
# How often (seconds) to emit a "refine: true" request for face detection
REFINE_INTERVAL_S = 4.0
# Maximum frames/sec we feed through (soft cap — don't spin faster than needed)
MAX_FPS         = 10
# How long to wait between reconnect attempts when the stream is unavailable
RECONNECT_WAIT_S = 2.0


def emit(obj):
  print(json.dumps(obj), flush=True)


def iter_mjpeg_frames(url, timeout=20):
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
  """Poll until the stream responds. Returns when ready; never gives up."""
  while True:
    try:
      urllib.request.urlopen(STREAM_URL, timeout=2).close()
      return
    except Exception:
      time.sleep(RECONNECT_WAIT_S)


def run():
  # Graceful shutdown on SIGTERM
  signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

  morph_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))

  # Frame rate limiter
  frame_interval = 1.0 / MAX_FPS

  while True:  # outer reconnect loop
    wait_for_stream()

    ring         = []
    ready_sent   = False
    last_motion_t   = 0.0
    last_refine_t   = 0.0
    motion_active   = False
    last_frame_t    = 0.0

    try:
      for jpeg in iter_mjpeg_frames(STREAM_URL):
        now = time.monotonic()

        # Soft frame-rate cap — drop frames we can't process in time
        if now - last_frame_t < frame_interval:
          continue
        last_frame_t = now

        arr   = np.frombuffer(jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if frame is None:
          continue

        h, w = frame.shape

        if not ready_sent:
          emit({"ready": True})
          ready_sent = True

        # Downsample + blur to reduce noise
        sw = max(1, int(w * DETECT_SCALE))
        sh = max(1, int(h * DETECT_SCALE))
        small = cv2.resize(frame, (sw, sh))
        small = cv2.GaussianBlur(small, (7, 7), 0)

        ring.append(small)
        if len(ring) <= FRAME_GAP:
          continue
        if len(ring) > FRAME_GAP + 1:
          ring.pop(0)

        ref  = ring[0]
        curr = ring[-1]
        diff = cv2.absdiff(curr, ref)
        _, mask = cv2.threshold(diff, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, morph_kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  morph_kernel)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        largest = None
        if contours:
          largest = max(contours, key=cv2.contourArea)
          area    = cv2.contourArea(largest)
        else:
          area = 0

        if area >= MIN_AREA and largest is not None:
          last_motion_t = now
          motion_active = True

          # Centroid of the largest contour in detection-scale pixels
          M   = cv2.moments(largest)
          if M["m00"] > 0:
            cx_px = M["m10"] / M["m00"]
            cy_px = M["m01"] / M["m00"]
          else:
            x, y, bw, bh = cv2.boundingRect(largest)
            cx_px = x + bw / 2
            cy_px = y + bh / 2

          # Normalise to 0–1 (detection scale → original scale doesn't matter since
          # both numerator and denominator are in the same coordinate space)
          cx = cx_px / sw
          cy = cy_px / sh

          # Request a face-detection refinement periodically
          refine = (now - last_refine_t) >= REFINE_INTERVAL_S
          if refine:
            last_refine_t = now

          obj = {"active": True, "cx": round(cx, 4), "cy": round(cy, 4),
                 "area": int(area)}
          if refine:
            obj["refine"] = True
          emit(obj)

        else:
          # Declare inactive only after debounce period
          if motion_active and (now - last_motion_t) >= QUIET_DEBOUNCE_S:
            motion_active = False
          emit({"active": False})

    except (BrokenPipeError, KeyboardInterrupt, SystemExit):
      raise  # propagate fatal signals
    except Exception as e:
      # Stream dropped (camera stopped, network hiccup, etc.) — reconnect
      emit({"error": str(e)})
      time.sleep(RECONNECT_WAIT_S)
      # continue outer loop → wait_for_stream() → reconnect


if __name__ == "__main__":
  try:
    run()
  except (KeyboardInterrupt, SystemExit):
    pass
