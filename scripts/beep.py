#!/usr/bin/env python3
"""
beep.py — single-note PCM player for Raspberry Pi.

Generates one square-wave note and pipes it to aplay, then exits.
Designed to be called once per dance step so the note duration
acts as the step's wall-clock gate — servo move and audio finish together.

Usage:
  python3 beep.py <note> <duration_ms> [volume_pct]

  note        — note name: C C# D D# E F F# G G# A A# B  or  R (rest)
  duration_ms — how long to play (milliseconds)
  volume_pct  — 0-100, default 80

Examples:
  python3 beep.py E 250 80
  python3 beep.py R 500        # silent rest
"""

import sys
import struct
import subprocess

NOTE_FREQ = {
    "C":  261.63, "C#": 277.18, "D":  293.66, "D#": 311.13,
    "E":  329.63, "F":  349.23, "F#": 369.99, "G":  392.00,
    "G#": 415.30, "A":  440.00, "A#": 466.16, "B":  493.88,
    "R":  0.0,
}

SAMPLE_RATE = 22050

def render_note(freq, duration_ms, volume):
    n_samples = int(SAMPLE_RATE * duration_ms / 1000)
    peak = int(32767 * volume)
    buf = bytearray(n_samples * 2)

    if freq <= 0.0:
        return bytes(buf)  # silence

    attack  = min(int(SAMPLE_RATE * 0.010), n_samples // 4)
    release = min(int(SAMPLE_RATE * 0.010), n_samples // 4)

    for i in range(n_samples):
        phase = (i * freq / SAMPLE_RATE) % 1.0
        raw = peak if phase < 0.5 else -peak
        if i < attack:
            raw = int(raw * i / attack)
        elif i >= n_samples - release:
            raw = int(raw * (n_samples - i) / release)
        struct.pack_into("<h", buf, i * 2, raw)

    return bytes(buf)

def main():
    if len(sys.argv) < 3:
        print("Usage: beep.py <note> <duration_ms> [volume_pct]", file=sys.stderr)
        sys.exit(1)

    note        = sys.argv[1].upper()
    duration_ms = int(sys.argv[2])
    volume      = float(sys.argv[3]) / 100.0 if len(sys.argv) > 3 else 0.8
    volume      = max(0.0, min(1.0, volume))

    freq    = NOTE_FREQ.get(note, 0.0)
    pcm     = render_note(freq, duration_ms, volume)

    cmd = [
        "aplay",
        "-D", "plughw:0,0",
        "-f", "S16_LE",
        "-r", str(SAMPLE_RATE),
        "-c", "1",
        "--buffer-size=4096",
        "-q",
    ]
    try:
        proc = subprocess.run(cmd, input=pcm, timeout=10)
        sys.exit(proc.returncode)
    except FileNotFoundError:
        print("aplay not found", file=sys.stderr, flush=True)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        sys.exit(1)

if __name__ == "__main__":
    main()
