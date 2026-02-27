#!/usr/bin/env python3
"""
face_tracker.py — persistent face/cat detector daemon.

Loads YuNet and Haar models once at startup, then loops reading JSON
requests from stdin and writing JSON responses to stdout.  Running as a
long-lived process eliminates Python startup time and model-load overhead
on every scan (~500-900 ms on a Pi).

Request  (one JSON line on stdin):
  {"stream_url": "http://...", "crop_cx": 0.5, "crop_cy": 0.5, "crop_scale": 0.5}
  crop_* fields are optional; omit or set crop_scale >= 1.0 for no crop.

Response (one JSON line on stdout):
  {"found": true,  "cx": <0-1>, "cy": <0-1>,
   "bx": <0-1>, "by": <0-1>, "bw": <0-1>, "bh": <0-1>,
   "label": "face|cat", "score": <0-1>, "w": <px>, "h": <px>}
  {"found": false, "label": "none"}
  {"error": "<message>"}

Startup signal (written to stdout once models are loaded):
  {"ready": true}
"""

import sys
import json
import os
import urllib.request
import numpy as np
import cv2

SCRIPT_DIR       = os.path.dirname(os.path.abspath(__file__))
YUNET_MODEL      = os.path.join(SCRIPT_DIR, "face_detection_yunet_2023mar.onnx")
CASCADE_DIR      = "/usr/share/opencv4/haarcascades"
CAT_CASCADE_PATH = os.path.join(CASCADE_DIR, "haarcascade_frontalcatface_extended.xml")

STREAM_TIMEOUT   = 10   # seconds to wait for a frame
YUNET_THRESHOLD  = 0.5
DETECT_W         = 640  # detection canvas width  (full-frame pass)
DETECT_H         = 480  # detection canvas height (full-frame pass)
DETECT_W_CROP    = 320  # detection canvas width  (cropped pass — smaller region, less work)
DETECT_H_CROP    = 240


# ---------------------------------------------------------------------------
# Load models once at startup
# ---------------------------------------------------------------------------

# Pre-create YuNet for both canvas sizes so there's no re-init cost per scan.
_yunet_full = cv2.FaceDetectorYN.create(
  YUNET_MODEL, "", (DETECT_W, DETECT_H),
  score_threshold=YUNET_THRESHOLD,
  nms_threshold=0.3,
)
_yunet_full.setInputSize((DETECT_W, DETECT_H))

_yunet_crop = cv2.FaceDetectorYN.create(
  YUNET_MODEL, "", (DETECT_W_CROP, DETECT_H_CROP),
  score_threshold=YUNET_THRESHOLD,
  nms_threshold=0.3,
)
_yunet_crop.setInputSize((DETECT_W_CROP, DETECT_H_CROP))

_cat_cascade = cv2.CascadeClassifier(CAT_CASCADE_PATH)

