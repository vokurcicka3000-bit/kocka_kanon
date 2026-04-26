#!/usr/bin/env python3
# Encoder test — prints tick count and direction for both motors.
# Spin the wheels by hand and watch the output.
# Press Ctrl+C to exit.
#
# Wiring (matches motor_test.py):
#   Left  encoder A → GPIO 20  (physical pin 38)
#   Left  encoder B → GPIO 21  (physical pin 40)
#   Right encoder A → GPIO 23  (physical pin 16)
#   Right encoder B → GPIO 24  (physical pin 18)

import RPi.GPIO as GPIO
import time

# -------------------- Pin config --------------------
ENC_L_A = 20
ENC_L_B = 21
ENC_R_A = 23
ENC_R_B = 24

# -------------------- State --------------------
counts = {"left": 0, "right": 0}
dirs   = {"left": "?", "right": "?"}

# -------------------- Callbacks --------------------
def make_cb(motor, pin_a, pin_b):
  def cb(channel):
    a = GPIO.input(pin_a)
    b = GPIO.input(pin_b)
    if a == b:
      counts[motor] += 1
      dirs[motor] = "CW"
    else:
      counts[motor] -= 1
      dirs[motor] = "CCW"
  return cb

# -------------------- Setup --------------------
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

for pin in (ENC_L_A, ENC_L_B, ENC_R_A, ENC_R_B):
  GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)

GPIO.add_event_detect(ENC_L_A, GPIO.BOTH, callback=make_cb("left",  ENC_L_A, ENC_L_B), bouncetime=1)
GPIO.add_event_detect(ENC_R_A, GPIO.BOTH, callback=make_cb("right", ENC_R_A, ENC_R_B), bouncetime=1)

print("Encoder test running — spin the wheels by hand. Ctrl+C to stop.\n")

# -------------------- Main loop --------------------
try:
  while True:
    print(f"  LEFT:  {counts['left']:6d} ticks  {dirs['left']:3s}    |    RIGHT: {counts['right']:6d} ticks  {dirs['right']:3s}", end="\r", flush=True)
    time.sleep(0.1)
except KeyboardInterrupt:
  print("\nStopped.")
finally:
  GPIO.cleanup()
