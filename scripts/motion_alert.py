#!/usr/bin/env python3
"""
motion_alert.py — frame-differencing motion detector with Telegram notifications.

Reads the MJPEG stream served by Node, detects motion using frame differencing,
and sends a Telegram message (+ optional photo snapshot) when motion is detected.

Configuration is read from environment variables (set in /tmp/motion_alert_cfg or
passed directly):
  TELEGRAM_TOKEN   — bot token from @BotFather
  TELEGRAM_CHAT_ID — your chat ID (send /start to your bot, then check getUpdates)

Output protocol (stdout, consumed by index.js):
  READY            — first frame decoded, detector running
  MOTION           — motion detected this cycle
  QUIET            — no motion this cycle
  ERROR <msg>      — fatal error

Usage:
  python3 motion_alert.py [stream_url]
"""

import sys
import os
import time
import json
import urllib.request
import urllib.parse
import urllib.error
import io
import numpy as np
import cv2

# ---- Config from env ----
TELEGRAM_TOKEN   = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
STREAM_URL       = "http://localhost:3000/camera/stream"

args = sys.argv[1:]
while args:
    a = args.pop(0)
    if not a.startswith("--"):
        STREAM_URL = a

# ---- Tuning ----
# Pixel intensity difference threshold (0-255).
DIFF_THRESHOLD  = 25
# Minimum contiguous changed area in pixels to count as motion.
MIN_AREA        = 4000
# Compare current frame to a reference taken this many frames ago.
FRAME_GAP       = 3
# After motion is detected, wait this long before sending another alert (seconds).
# Prevents notification spam when something moves continuously.
COOLDOWN_S      = 10
# After motion alert, freeze the reference frame for this many frames so
# the camera pan itself isn't detected as further motion.
FREEZE_FRAMES   = 8
# How long to wait (seconds) after motion stops before declaring it quiet again.
QUIET_DEBOUNCE_S = 5
# Resize factor applied before detection — smaller = faster but less accurate.
DETECT_SCALE    = 0.5


# ---- Telegram helpers ----
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"

def tg_send_message(text):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR Telegram not configured.", file=sys.stderr, flush=True)
        return False
    try:
        data = urllib.parse.urlencode({
            "chat_id": TELEGRAM_CHAT_ID,
            "text":    text,
        }).encode()
        req = urllib.request.Request(
            f"{TELEGRAM_API}/sendMessage",
            data=data,
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=10).read()
        print(f"Telegram sendMessage OK: {resp[:120]}", file=sys.stderr, flush=True)
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"ERROR Telegram sendMessage HTTP {e.code}: {body}", file=sys.stderr, flush=True)
        return False
    except Exception as e:
        print(f"ERROR Telegram sendMessage failed: {e}", file=sys.stderr, flush=True)
        return False

def tg_send_photo(jpeg_bytes, caption=""):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR Telegram not configured.", file=sys.stderr, flush=True)
        return
    try:
        # Build multipart/form-data manually — no extra packages needed
        boundary = b"PiBoundary12345"
        body = b""

        def field(name, value):
            return (
                b"--" + boundary + b"\r\n"
                + b'Content-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n'
                + value.encode() + b"\r\n"
            )

        body += field("chat_id", str(TELEGRAM_CHAT_ID))
        if caption:
            body += field("caption", caption)
        body += (
            b"--" + boundary + b"\r\n"
            + b'Content-Disposition: form-data; name="photo"; filename="motion.jpg"\r\n'
            + b"Content-Type: image/jpeg\r\n\r\n"
            + jpeg_bytes + b"\r\n"
        )
        body += b"--" + boundary + b"--\r\n"

        req = urllib.request.Request(
            f"{TELEGRAM_API}/sendPhoto",
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary.decode()}"},
        )
        resp = urllib.request.urlopen(req, timeout=15).read()
        print(f"Telegram sendPhoto OK: {resp[:120]}", file=sys.stderr, flush=True)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"ERROR Telegram sendPhoto HTTP {e.code}: {body}", file=sys.stderr, flush=True)
        # Fall back to plain text message if photo upload fails
        tg_send_message(f"Motion detected! (photo upload failed: {e.code})")
    except Exception as e:
        print(f"ERROR Telegram sendPhoto failed: {e}", file=sys.stderr, flush=True)
        tg_send_message("Motion detected! (photo upload failed)")


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


# ---- Main loop ----
def run():
    wait_for_stream()

    # Send a test message immediately on startup so the user knows config is working
    if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
        print("Testing Telegram config...", file=sys.stderr, flush=True)
        ok = tg_send_message("Motion alert is now active on your Pi camera.")
        if not ok:
            print("ERROR Telegram test message failed — check token and chat ID.", file=sys.stderr, flush=True)
    else:
        print("ERROR TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set.", file=sys.stderr, flush=True)

    morph_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    ring         = []    # ring buffer of recent frames
    freeze       = 0     # frames to skip reference update after a detection

    ready_sent   = False
    last_alert_t = 0.0
    last_motion_t = 0.0  # last time motion was seen (for quiet debounce)
    motion_active = False

    for jpeg in iter_mjpeg_frames(STREAM_URL):
        arr   = np.frombuffer(jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if frame is None:
            continue

        h, w = frame.shape

        if not ready_sent:
            print("READY", flush=True)
            ready_sent = True

        # Downsample + blur to reduce noise before differencing
        small = cv2.resize(frame, (int(w * DETECT_SCALE), int(h * DETECT_SCALE)))
        small = cv2.GaussianBlur(small, (7, 7), 0)

        if freeze > 0:
            freeze -= 1
            ring.clear()
            continue

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

        now = time.monotonic()
        detected = False
        if contours:
            largest = max(contours, key=cv2.contourArea)
            if cv2.contourArea(largest) >= MIN_AREA:
                detected = True

        if detected:
            last_motion_t = now
            if not motion_active:
                motion_active = True
                print("MOTION", flush=True)

            # Send Telegram alert (rate-limited by COOLDOWN_S)
            if now - last_alert_t >= COOLDOWN_S:
                last_alert_t = now
                freeze = FREEZE_FRAMES
                ring.clear()

                # Send snapshot + message
                if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
                    tg_send_photo(jpeg, caption="Motion detected!")
                else:
                    # Config missing — warn via stderr so index.js logs it
                    print(
                        "ERROR Telegram not configured. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID.",
                        file=sys.stderr, flush=True,
                    )
        else:
            # Declare quiet only after QUIET_DEBOUNCE_S without any motion
            if motion_active and (now - last_motion_t) >= QUIET_DEBOUNCE_S:
                motion_active = False
            print("QUIET", flush=True)


if __name__ == "__main__":
    run()
