#!/usr/bin/env python3
import sys
from Adafruit_PCA9685 import PCA9685

SERVO_CHANNEL = 0
SERVO_MIN = 150
SERVO_MAX = 600
ANGLE_MIN = 0
ANGLE_MAX = 180
I2C_BUS = 1

def angle_to_pulse(angle):
    angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
    return int(SERVO_MIN + (SERVO_MAX - SERVO_MIN) * angle / 180)

def main():
    if len(sys.argv) < 2:
        print("Usage: servo.py <angle|off> [channel]", flush=True)
        print("  angle: 0-180 degrees", flush=True)
        print("  off: disable PWM output (servo relaxes)", flush=True)
        print("  channel: 0-15 (default 0)", flush=True)
        sys.exit(1)
    
    try:
        arg = sys.argv[1].lower()
        channel = int(sys.argv[2]) if len(sys.argv) > 2 else SERVO_CHANNEL
        
        pca = PCA9685(busnum=I2C_BUS)
        pca.set_pwm_freq(50)
        
        if arg == "off":
            pca.set_pwm(channel, 0, 0)
            print(f"Servo channel {channel} PWM disabled", flush=True)
        else:
            angle = float(sys.argv[1])
            angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
            pulse = angle_to_pulse(angle)
            pca.set_pwm(channel, 0, pulse)
            print(f"Servo channel {channel} set to {angle:.1f}° (pulse: {pulse})", flush=True)
        
    except Exception as e:
        print(f"Error: {e}", flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
