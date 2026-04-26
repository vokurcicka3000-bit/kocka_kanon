#!/usr/bin/env python3
# Raw pin state reader — prints current HIGH/LOW on all 4 encoder pins.
# Use this to verify signal is reaching the Pi from the level shifter.
# Press Ctrl+C to exit.

import RPi.GPIO as GPIO
import time

ENC_L_A = 20
ENC_L_B = 21
ENC_R_A = 23
ENC_R_B = 24

GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

for pin in (ENC_L_A, ENC_L_B, ENC_R_A, ENC_R_B):
  GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)

print("Raw pin states (spin wheels by hand and watch for changes). Ctrl+C to stop.\n")

try:
  while True:
    la = GPIO.input(ENC_L_A)
    lb = GPIO.input(ENC_L_B)
    ra = GPIO.input(ENC_R_A)
    rb = GPIO.input(ENC_R_B)
    print(f"  L_A (GPIO20): {'HIGH' if la else 'LOW '}   L_B (GPIO21): {'HIGH' if lb else 'LOW '}   |   R_A (GPIO23): {'HIGH' if ra else 'LOW '}   R_B (GPIO24): {'HIGH' if rb else 'LOW '}", end="\r", flush=True)
    time.sleep(0.05)
except KeyboardInterrupt:
  print("\nDone.")
finally:
  GPIO.cleanup()
