#!/usr/bin/env python3
"""Capture dsk's terminal screen state through a real PTY.

Forks a PTY at a fixed size, runs `dsk`, feeds keystrokes, and dumps the
resulting screen grid (rows x cols) so UI positioning can be verified without
a real terminal. Implements a minimal VT screen model: printable chars, CR,
LF (with scroll at the bottom), CUP, CUU/CUD/CUF/CUB, ED (erase down), EL,
SU (scroll up), and alt-screen enter/exit.
"""
import codecs
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

ROWS = int(os.environ.get("PTY_ROWS", "12"))
COLS = int(os.environ.get("PTY_COLS", "64"))


class Screen:
    def __init__(self, rows, cols):
        self.rows = rows
        self.cols = cols
        self.grid = [[" " for _ in range(cols)] for _ in range(rows)]
        self.r = 0
        self.c = 0
        self.pending = False  # deferred wrap: cursor sits on the last column
        self.alt = False

    def scroll_up(self, n=1):
        for _ in range(n):
            self.grid.pop(0)
            self.grid.append([" " for _ in range(self.cols)])

    def newline(self):
        if self.r == self.rows - 1:
            self.scroll_up(1)
        else:
            self.r += 1
        self.c = 0

    def put(self, ch):
        if ch == "\r":
            self.c = 0
            self.pending = False
            return
        if ch == "\n":
            # Deferred wrap: a "\n" while hanging on the last column goes down
            # one row; otherwise it is a plain line feed.
            if self.pending:
                self.pending = False
            self.newline()
            return
        if ch == "\t":
            self.c = min(self.cols - 1, self.c + (8 - (self.c % 8)))
            return
        if ch == "\b":
            self.c = max(0, self.c - 1)
            return
        if ch == "\x1b":
            return  # escape sequences handled separately
        if 32 <= ord(ch) < 127 or ord(ch) >= 0xA0:
            if self.pending:
                # A printable char while hanging on the last column wraps first.
                self.pending = False
                self.newline()
            self.grid[self.r][self.c] = ch
            if self.c == self.cols - 1:
                self.pending = True
            else:
                self.c += 1

    def cup(self, row, col):
        self.r = max(0, min(self.rows - 1, row - 1))
        self.c = max(0, min(self.cols - 1, col - 1))

    def erase_down(self):
        for cc in range(self.c, self.cols):
            self.grid[self.r][cc] = " "
        for rr in range(self.r + 1, self.rows):
            for cc in range(self.cols):
                self.grid[rr][cc] = " "

    def erase_line(self):
        for cc in range(self.cols):
            self.grid[self.r][cc] = " "

    def feed(self, data):
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b" and i + 1 < n:
                if data[i + 1] == "[":
                    j = i + 2
                    params = ""
                    while j < n and (data[j].isdigit() or data[j] in ";?$"):
                        params += data[j]
                        j += 1
                    if j >= n:
                        break
                    final = data[j]
                    raw = params.split(";")
                    digits = lambda s: "".join(ch for ch in s if ch.isdigit())
                    ps = [int(digits(x)) if digits(x) else 1 for x in raw] if params else [1]
                    p1, p2 = ps[0], (ps[1] if len(ps) > 1 else 1)
                    if final in "Hf":
                        self.cup(p1, p2)
                    elif final == "A":
                        self.r = max(0, self.r - p1)
                    elif final == "B":
                        self.r = min(self.rows - 1, self.r + p1)
                    elif final == "C":
                        self.c = min(self.cols - 1, self.c + p1)
                    elif final == "D":
                        self.c = max(0, self.c - p1)
                    elif final == "G":
                        self.c = max(0, min(self.cols - 1, p1 - 1))
                    elif final == "d":
                        self.r = max(0, min(self.rows - 1, p1 - 1))
                    elif final == "J":
                        mode = p1 if params else 0
                        if mode == 2 or mode == 3:
                            self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]
                            self.r = 0
                            self.c = 0
                        else:
                            self.erase_down()
                    elif final == "K":
                        self.erase_line()
                    elif final == "S":
                        self.scroll_up(p1)
                    i = j + 1
                    continue
                else:
                    i += 2
                    continue
            self.put(ch)
            i += 1

    def dump(self):
        lines = []
        for rr in range(self.rows):
            line = "".join(self.grid[rr]).rstrip()
            lines.append(f"{rr + 1:>2}|{line}")
        return "\n".join(lines)


def main():
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ["DEEPSEEK_API_KEY"] = "sk-test-key-for-ui"
        os.environ["HOME"] = os.environ.get("DSK_HOME", "/tmp/dsk-ui-home")
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("NO_COLOR", None)
        os.environ.pop("FORCE_COLOR", None)
        os.chdir(os.environ.get("DSK_CWD", os.getcwd()))
        os.execvp("dsk", ["dsk"] + sys.argv[1:])
        os._exit(1)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = Screen(ROWS, COLS)
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    start = time.time()

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

    # 1) startup
    if not drain(1.2):
        print(screen.dump())
        return
    print("=== AFTER STARTUP ===")
    print(screen.dump())

    # 2) type /help and run it (fills the screen -> exercises pinning)
    os.write(fd, b"/help\r")
    if os.environ.get("RAW"):
        raw = b""
        end = time.time() + 0.8
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                raw += data
                screen.feed(data.decode("utf-8", "replace"))
        print("\n=== RAW BYTES (/help phase) ===")
        print(repr(raw[-3000:]))
    elif not drain(0.8):
        return
    print("\n=== AFTER /help (full screen) ===")
    print(screen.dump())

    # 3) type a few chars to re-render the prompt block (no submit)
    os.write(fd, b"abc")
    drain(0.4)
    print("\n=== AFTER typing 'abc' ===")
    print(screen.dump())

    # 4) multiline input: backslash + Enter inserts a newline; block grows
    os.write(fd, b"\\\r")
    drain(0.3)
    os.write(fd, b"xyz")
    drain(0.3)
    print("\n=== AFTER multiline (abc\\ + xyz) ===")
    print(screen.dump())

    # 5) Shift+Tab cycles permission mode -> toast line appears above the input
    os.write(fd, b"\x1b[Z")
    drain(0.3)
    print("\n=== AFTER shift+tab (toast) ===")
    print(screen.dump())

    # 6) exit: Ctrl+C clears the draft, Ctrl+C again exits
    os.write(fd, b"\x03")
    drain(0.3)
    print("\n=== AFTER first ctrl+c ===")
    print(screen.dump())
    os.write(fd, b"\x03")
    drain(0.5)
    try:
        os.close(fd)
    except OSError:
        pass


if __name__ == "__main__":
    main()
