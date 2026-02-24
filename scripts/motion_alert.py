#!/usr/bin/env python3
"""
motion_alert.py — frame-differencing motion detector with Telegram notifications.

Reads the MJPEG stream served by Node, detects motion using frame differencing,
and sends a Telegram message (+ optional photo snapshot) when motion is detected.
While motion is active it captures one frame per second; when motion ends it
assembles those frames into an animated GIF and sends it to the Telegram channel.

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
import signal
import threading
import urllib.request
import urllib.parse
import urllib.error
import numpy as np
import cv2

# ---- Config from env ----
TELEGRAM_TOKEN   = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
STREAM_URL       = "http://localhost:3000/camera/stream?src=tracker"

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
COOLDOWN_S      = 120
# After motion alert, freeze the reference frame for this many frames so
# the camera pan itself isn't detected as further motion.
FREEZE_FRAMES   = 8
# How long to wait (seconds) after motion stops before declaring it quiet again.
QUIET_DEBOUNCE_S = 5
# Resize factor applied before detection — smaller = faster but less accurate.
DETECT_SCALE    = 0.5
# Capture one frame per this many seconds during motion.
GIF_FRAME_INTERVAL_S = 0.5
# Maximum frames to collect (caps video length — 60 frames @ 2fps = 30 s).
GIF_MAX_FRAMES  = 60
# Directory where finished MP4 clips are kept.
CLIPS_DIR       = "/tmp/motion_clips"
# How many clips to keep (oldest are deleted).
MAX_CLIPS       = 5

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
        tg_send_message(f"Motion detected! (photo upload failed: {e.code})")
    except Exception as e:
        print(f"ERROR Telegram sendPhoto failed: {e}", file=sys.stderr, flush=True)
        tg_send_message("Motion detected! (photo upload failed)")

def tg_send_video(mp4_bytes, caption=""):
    """Send an MP4 as a Telegram video — always plays inline as a looping clip."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR Telegram not configured.", file=sys.stderr, flush=True)
        return
    try:
        boundary = b"PiBoundaryMp412345"
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
        # supports_streaming lets Telegram start playing before fully downloaded
        body += field("supports_streaming", "true")
        body += (
            b"--" + boundary + b"\r\n"
            + b'Content-Disposition: form-data; name="video"; filename="motion.mp4"\r\n'
            + b"Content-Type: video/mp4\r\n\r\n"
            + mp4_bytes + b"\r\n"
        )
        body += b"--" + boundary + b"--\r\n"

        req = urllib.request.Request(
            f"{TELEGRAM_API}/sendVideo",
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary.decode()}"},
        )
        resp = urllib.request.urlopen(req, timeout=60).read()
        print(f"Telegram sendVideo OK: {resp[:120]}", file=sys.stderr, flush=True)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"ERROR Telegram sendVideo HTTP {e.code}: {body}", file=sys.stderr, flush=True)
        tg_send_message(f"Motion ended — video upload failed ({e.code})")
    except Exception as e:
        print(f"ERROR Telegram sendVideo failed: {e}", file=sys.stderr, flush=True)
        tg_send_message("Motion ended — video upload failed")


