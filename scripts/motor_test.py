#!/usr/bin/env python3
# Dual IBT-2 motor test script (left + right drive, tank steering)
#
# Wiring — LEFT motor IBT-2:
#   R_EN  → GPIO 17  (physical pin 11)
#   L_EN  → GPIO 27  (physical pin 13)
#   RPWM  → GPIO 18  (physical pin 12)
#   LPWM  → GPIO 19  (physical pin 35)
#
# Wiring — RIGHT motor IBT-2:
#   R_EN  → GPIO  5  (physical pin 29)
#   L_EN  → GPIO  6  (physical pin 31)
#   RPWM  → GPIO 13  (physical pin 33)
#   LPWM  → GPIO 26  (physical pin 37)
#
# Wiring — LEFT motor encoder (quadrature):
#   VCC   → 3.3V     (physical pin  1)
#   GND   → GND      (physical pin  6)
#   A     → GPIO 20  (physical pin 38)
#   B     → GPIO 21  (physical pin 40)
#
# Wiring — RIGHT motor encoder (quadrature):
#   VCC   → 3.3V     (physical pin  1)
#   GND   → GND      (physical pin  9)
#   A     → GPIO 23  (physical pin 16)
#   B     → GPIO 24  (physical pin 18)
#
# Usage:
#   python3 motor_test.py                          # full test both motors
#   python3 motor_test.py forward  50              # both motors forward  50% for 2s
#   python3 motor_test.py backward 75              # both motors backward 75% for 2s
#   python3 motor_test.py forward  60 2.0 left     # left  motor only
#   python3 motor_test.py forward  60 2.0 right    # right motor only
#   python3 motor_test.py stop                     # stop both motors

import RPi.GPIO as GPIO
import time
import sys

# -------------------- Pin config — LEFT IBT-2 --------------------
L_R_EN = 17   # left motor right-side enable
L_L_EN = 27   # left motor left-side  enable
L_RPWM = 18   # left motor forward  PWM
L_LPWM = 19   # left motor backward PWM

# -------------------- Pin config — RIGHT IBT-2 --------------------
R_R_EN =  5   # right motor right-side enable
R_L_EN =  6   # right motor left-side  enable
R_RPWM = 13   # right motor forward  PWM
R_LPWM = 26   # right motor backward PWM

# -------------------- Pin config — encoders --------------------
ENC_L_A = 20  # left  encoder channel A
ENC_L_B = 21  # left  encoder channel B
ENC_R_A = 23  # right encoder channel A
ENC_R_B = 24  # right encoder channel B

PWM_FREQ = 1000  # Hz

# -------------------- Encoder state --------------------
enc_counts = {"left": 0, "right": 0}

def _enc_cb(motor):
  """Return a callback that increments the tick counter for motor."""
  def cb(_channel):
    enc_counts[motor] += 1
  return cb

# -------------------- Setup --------------------
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

# Motor output pins
for pin in (L_R_EN, L_L_EN, L_RPWM, L_LPWM,
            R_R_EN, R_L_EN, R_RPWM, R_LPWM):
  GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)

# Encoder input pins — only set up if encoders are connected
ENCODERS_ENABLED = False
if ENCODERS_ENABLED:
  for pin in (ENC_L_A, ENC_L_B, ENC_R_A, ENC_R_B):
    GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
  GPIO.add_event_detect(ENC_L_A, GPIO.RISING, callback=_enc_cb("left"))
  GPIO.add_event_detect(ENC_R_A, GPIO.RISING, callback=_enc_cb("right"))

# PWM objects
l_rpwm = GPIO.PWM(L_RPWM, PWM_FREQ)
l_lpwm = GPIO.PWM(L_LPWM, PWM_FREQ)
r_rpwm = GPIO.PWM(R_RPWM, PWM_FREQ)
r_lpwm = GPIO.PWM(R_LPWM, PWM_FREQ)

for pwm in (l_rpwm, l_lpwm, r_rpwm, r_lpwm):
  pwm.start(0)

# -------------------- Motor control --------------------
def _motor_pins(motor):
  """Return (r_en, l_en, rpwm_obj, lpwm_obj) for the given motor side."""
  if motor == "left":
    return L_R_EN, L_L_EN, l_rpwm, l_lpwm
  if motor == "right":
    return R_R_EN, R_L_EN, r_rpwm, r_lpwm
  raise ValueError(f"Unknown motor: {motor!r}")

def _reset_counts(motor="both"):
  if motor in ("left",  "both"): enc_counts["left"]  = 0
  if motor in ("right", "both"): enc_counts["right"] = 0