print(json.dumps({"ready": True}), flush=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def grab_frame(url, timeout=STREAM_TIMEOUT):
  """Read one JPEG frame from the MJPEG stream and return it as a numpy BGR image."""
  req = urllib.request.urlopen(url, timeout=timeout)
  buf = b""
  SOI = b"\xff\xd8"
  EOI = b"\xff\xd9"
  while True:
    chunk = req.read(8192)
    if not chunk:
      break
    buf += chunk
    s = buf.find(SOI)
    if s == -1:
      buf = b""
      continue
    e = buf.find(EOI, s + 2)
    if e == -1:
      buf = buf[s:]
      continue
    jpeg = buf[s:e + 2]
    arr = np.frombuffer(jpeg, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is not None:
      return img
    # Corrupt frame — keep reading
    buf = buf[e + 2:]
  return None


def detect_yunet(bgr, cropped=False):
  """Run YuNet on a pre-resized image. Returns list of (cx,cy,bx,by,bw,bh,score)."""
  det = _yunet_crop if cropped else _yunet_full
  fh, fw = bgr.shape[:2]
  n, faces = det.detect(bgr)
  if not n or faces is None:
    return []
  results = []
  for face in faces:
    x, y, w, h, score = float(face[0]), float(face[1]), float(face[2]), float(face[3]), float(face[14])
    x, y = max(0.0, x), max(0.0, y)
    w = min(w, fw - x)
    h = min(h, fh - y)
    results.append(((x + w / 2) / fw, (y + h / 2) / fh,
                    x / fw, y / fh, w / fw, h / fh, score))
  return results


def detect_cat_haar(gray):
  """Run Haar cat cascade. Returns list of (cx,cy,bx,by,bw,bh,score)."""
  fh, fw = gray.shape
  eq = cv2.equalizeHist(gray)
  cats = _cat_cascade.detectMultiScale(eq, scaleFactor=1.1, minNeighbors=5, minSize=(50, 50))
  results = []
  for (x, y, w, h) in (cats if len(cats) > 0 else []):
    results.append(((x + w / 2) / fw, (y + h / 2) / fh,
                    x / fw, y / fh, w / fw, h / fh, 0.7))
  return results


def process_request(req):
  """Handle one scan request dict. Returns a result dict."""
  stream_url  = req.get("stream_url", "http://localhost:3000/camera/stream?src=tracker")
  crop_cx     = req.get("crop_cx")
  crop_cy     = req.get("crop_cy")
  crop_scale  = float(req.get("crop_scale", 1.0))

  bgr = grab_frame(stream_url)
  if bgr is None:
    return {"error": "could not grab a frame from MJPEG stream"}

  fh, fw = bgr.shape[:2]

  # Optional crop
  off_x, off_y = 0, 0
  crop_fw, crop_fh = fw, fh
  is_cropped = False
  if crop_cx is not None and crop_scale < 1.0:
    half_w = int(fw * crop_scale / 2)
    half_h = int(fh * crop_scale / 2)
    cx_px  = int(float(crop_cx) * fw)
    cy_px  = int(float(crop_cy) * fh)
    x1 = max(0, cx_px - half_w)
    y1 = max(0, cy_px - half_h)
    x2 = min(fw, cx_px + half_w)
    y2 = min(fh, cy_px + half_h)
    bgr  = bgr[y1:y2, x1:x2]
    off_x, off_y = x1, y1
    crop_fh, crop_fw = bgr.shape[:2]
    is_cropped = True

  # Downscale — use smaller canvas for cropped pass
  dw, dh = (DETECT_W_CROP, DETECT_H_CROP) if is_cropped else (DETECT_W, DETECT_H)
  small = cv2.resize(bgr, (dw, dh), interpolation=cv2.INTER_LINEAR)

  def to_full(cx, cy, bx, by, bw, bh):
    cx = (off_x + cx * crop_fw) / fw
    cy = (off_y + cy * crop_fh) / fh
    bx = (off_x + bx * crop_fw) / fw
    by = (off_y + by * crop_fh) / fh
    bw = bw * crop_fw / fw
    bh = bh * crop_fh / fh
    return cx, cy, bx, by, bw, bh

  # Human face via YuNet
  faces = detect_yunet(small, cropped=is_cropped)
  if faces:
    cx, cy, bx, by, bw, bh, score = max(faces, key=lambda d: d[6])
    cx, cy, bx, by, bw, bh = to_full(cx, cy, bx, by, bw, bh)
    return {"found": True,
            "cx": round(cx, 4), "cy": round(cy, 4),
            "bx": round(bx, 4), "by": round(by, 4),
            "bw": round(bw, 4), "bh": round(bh, 4),
            "label": "face", "score": round(score, 3),
            "w": fw, "h": fh}

  # Cat face fallback
  cats = detect_cat_haar(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
  if cats:
    cx, cy, bx, by, bw, bh, score = max(cats, key=lambda d: d[6])
    cx, cy, bx, by, bw, bh = to_full(cx, cy, bx, by, bw, bh)
    return {"found": True,
            "cx": round(cx, 4), "cy": round(cy, 4),
            "bx": round(bx, 4), "by": round(by, 4),
            "bw": round(bw, 4), "bh": round(bh, 4),
            "label": "cat", "score": round(score, 3),
            "w": fw, "h": fh}

  return {"found": False, "label": "none"}


# ---------------------------------------------------------------------------
# Main loop — read one JSON request per line, write one JSON response
# ---------------------------------------------------------------------------

for raw_line in sys.stdin:
  line = raw_line.strip()
  if not line:
    continue
  try:
    req = json.loads(line)
    result = process_request(req)
  except Exception as e:
    result = {"error": str(e)}
  print(json.dumps(result), flush=True)