def prune_clips():
    """Delete oldest clips in CLIPS_DIR, keeping only MAX_CLIPS files."""
    try:
        files = sorted(
            (f for f in os.scandir(CLIPS_DIR) if f.name.endswith(".mp4")),
            key=lambda e: e.stat().st_mtime,
        )
        for entry in files[:-MAX_CLIPS] if len(files) > MAX_CLIPS else []:
            os.remove(entry.path)
            print(f"Pruned old clip: {entry.name}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"ERROR prune_clips: {e}", file=sys.stderr, flush=True)


def build_mp4(jpeg_list, fps=2):
    """Encode a list of JPEG bytes into an H.264 MP4.
    Saves the file to CLIPS_DIR with a timestamp name and returns its bytes.
    Returns None on failure."""
    if not jpeg_list:
        return None

    import tempfile
    import subprocess
    import shutil

    os.makedirs(CLIPS_DIR, exist_ok=True)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    clip_path = os.path.join(CLIPS_DIR, f"motion_{timestamp}.mp4")

    tmp_dir = tempfile.mkdtemp(prefix="motion_mp4_")
    try:
        # Write each JPEG to a numbered file
        for i, jpeg in enumerate(jpeg_list):
            with open(os.path.join(tmp_dir, f"frame{i:04d}.jpg"), "wb") as f:
                f.write(jpeg)

        # H.264 encode via ffmpeg
        # -framerate: input rate (matches our capture rate)
        # -vf fps: output rate (same — no duplication)
        # libx264 + yuv420p: maximum compatibility with Telegram and all players
        # -movflags +faststart: moov atom at front so streaming starts immediately
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", str(fps),
                "-i", os.path.join(tmp_dir, "frame%04d.jpg"),
                "-vf", f"fps={fps}",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                clip_path,
            ],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            print(f"ERROR ffmpeg failed: {result.stderr.decode(errors='replace')[-300:]}",
                  file=sys.stderr, flush=True)
            return None

        with open(clip_path, "rb") as f:
            data = f.read()

        prune_clips()
        return data
    except Exception as e:
        print(f"ERROR build_mp4: {e}", file=sys.stderr, flush=True)
        return None
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def encode_and_send(frames_snapshot):
    """Run in a non-daemon thread: encode frames to MP4 and send via Telegram.
    Safe to call after the main loop has exited — the thread will keep the
    process alive until it finishes."""
    n = len(frames_snapshot)
    print(f"Building MP4 from {n} frame(s)…", file=sys.stderr, flush=True)
    mp4_bytes = build_mp4(frames_snapshot, fps=2)
    if mp4_bytes:
        caption = f"Motion ended — {n} frame{'s' if n != 1 else ''} captured"
        tg_send_video(mp4_bytes, caption=caption)
    else:
        tg_send_message("Motion ended (video build failed)")


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

    ready_sent    = False
    last_alert_t  = 0.0
    last_motion_t = 0.0
    motion_active = False

    # GIF capture state
    gif_frames        = []        # list of JPEG bytes collected during motion
    last_gif_frame_t  = 0.0       # wall time of last captured GIF frame

    # Track encode threads so we can join them on exit
    encode_threads = []

    # SIGTERM handler: set a flag so the for-loop exits cleanly on the next frame
    stop_requested = threading.Event()

    def _on_sigterm(signum, frame):
        stop_requested.set()

    signal.signal(signal.SIGTERM, _on_sigterm)

    def _start_encode(frames_snapshot):
        """Spawn a non-daemon thread to encode + send. Keeps process alive."""
        t = threading.Thread(
            target=encode_and_send,
            args=(frames_snapshot,),
            daemon=False,
        )
        t.start()
        encode_threads.append(t)

    try:
        for jpeg in iter_mjpeg_frames(STREAM_URL):
            if stop_requested.is_set():
                break

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
                    # ---- Motion just started ----
                    motion_active = True
                    gif_frames = []
                    last_gif_frame_t = 0.0
                    print("MOTION", flush=True)

                    # Send immediate snapshot alert (rate-limited)
                    if now - last_alert_t >= COOLDOWN_S:
                        last_alert_t = now
                        freeze = FREEZE_FRAMES
                        ring.clear()
                        if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
                            tg_send_photo(jpeg, caption="Motion detected!")
                        else:
                            print(
                                "ERROR Telegram not configured. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID.",
                                file=sys.stderr, flush=True,
                            )

                # ---- Collect GIF frames once per second while motion is active ----
                if (len(gif_frames) < GIF_MAX_FRAMES and
                        now - last_gif_frame_t >= GIF_FRAME_INTERVAL_S):
                    gif_frames.append(jpeg)
                    last_gif_frame_t = now

            else:
                # ---- Check quiet debounce ----
                if motion_active and (now - last_motion_t) >= QUIET_DEBOUNCE_S:
                    motion_active = False
                    print("QUIET", flush=True)

                    # ---- Motion ended: build and send video in background thread ----
                    if gif_frames and TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
                        print("ENCODING", flush=True)
                        _start_encode(gif_frames)
                        gif_frames = []
                    else:
                        gif_frames = []

                if not motion_active:
                    print("QUIET", flush=True)

    finally:
        # If SIGTERM arrived while motion was still active, kick off encoding now
        # so the video is not lost.
        if motion_active and gif_frames and TELEGRAM_TOKEN and TELEGRAM_CHAT_ID:
            print(
                f"SIGTERM during motion — encoding {len(gif_frames)} frame(s) before exit.",
                file=sys.stderr, flush=True,
            )
            print("ENCODING", flush=True)
            _start_encode(gif_frames)
            gif_frames = []

        # Wait for all encode threads to finish before the process exits.
        for t in encode_threads:
            t.join()


if __name__ == "__main__":
    run()
