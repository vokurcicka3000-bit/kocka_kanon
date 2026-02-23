#!/usr/bin/env python3
# Persistent servo daemon - reads commands from stdin, keeps PCA9685 alive.
# Protocol: one command per line
#   SET <channel> <angle>   - move servo on channel to angle (0-270)
#   OFF <channel>           - disable PWM on channel (servo relaxes)
#   OFF ALL                 - disable PWM on all channels
#   QUIT                    - exit
import sys
from Adafruit_PCA9685 import PCA9685

ANGLE_MIN = 0
ANGLE_MAX = 270
I2C_BUS = 1

# Per-channel pulse calibration.
# Tune PULSE_MIN/PULSE_MAX for each channel to eliminate idle jitter.
# At 50 Hz, 1 count ≈ 4.88 µs; a standard servo wants 1000–2000 µs (≈205–410 counts).
# Defaults (80–460) cover a wide range; narrow them to match each servo's actual travel.
CHANNEL_CONFIG = {
  0: {"pulse_min": 80, "pulse_max": 460},   # horizontal servo
  1: {"pulse_min": 80, "pulse_max": 460},   # vertical servo — tune these if ch1 jitters
}
DEFAULT_CONFIG = {"pulse_min": 80, "pulse_max": 460}

def angle_to_pulse(angle, channel=None):
    angle = max(ANGLE_MIN, min(ANGLE_MAX, angle))
    cfg = CHANNEL_CONFIG.get(channel, DEFAULT_CONFIG) if channel is not None else DEFAULT_CONFIG
    return int(cfg["pulse_min"] + (cfg["pulse_max"] - cfg["pulse_min"]) * angle / ANGLE_MAX)

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
                pulse = angle_to_pulse(angle, channel)
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
