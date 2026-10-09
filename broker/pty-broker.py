# Purpose: Mediate a private Linux PTY through bounded, generation-checked pipe messages.
import codecs
import ctypes
import json
import os
import re
import resource
import select
import signal
import sys
import termios
import time

CUE = re.compile(r"(?:password|passphrase|verification code|one.time|otp|pin|yes/no|continue connecting|[?>:]\s*$)", re.I)


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def safe(text):
    return "".join(c if c == "\n" or 32 <= ord(c) < 127 else "?" for c in text)


class Broker:
    def __init__(self, config):
        self.config = config
        self.pid = None
        self.fd = None
        self.status = "error"
        self.active = None
        self.serial = 0
        self.tail = ""
        self.last_output = time.monotonic()
        self.pending_cue = False
        self.echo = True
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.input_buffer = b""

    def invalidate(self):
        if self.active:
            self.active = None
            emit({"type": "invalidate"})

    def attrs(self):
        return termios.tcgetattr(self.fd)

    def alive(self):
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.status = "completed" if os.waitstatus_to_exitcode(status) == 0 else "failed"
            return False
        return True

    def prompt(self):
        self.invalidate()
        self.serial += 1
        self.active = (self.serial, time.monotonic() + self.config["lease"], self.attrs())
        emit({"type": "prompt", "id": self.serial, "lease": self.config["lease"]})
        self.pending_cue = False
        self.tail = ""

    def drain(self):
        # Bound each drain so output floods cannot starve cancellation or deadlines.
        for _ in range(16):
            if not select.select([self.fd], [], [], 0)[0]:
                return
            try:
                chunk = os.read(self.fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            self.invalidate()
            text = safe(self.decoder.decode(chunk))
            emit({"type": "output", "text": text})
            self.tail = (self.tail + text)[-2048:]
            self.last_output = time.monotonic()
            self.pending_cue = bool(CUE.search(self.tail[-256:]))

    def message(self, message):
        kind = message.get("type")
        if kind == "cancel":
            self.status = "cancelled"
            return False
        if kind == "manual":
            self.drain()
            self.prompt()
        elif kind == "input":
            self.drain()
            active = self.active
            self.invalidate()
            value = message.get("value", "")
            if not active or message.get("id") != active[0] or time.monotonic() >= active[1]:
                return True
            if not self.alive():
                return False
            if self.attrs() != active[2] or select.select([self.fd], [], [], 0)[0]:
                return True
            if not isinstance(value, str) or len(value.encode("utf-8")) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                return True
            # This narrows a race, but cannot prove a program is blocked in read().
            os.write(self.fd, value.encode("utf-8") + b"\n")
            self.tail = ""
            emit({"type": "submitted"})
        return True

    def cleanup(self):
        self.invalidate()
        if self.pid:
            # A new session/process group catches ordinary shell grandchildren.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(self.pid, sig)
                except ProcessLookupError:
                    pass
                if sig == signal.SIGTERM:
                    time.sleep(0.1)
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
        if self.fd is not None:
            os.close(self.fd)

    def run(self):
        import pty

        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(self.config["cwd"])
                os.environ["TERM"] = "dumb"
                os.execvp("bash", ["bash", "--noprofile", "--norc", "-c", self.config["command"]])
            except BaseException:
                os._exit(127)
        deadline = time.monotonic() + self.config["timeout"]
        os.set_blocking(self.fd, False)
        try:
            while True:
                if not self.alive():
                    self.drain()
                    break
                now = time.monotonic()
                if now >= deadline:
                    self.status = "timeout"
                    break
                self.drain()
                attrs = self.attrs()
                echo = bool(attrs[3] & termios.ECHO)
                if self.active and (now >= self.active[1] or attrs != self.active[2]):
                    self.invalidate()
                if echo != self.echo:
                    self.invalidate()
                    self.pending_cue = not echo
                    self.last_output = now
                    self.echo = echo
                if self.pending_cue and not self.active and now - self.last_output >= 0.15:
                    self.prompt()
                ready = select.select([0], [], [], 0.025)[0]
                if ready:
                    chunk = os.read(0, 4096)
                    if not chunk:
                        self.status = "cancelled"
                        break
                    self.input_buffer += chunk
                    if len(self.input_buffer) > 16384:
                        break
                    while b"\n" in self.input_buffer:
                        line, self.input_buffer = self.input_buffer.split(b"\n", 1)
                        if not self.message(json.loads(line)):
                            return
        finally:
            self.cleanup()


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Linux parent death interrupts the broker so its finally block kills the PTY group.
    ctypes.CDLL(None).prctl(1, signal.SIGTERM)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    broker = None
    try:
        line = b""
        while not line.endswith(b"\n"):
            chunk = os.read(0, 1)
            if not chunk or len(line) >= 65536:
                raise ValueError()
            line += chunk
        config = json.loads(line)
        if not 0.1 <= config["timeout"] <= 3600 or not 0.1 <= config["lease"] <= 120:
            raise ValueError()
        if not isinstance(config["command"], str) or len(config["command"]) > 8192:
            raise ValueError()
        broker = Broker(config)
        broker.run()
    except BaseException:
        pass
    finally:
        try:
            emit({"type": "done", "status": broker.status if broker else "error"})
        except BaseException:
            pass


if __name__ == "__main__":
    main()
