#!/usr/bin/env python3
# Persistent servo daemon - reads commands from stdin, keeps PCA9685 alive.
# Protocol: one command per line
#   SET <channel> <angle>   - move servo on channel to angle (0-270)
#   OFF <channel>           - disable PWM on channel (servo relaxes)
#   OFF ALL                 - disable PWM on all channels
#   QUIT                    - exit
import sys
from Adafruit_PCA9685 import PCA9685

SERVO_PULSE_MIN = 80    # pulse at 0° (mechanical minimum)
SERVO_PULSE_MAX = 460   # pulse at max° (mechanical maximum)
ANGLE_MIN = 0
ANGLE_MAX = 270
I2C_BUS = 1

def angle_to_pulse(angle):
    angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
    return int(SERVO_PULSE_MIN + (SERVO_PULSE_MAX - SERVO_PULSE_MIN) * angle / ANGLE_MAX)

def main():
    try:
        pca = PCA9685(busnum=I2C_BUS)
        pca.set_pwm_freq(50)
        print("READY", flush=True)
    except Exception as e:
        print(f"ERROR init: {e}", flush=True)
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        # Commands may be prefixed with SEQ:<id> for response correlation
        seq = ""
        if line.startswith("SEQ:"):
            parts_full = line.split(" ", 2)
            seq = parts_full[0] + " "   # e.g. "SEQ:5 "
            line = " ".join(parts_full[1:])

        parts = line.split()
        cmd = parts[0].upper() if parts else ""

        try:
            if cmd == "SET" and len(parts) == 3:
                channel = int(parts[1])
                angle = float(parts[2])
                angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
                pulse = angle_to_pulse(angle)
                pca.set_pwm(channel, 0, pulse)
                print(f"{seq}OK channel={channel} angle={angle:.1f} pulse={pulse}", flush=True)

            elif cmd == "OFF" and len(parts) == 2:
                if parts[1].upper() == "ALL":
                    for ch in range(16):
                        pca.set_pwm(ch, 0, 0)
                    print(f"{seq}OK all channels off", flush=True)
                else:
                    channel = int(parts[1])
                    pca.set_pwm(channel, 0, 0)
                    print(f"{seq}OK channel={channel} off", flush=True)

            elif cmd == "QUIT":
                print(f"{seq}BYE", flush=True)
                break

            else:
                print(f"{seq}ERR unknown command: {line}", flush=True)

        except Exception as e:
            print(f"{seq}ERR {e}", flush=True)

if __name__ == "__main__":
    main()
