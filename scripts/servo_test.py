#!/usr/bin/env python3
# Servo test — sweeps channel 0 (horizontal) and channel 1 (vertical)
# through a few positions slowly, then parks both at center.
# Run: python3 scripts/servo_test.py

import time
import sys
from Adafruit_PCA9685 import PCA9685

I2C_BUS   = 1
PWM_FREQ  = 50
PULSE_MIN = 80
PULSE_MAX = 460
ANGLE_MIN = 0
ANGLE_MAX = 270
CENTER    = 135
STEP_DELAY = 1.0  # seconds between steps

CH_H = 0  # horizontal
CH_V = 1  # vertical

def angle_to_pulse(angle):
  angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
  return int(PULSE_MIN + (PULSE_MAX - PULSE_MIN) * angle / ANGLE_MAX)

def move(pca, channel, angle):
  pulse = angle_to_pulse(angle)
  pca.set_pwm(channel, 0, pulse)
  label = "H" if channel == CH_H else "V"
  print(f"  CH{channel} ({label}): {angle}° (pulse={pulse})", flush=True)

def park(pca):
  move(pca, CH_H, CENTER)
  move(pca, CH_V, CENTER)

try:
  pca = PCA9685(busnum=I2C_BUS)
  pca.set_pwm_freq(PWM_FREQ)
  print("PCA9685 initialized.\n")
except Exception as e:
  print(f"ERROR: could not init PCA9685: {e}")
  sys.exit(1)

try:
  # --- Horizontal sweep ---
  print("=== Horizontal servo (CH0) sweep ===")
  for angle in [0, 45, 90, 135, 180, 225, 270, 135]:
    move(pca, CH_H, angle)
    time.sleep(STEP_DELAY)

  # --- Vertical sweep ---
  print("\n=== Vertical servo (CH1) sweep ===")
  for angle in [0, 45, 90, 135, 180, 225, 270, 135]:
    move(pca, CH_V, angle)
    time.sleep(STEP_DELAY)

  # --- Both together ---
  print("\n=== Both servos together ===")
  steps = [
    (0,   270),
    (90,  180),
    (135, 135),
    (180, 90),
    (270, 0),
    (135, 135),
  ]
  for h, v in steps:
    print(f"  Move to H={h}° V={v}°")
    move(pca, CH_H, h)
    move(pca, CH_V, v)
    time.sleep(STEP_DELAY)

  # --- Park at center ---
  print("\n=== Parking at center (135°) ===")
  park(pca)
  time.sleep(0.5)

  # Cut PWM to avoid jitter at rest
  pca.set_pwm(CH_H, 0, 0)
  pca.set_pwm(CH_V, 0, 0)
  print("Done. PWM off.")

except KeyboardInterrupt:
  print("\nInterrupted — parking servos...")
  park(pca)
  time.sleep(0.5)
  pca.set_pwm(CH_H, 0, 0)
  pca.set_pwm(CH_V, 0, 0)
  print("PWM off.")