def get_counts():
  """Return current encoder tick counts as a dict."""
  return dict(enc_counts)

def forward(speed=60, motor="both"):
  """Drive motor(s) forward at speed% (0-100)."""
  speed = max(0, min(100, speed))
  sides = ["left", "right"] if motor == "both" else [motor]
  for side in sides:
    r_en, l_en, rpwm_obj, lpwm_obj = _motor_pins(side)
    lpwm_obj.ChangeDutyCycle(0)
    rpwm_obj.ChangeDutyCycle(speed)
    GPIO.output(r_en, GPIO.HIGH)
    GPIO.output(l_en, GPIO.HIGH)
  print(f"FORWARD  motor={motor} speed={speed}%", flush=True)

def backward(speed=60, motor="both"):
  """Drive motor(s) backward at speed% (0-100)."""
  speed = max(0, min(100, speed))
  sides = ["left", "right"] if motor == "both" else [motor]
  for side in sides:
    r_en, l_en, rpwm_obj, lpwm_obj = _motor_pins(side)
    rpwm_obj.ChangeDutyCycle(0)
    lpwm_obj.ChangeDutyCycle(speed)
    GPIO.output(r_en, GPIO.HIGH)
    GPIO.output(l_en, GPIO.HIGH)
  print(f"BACKWARD motor={motor} speed={speed}%", flush=True)

def stop(motor="both"):
  """Stop motor(s) (coast — disable enables)."""
  sides = ["left", "right"] if motor == "both" else [motor]
  for side in sides:
    r_en, l_en, rpwm_obj, lpwm_obj = _motor_pins(side)
    rpwm_obj.ChangeDutyCycle(0)
    lpwm_obj.ChangeDutyCycle(0)
    GPIO.output(r_en, GPIO.LOW)
    GPIO.output(l_en, GPIO.LOW)
  print(f"STOP     motor={motor}", flush=True)

def cleanup():
  global l_rpwm, l_lpwm, r_rpwm, r_lpwm
  for pwm in (l_rpwm, l_lpwm, r_rpwm, r_lpwm):
    pwm.stop()
  # Delete PWM objects before GPIO.cleanup() to prevent __del__ from firing
  # on an already-closed chip handle (RPi.GPIO/lgpio bug).
  del l_rpwm, l_lpwm, r_rpwm, r_lpwm
  GPIO.cleanup()

# -------------------- Main --------------------
def run_full_test(duration=2.0, speed=60, motor="both"):
  """Forward → stop → backward → stop sequence, then print encoder counts."""
  print(f"--- Motor test start (motor={motor}, speed={speed}%, duration={duration}s each) ---",
        flush=True)

  _reset_counts(motor)
  forward(speed, motor)
  time.sleep(duration)
  stop(motor)
  counts_fwd = get_counts()
  print(f"    encoder counts after forward:  L={counts_fwd['left']}  R={counts_fwd['right']}",
        flush=True)

  time.sleep(0.5)

  _reset_counts(motor)
  backward(speed, motor)
  time.sleep(duration)
  stop(motor)
  counts_bwd = get_counts()
  print(f"    encoder counts after backward: L={counts_bwd['left']}  R={counts_bwd['right']}",
        flush=True)

  print("--- Motor test complete ---", flush=True)

try:
  cmd   = sys.argv[1].lower() if len(sys.argv) > 1 else "test"
  spd   = int(sys.argv[2])    if len(sys.argv) > 2 else 60
  dur   = float(sys.argv[3])  if len(sys.argv) > 3 else 2.0
  motor = sys.argv[4].lower() if len(sys.argv) > 4 else "both"

  if motor not in ("left", "right", "both"):
    print(f"ERROR: motor must be left|right|both, got {motor!r}", flush=True)
    sys.exit(1)

  if cmd == "forward":
    _reset_counts(motor)
    forward(spd, motor)
    time.sleep(dur)
    stop(motor)
    c = get_counts()
    print(f"encoder counts: L={c['left']}  R={c['right']}", flush=True)

  elif cmd == "backward":
    _reset_counts(motor)
    backward(spd, motor)
    time.sleep(dur)
    stop(motor)
    c = get_counts()
    print(f"encoder counts: L={c['left']}  R={c['right']}", flush=True)

  elif cmd == "stop":
    stop(motor)

  else:  # "test" or anything else → full sequence
    run_full_test(duration=dur, speed=spd, motor=motor)

except Exception as e:
  print(f"ERROR: {e}", flush=True)
  raise

finally:
  cleanup()
