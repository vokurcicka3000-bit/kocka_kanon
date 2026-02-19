import time
import board
import busio
from PIL import Image, ImageDraw, ImageFont
import adafruit_ssd1306

# ---- Display config ----
WIDTH = 128
HEIGHT = 64   # change to 32 if your OLED is 128x32

# ---- I2C + display ----
i2c = busio.I2C(board.SCL, board.SDA)
oled = adafruit_ssd1306.SSD1306_I2C(WIDTH, HEIGHT, i2c)

oled.fill(0)
oled.show()

# ---- Image buffer ----
image = Image.new("1", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)

# ---- Font ----
font = ImageFont.load_default()
TEXT = "pekne napicu displej"

# Text size
bbox = draw.textbbox((0, 0), TEXT, font=font)
text_w = bbox[2] - bbox[0]
text_h = bbox[3] - bbox[1]

# ---- Initial position & velocity ----
x, y = 0, 0
dx, dy = 2, 2   # speed (pixels per frame)

# ---- Animation loop ----
try:
    while True:
        draw.rectangle((0, 0, WIDTH, HEIGHT), outline=0, fill=0)

        draw.text((x, y), TEXT, font=font, fill=255)

        oled.image(image)
        oled.show()

        x += dx
        y += dy

        # Bounce on edges
        if x <= 0 or x + text_w >= WIDTH:
            dx = -dx
        if y <= 0 or y + text_h >= HEIGHT:
            dy = -dy

        time.sleep(0.03)  # smoothness / speed

except KeyboardInterrupt:
    oled.fill(0)
    oled.show()
