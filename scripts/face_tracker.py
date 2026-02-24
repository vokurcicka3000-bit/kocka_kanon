#!/usr/bin/env python3
"""
face_tracker.py — face/cat detector using YuNet DNN + Haar cat cascade fallback.

Grabs one JPEG frame from the live MJPEG stream (no camera stop/restart needed)
and runs YuNet face detection on it.  Cat faces fall back to the Haar cascade
since YuNet only detects humans.

Output (one JSON line):
  {"found": true,  "cx": <0.0-1.0>, "cy": <0.0-1.0>,
   "bx": <0.0-1.0>, "by": <0.0-1.0>, "bw": <0.0-1.0>, "bh": <0.0-1.0>,
   "label": "face|cat", "score": <0.0-1.0>, "w": <img_w>, "h": <img_h>}
  {"found": false, "label": "none"}
  {"error": "<message>"}

Usage:
  python3 face_tracker.py [stream_url]
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

STREAM_URL       = "http://localhost:3000/camera/stream"
STREAM_TIMEOUT   = 10   # seconds to wait for first frame
YUNET_THRESHOLD  = 0.5

args = sys.argv[1:]
if args:
  STREAM_URL = args[0]


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


def detect_yunet(bgr):
  """Run YuNet. Returns list of (cx, cy, bx, by, bw, bh, score)."""
  fh, fw = bgr.shape[:2]
  det = cv2.FaceDetectorYN.create(
    YUNET_MODEL, "", (fw, fh),
    score_threshold=YUNET_THRESHOLD,
    nms_threshold=0.3,
  )
  det.setInputSize((fw, fh))
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
  """Run Haar cat cascade. Returns list of (cx, cy, bx, by, bw, bh, score)."""
  fh, fw = gray.shape
  cascade = cv2.CascadeClassifier(CAT_CASCADE_PATH)
  eq = cv2.equalizeHist(gray)
  cats = cascade.detectMultiScale(eq, scaleFactor=1.1, minNeighbors=5, minSize=(50, 50))
  results = []
  for (x, y, w, h) in (cats if len(cats) > 0 else []):
    results.append(((x + w / 2) / fw, (y + h / 2) / fh,
                    x / fw, y / fh, w / fw, h / fh, 0.7))
  return results


def main():
  try:
    bgr = grab_frame(STREAM_URL)
    if bgr is None:
      print(json.dumps({"error": "could not grab a frame from MJPEG stream"}), flush=True)
      return

    fh, fw = bgr.shape[:2]

    # Human face via YuNet
    faces = detect_yunet(bgr)
    if faces:
      cx, cy, bx, by, bw, bh, score = max(faces, key=lambda d: d[6])
      print(json.dumps({"found": True,
                        "cx": round(cx, 4), "cy": round(cy, 4),
                        "bx": round(bx, 4), "by": round(by, 4),
                        "bw": round(bw, 4), "bh": round(bh, 4),
                        "label": "face", "score": round(score, 3),
                        "w": fw, "h": fh}), flush=True)
      return

    # Cat face fallback
    cats = detect_cat_haar(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
    if cats:
      cx, cy, bx, by, bw, bh, score = max(cats, key=lambda d: d[6])
      print(json.dumps({"found": True,
                        "cx": round(cx, 4), "cy": round(cy, 4),
                        "bx": round(bx, 4), "by": round(by, 4),
                        "bw": round(bw, 4), "bh": round(bh, 4),
                        "label": "cat", "score": round(score, 3),
                        "w": fw, "h": fh}), flush=True)
      return

    print(json.dumps({"found": False, "label": "none"}), flush=True)

  except Exception as e:
    print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
  main()
