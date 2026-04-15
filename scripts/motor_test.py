#!/usr/bin/env python3
# IBT-2 motor test script
# Wiring: R_EN→GPIO17, L_EN→GPIO27, RPWM→GPIO18, LPWM→GPIO19
#
# Usage:
#   python3 motor_test.py              # runs full forward/stop/backward/stop test
#   python3 motor_test.py forward 50   # forward at 50% speed for default duration
#   python3 motor_test.py backward 75  # backward at 75% speed for default duration
#   python3 motor_test.py stop         # stop motor (disable both sides)

import RPi.GPIO as GPIO
import time
import sys

# -------------------- Pin config --------------------
R_EN  = 17   # Right side enable
L_EN  = 27   # Left side enable
RPWM  = 18   # Right PWM (forward drive)
LPWM  = 19   # Left PWM  (backward drive)

PWM_FREQ = 1000  # Hz

# -------------------- Setup --------------------
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

GPIO.setup(R_EN,  GPIO.OUT, initial=GPIO.LOW)
GPIO.setup(L_EN,  GPIO.OUT, initial=GPIO.LOW)
GPIO.setup(RPWM,  GPIO.OUT)
GPIO.setup(LPWM,  GPIO.OUT)

rpwm = GPIO.PWM(RPWM, PWM_FREQ)
lpwm = GPIO.PWM(LPWM, PWM_FREQ)
rpwm.start(0)
lpwm.start(0)

# -------------------- Motor control --------------------
def forward(speed=60):
  """Drive motor forward at speed% (0-100)."""
  speed = max(0, min(100, speed))
  lpwm.ChangeDutyCycle(0)
  rpwm.ChangeDutyCycle(speed)
  GPIO.output(R_EN, GPIO.HIGH)
  GPIO.output(L_EN, GPIO.HIGH)
  print(f"FORWARD  speed={speed}%", flush=True)

def backward(speed=60):
  """Drive motor backward at speed% (0-100)."""
  speed = max(0, min(100, speed))
  rpwm.ChangeDutyCycle(0)
  lpwm.ChangeDutyCycle(speed)
  GPIO.output(R_EN, GPIO.HIGH)
  GPIO.output(L_EN, GPIO.HIGH)
  print(f"BACKWARD speed={speed}%", flush=True)

def stop():
  """Stop motor (coast - disable enables)."""
  rpwm.ChangeDutyCycle(0)
  lpwm.ChangeDutyCycle(0)
  GPIO.output(R_EN, GPIO.LOW)
  GPIO.output(L_EN, GPIO.LOW)
  print("STOP", flush=True)

def cleanup():
  global rpwm, lpwm
  rpwm.stop()
  lpwm.stop()
  # Delete PWM objects before GPIO.cleanup() to prevent __del__ from firing
  # on an already-closed chip handle (RPi.GPIO/lgpio bug).
  del rpwm, lpwm
  GPIO.cleanup()

# -------------------- Main --------------------
def run_full_test(duration=2.0, speed=60):
  """Forward → stop → backward → stop sequence."""
  print(f"--- Motor test start (speed={speed}%, duration={duration}s each) ---", flush=True)

  forward(speed)
  time.sleep(duration)

  stop()
  time.sleep(0.5)

  backward(speed)
  time.sleep(duration)

  stop()
  print("--- Motor test complete ---", flush=True)

try:
  cmd  = sys.argv[1].lower() if len(sys.argv) > 1 else "test"
  spd  = int(sys.argv[2])    if len(sys.argv) > 2 else 60
  dur  = float(sys.argv[3])  if len(sys.argv) > 3 else 2.0

  if cmd == "forward":
    forward(spd)
    time.sleep(dur)
    stop()
  elif cmd == "backward":
    backward(spd)
    time.sleep(dur)
    stop()
  elif cmd == "stop":
    stop()
  else:  # "test" or anything else → full sequence
    run_full_test(duration=dur, speed=spd)

except Exception as e:
  print(f"ERROR: {e}", flush=True)
  raise

finally:
  cleanup()
