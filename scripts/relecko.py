#!/usr/bin/env python3
import RPi.GPIO as GPIO
import time
import sys

RELAY_PIN = 17  # BCM (physical pin 11)

mode = sys.argv[1] if len(sys.argv) > 1 else "pulse"   # on/off/pulse
pulse_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 500

GPIO.setmode(GPIO.BCM)
GPIO.setup(RELAY_PIN, GPIO.OUT, initial=GPIO.HIGH)  # HIGH=OFF (active-low)

try:
    if mode == "on":
        GPIO.output(RELAY_PIN, GPIO.LOW)   # ON
        print("Relay ON", flush=True)
        # IMPORTANT: do NOT cleanup here, otherwise it turns off right away

    elif mode == "off":
        GPIO.output(RELAY_PIN, GPIO.HIGH)  # OFF
        print("Relay OFF", flush=True)
        # cleanup not needed

    else:  # pulse
        GPIO.output(RELAY_PIN, GPIO.LOW)
        print(f"Relay ON (pulse {pulse_ms}ms)", flush=True)
        time.sleep(pulse_ms / 1000.0)
        GPIO.output(RELAY_PIN, GPIO.HIGH)
        print("Relay OFF", flush=True)
        GPIO.cleanup()  # OK for pulse

except Exception as e:
    print(f"ERROR: {e}", flush=True)
    raise