# Purpose: Exercise private PTY lifecycle and stale-response rejection using synthetic data.
import json
import os
import select
import subprocess
import time
import unittest
from pathlib import Path

BROKER = Path(__file__).resolve().parents[1] / "broker" / "pty-broker.py"


class Client:
    def __init__(self, command, timeout=3, lease=1):
        self.process = subprocess.Popen(["python3", "-I", "-B", str(BROKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.buffer = b""
        self.events = []
        self.send({"command": command, "cwd": "/tmp", "timeout": timeout, "lease": lease})

    def send(self, event):
        self.process.stdin.write(json.dumps(event).encode() + b"\n")
        self.process.stdin.flush()

    def event(self, kind, deadline=4):
        end = time.monotonic() + deadline
        while time.monotonic() < end:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                event = json.loads(line)
                self.events.append(event)
                if event["type"] == kind:
                    return event
            if select.select([self.process.stdout], [], [], 0.05)[0]:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.buffer += chunk
        raise AssertionError(f"Missing event {kind}: {self.events}")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=3)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


class BrokerTests(unittest.TestCase):
    def client(self, command, **kwargs):
        client = Client(command, **kwargs)
        self.addCleanup(client.close)
        return client

    def test_dev_tty_repeated_echo_off_prompts(self):
        c = self.client("for i in 1 2; do stty -echo; printf 'Password: ' >/dev/tty; IFS= read -r x </dev/tty; stty echo; test \"$x\" = synthetic-only || exit 4; printf 'accepted\\n'; done")
        first = c.event("prompt")
        c.send({"type": "input", "id": first["id"], "value": "synthetic-only"})
        second = c.event("prompt")
        self.assertGreater(second["id"], first["id"])
        c.send({"type": "input", "id": second["id"], "value": "synthetic-only"})
        self.assertEqual(c.event("done")["status"], "completed")

    def test_exit_codes(self):
        for command, code in [("exit 0", 0), ("exit 42", 42), ("kill -TERM $$", -15)]:
            with self.subTest(command=command):
                c = self.client(command)
                self.assertEqual(c.event("done")["exitCode"], code)

    def test_closed_output_pipe_still_cleans_child(self):
        c = self.client("printf '%s\\n' $$; sleep 30")
        output = c.event("output")["text"]
        pid = int(output.strip().replace("?", ""))
        c.process.stdout.close()
        c.process.terminate()
        c.process.wait(timeout=3)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_expired_lease_drops_input(self):
        c = self.client("stty -echo; printf 'Password: '; IFS= read -r -t 1 x; test -z \"$x\"", lease=0.2)
        prompt = c.event("prompt")
        c.event("invalidate")
        c.send({"type": "input", "id": prompt["id"], "value": "synthetic-only"})
        self.assertEqual(c.event("done")["status"], "completed")

    def test_output_invalidates_generation(self):
        c = self.client("stty -echo; printf 'Password: '; sleep .4; printf 'expired\\n'; IFS= read -r -t .5 x; test -z \"$x\"")
        prompt = c.event("prompt")
        c.event("invalidate")
        c.send({"type": "input", "id": prompt["id"], "value": "synthetic-only"})
        self.assertEqual(c.event("done")["status"], "completed")

    def test_manual_input_and_wrong_serial(self):
        c = self.client("stty -echo; IFS= read -r x </dev/tty; test \"$x\" = synthetic-only")
        prompt = c.event("prompt")
        c.send({"type": "input", "id": prompt["id"] + 9, "value": "wrong"})
        c.event("invalidate")
        c.send({"type": "manual"})
        prompt = c.event("prompt")
        c.send({"type": "input", "id": prompt["id"], "value": "synthetic-only"})
        self.assertEqual(c.event("done")["status"], "completed")

    def test_timeout_cancellation_and_stderr(self):
        c = self.client("sleep 10", timeout=0.2)
        self.assertEqual(c.event("done")["status"], "timeout")
        d = self.client("sleep 10")
        d.send({"type": "cancel"})
        self.assertEqual(d.event("done")["status"], "cancelled")
        d.process.wait(timeout=2)
        self.assertEqual(d.process.stderr.read(), b"")

    def test_controls_are_inert_and_output_bounded_per_frame(self):
        c = self.client("printf '\\033]52;c;bad\\a\\033[2J'; head -c 100000 /dev/zero")
        self.assertEqual(c.event("done")["status"], "completed")
        outputs = [e["text"] for e in c.events if e["type"] == "output"]
        self.assertTrue(outputs)
        self.assertTrue(all(len(x) <= 4096 for x in outputs))
        self.assertTrue(all(ch == "\n" or 32 <= ord(ch) < 127 for ch in "".join(outputs)))

    def test_pipe_eof_cleans_up(self):
        c = self.client("sleep 10")
        c.process.stdin.close()
        self.assertEqual(c.event("done")["status"], "cancelled")

    def test_process_exit_invalidates_prompt(self):
        c = self.client("stty -echo; printf 'Password: '; sleep .3")
        c.event("prompt")
        c.event("invalidate")
        self.assertEqual(c.event("done")["status"], "completed")

    def test_malformed_input_fails_without_raw_error(self):
        c = self.client("sleep 10")
        c.process.stdin.write(b"not-json\n")
        c.process.stdin.flush()
        self.assertEqual(c.event("done")["status"], "error")
        c.process.wait(timeout=2)
        self.assertEqual(c.process.stderr.read(), b"")


if __name__ == "__main__":
    unittest.main()
