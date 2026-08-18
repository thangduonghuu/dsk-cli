#!/usr/bin/env python3
"""PTY driver: run `dsk <args>` against a live mock API and dump the screen
after a turn, to verify tools run WITHOUT permission prompts."""
import codecs
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from capture_screen import Screen  # reuse the VT screen model

ROWS = 16
COLS = 70


def main():
    args = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["DEEPSEEK_API_KEY"] = "sk-test-key-for-ui"
        os.environ["HOME"] = "/tmp/dsk-ui-home"
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("NO_COLOR", None)
        os.environ.pop("FORCE_COLOR", None)
        os.execvp("dsk", ["dsk"] + args)
        os._exit(1)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = Screen(ROWS, COLS)
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def drain(duration):
        end = time.time() + duration
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                screen.feed(decoder.decode(data))
        return True

    if not drain(1.2):
        print(screen.dump())
        return
    print("=== STARTUP ===")
    print(screen.dump())

    os.write(fd, b"hello\r")
    if not drain(3.0):
        return
    print("\n=== AFTER 'hello' TURN ===")
    print(screen.dump())

    os.write(fd, b"\x03")
    drain(0.3)
    os.write(fd, b"\x03")
    drain(0.5)
    try:
        os.close(fd)
    except OSError:
        pass


if __name__ == "__main__":
    main()
