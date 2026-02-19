import time
from collections import deque
from pathlib import Path

import psutil
import board
import busio
from PIL import Image, ImageDraw, ImageFont
import adafruit_ssd1306

RELAY_STATE_FILE = Path("/tmp/relay_state.txt")

def read_relay_state() -> str:
    try:
        s = RELAY_STATE_FILE.read_text().strip().upper()
        if s in ("ON", "OFF"):
            return s
    except Exception:
        pass
    return "OFF"

# ---- Display config ----
WIDTH = 128
HEIGHT = 64  # set to 32 if your OLED is 128x32

# ---- Graph config ----
GRAPH_H = 22
GRAPH_W = WIDTH
GRAPH_Y0 = HEIGHT - GRAPH_H
SAMPLES = GRAPH_W

cpu_hist = deque([0] * SAMPLES, maxlen=SAMPLES)
temp_hist = deque([0] * SAMPLES, maxlen=SAMPLES)

def read_cpu_temp_c():
    p = Path("/sys/class/thermal/thermal_zone0/temp")
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip()) / 1000.0
    except Exception:
        return None

def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v

# ---- I2C + display ----
i2c = busio.I2C(board.SCL, board.SDA)
oled = adafruit_ssd1306.SSD1306_I2C(WIDTH, HEIGHT, i2c)

oled.fill(0)
oled.show()

image = Image.new("1", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)
font = ImageFont.load_default()

# Prime psutil CPU measurement
psutil.cpu_percent(interval=None)

try:
    while True:
        cpu = psutil.cpu_percent(interval=None)
        load1, load5, _load15 = psutil.getloadavg()
        temp = read_cpu_temp_c()

        relay_on = (read_relay_state() == "ON")

        vm = psutil.virtual_memory()
        disk = psutil.disk_usage("/")

        cpu_hist.append(cpu)

        # temp graph: map 20–85C to 0–100%
        if temp is None:
            temp_hist.append(0)
        else:
            temp_pct = (temp - 20.0) / (85.0 - 20.0) * 100.0
            temp_hist.append(clamp(temp_pct, 0, 100))

        # ---- Draw UI ----
        draw.rectangle((0, 0, WIDTH, HEIGHT), fill=0)

        temp_str = "--.-C" if temp is None else f"{temp:4.1f}C"

        # Line 1 (left)
        draw.text((0, 0), f"CPU {cpu:3.0f}% {temp_str}", font=font, fill=255)

        # Relay status (top-right): circle + ON/OFF short label
        # Relay status (top-right): text left, circle right (no overlap)
        badge_r = 4
        cx, cy = WIDTH - 7, 7  # circle stays at far right

        # Draw circle
        draw.ellipse(
            (cx - badge_r, cy - badge_r, cx + badge_r, cy + badge_r),
            outline=255,
            fill=255 if relay_on else 0,
        )

        # Draw ON/OFF text to the LEFT of the circle with a small gap
        label = "ON" if relay_on else "OFF"
        # measure label width (Pillow-safe)
        bbox = draw.textbbox((0, 0), label, font=font)
        label_w = bbox[2] - bbox[0]

        gap = 3
        text_x = (cx - badge_r) - gap - label_w
        draw.text((text_x, 0), label, font=font, fill=255)

        # Line 2: Load avg
        draw.text((0, 12), f"Load {load1:.2f} {load5:.2f}", font=font, fill=255)

        # Line 3: RAM + Disk
        draw.text((0, 24), f"RAM {vm.percent:3.0f}% Disk {disk.percent:3.0f}%", font=font, fill=255)

        # Graph border
        draw.rectangle((0, GRAPH_Y0, WIDTH - 1, HEIGHT - 1), outline=255, fill=0)

        # Plot CPU + Temp
        for x in range(GRAPH_W):
            cpu_y = GRAPH_Y0 + (GRAPH_H - 2) - int((cpu_hist[x] / 100.0) * (GRAPH_H - 2))
            cpu_y = clamp(cpu_y, GRAPH_Y0 + 1, HEIGHT - 2)
            draw.point((x, cpu_y), fill=255)

            if x % 2 == 0:
                t_y = GRAPH_Y0 + (GRAPH_H - 2) - int((temp_hist[x] / 100.0) * (GRAPH_H - 2))
                t_y = clamp(t_y, GRAPH_Y0 + 1, HEIGHT - 2)
                draw.point((x, t_y), fill=255)

        oled.image(image)
        oled.show()
        time.sleep(1)

except KeyboardInterrupt:
    oled.fill(0)
    oled.show()