#!/usr/bin/env python3
"""
tracker.py — face-tracking servo controller.

Reads the MJPEG stream already served by Node (so it never opens the camera
directly and never conflicts with rpicam-vid).

Detects faces with OpenCV Haar cascade, finds the largest one, and outputs
a proportional MOVE command so Node can steer the horizontal servo to keep
the face centred.

Output protocol (stdout, line-buffered):
  READY               emitted after the first frame is decoded
  MOVE <delta>        signed int degrees  (+ = pan left, - = pan right)
  LOST                no face found this frame

Usage:
  python3 tracker.py [stream_url]
"""

import sys
import time
import urllib.request
import numpy as np
import cv2

STREAM_URL  = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000/camera/stream"
CASCADE_XML = "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"

# ---- Tuning ----
# Proportional gain: servo degrees per pixel of horizontal error.
KP               = 0.06

# Dead zone: fraction of frame width.  Face must be this far off-centre before we act.
DEAD_ZONE_FRAC   = 0.08

# Only accept face detections with a bounding-box width >= this fraction of frame width.
# Filters out tiny false positives far in the background.
MIN_FACE_FRAC    = 0.05

# After a MOVE, wait this many seconds before issuing the next one.
# Prevents servo oscillation while the camera is still moving.
COOLDOWN_S       = 0.40

# Scale factor for detection resize (smaller = faster but less accurate for small faces)
DETECT_SCALE     = 0.5


def iter_mjpeg_frames(url, timeout=15):
    """Yield raw JPEG bytes from a multipart/x-mixed-replace MJPEG stream."""
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


def main():
    face_cascade = cv2.CascadeClassifier(CASCADE_XML)
    if face_cascade.empty():
        print(f"ERROR failed to load cascade from {CASCADE_XML}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Wait for stream
    for _ in range(20):
        try:
            urllib.request.urlopen(STREAM_URL, timeout=2).close()
            break
        except Exception:
            time.sleep(0.5)
    else:
        print("ERROR could not connect to stream", file=sys.stderr, flush=True)
        sys.exit(1)

    ready_sent   = False
    frame_cx     = None
    dead_zone_px = None
    min_face_px  = None
    last_move_t  = 0.0

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
            print("READY", flush=True)
            ready_sent = True

        # Rate limit — don't even run detection if we're still in cooldown
        now = time.monotonic()
        if now - last_move_t < COOLDOWN_S:
            continue

        # Downscale for faster detection, then equalise histogram for better contrast
        small  = cv2.resize(frame, (int(w * DETECT_SCALE), int(h * DETECT_SCALE)))
        small  = cv2.equalizeHist(small)

        faces = face_cascade.detectMultiScale(
            small,
            scaleFactor  = 1.1,
            minNeighbors = 5,
            minSize      = (min_face_px, min_face_px),
        )

        if not len(faces):
            print("LOST", flush=True)
            continue

        # Pick the largest face (most likely to be the main subject)
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])

        # Map centroid back to full-res coordinates
        cx = int((x + fw / 2) / DETECT_SCALE)

        error_px = cx - frame_cx  # type: ignore[operator]
        if abs(error_px) < dead_zone_px:
            continue  # face is centred enough

        delta = -round(error_px * KP)
        if delta != 0:
            print(f"MOVE {delta}", flush=True)
            last_move_t = now


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"ERROR {e}", file=sys.stderr, flush=True)
        sys.exit(1)
