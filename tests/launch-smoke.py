"""No-generation launch-screen test. Requires pyte and a disposable project
configured with the README's three example profiles and connected providers.
Usage: python3 tests/launch-smoke.py /path/to/example-project
"""
import fcntl
import json
import os
import pty
import struct
import subprocess
import sys
import termios
import urllib.parse

import pyte
from smoke import api, capture


def main():
    directory = os.path.abspath(sys.argv[1])
    query = "?" + urllib.parse.urlencode({"location[directory]": directory})

    def sessions():
        return {item["id"]: item for item in api("get", "/api/session" + query)["data"]
                if item["location"]["directory"] == directory}

    def run(select_profile, height=40, width=140):
        before = sessions()
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        env = {**os.environ, "TERM": "xterm-256color", "OPENCODE_CLI_CONFIG_CONTENT": json.dumps({
            "animations": False, "plugins": ["*", "-session-modes.tui"],
        })}
        process = subprocess.Popen(["opencode", directory], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        try:
            screen = pyte.Screen(width, height)
            stream = pyte.Stream(screen)
            stream.feed(capture(master, 8).decode(errors="replace"))
            rows = screen.display
            assert any("PRIVATE (Current)" in line for line in rows), "Launch default is missing\n" + "\n".join(rows)
            assert any("Build:" in line for line in rows) and any("Plan:" in line for line in rows)
            assert sessions().keys() == before.keys(), "Viewing launch screen must not create a session"
            select_profile(master, rows)
            stream.feed(capture(master, 3).decode(errors="replace"))
            assert sessions().keys() == before.keys(), "Changing profile must keep launch screen open without creating sessions"
            assert any("Start session with WORK" in row for row in screen.display), screen.display
            rows = screen.display
            row = next(i for i, line in enumerate(rows) if "Start session with WORK" in line)
            col = rows[row].index("Start session with WORK")
            os.write(master, f"\x1b[<0;{col + 1};{row + 1}M\x1b[<0;{col + 1};{row + 1}m".encode())
            stream.feed(capture(master, 3).decode(errors="replace"))
            created = {key: value for key, value in sessions().items() if key not in before}
            assert len(created) == 1, created
            session_id = next(iter(created))
            state = api("get", f"/api/session/{session_id}")["data"]
            assert state["metadata"]["opencode.session-modes"] == "work", state
            assert state["model"]["providerID"] == "github-copilot", state
            if width >= 120:
                assert any("WORK (Current)" in row for row in screen.display)
            messages = api("get", f"/api/session/{session_id}/context")["data"]
            assert all(message["type"] in ("model-switched", "agent-switched") for message in messages), messages
            print("PASS: launch indicator, default models, selection before prompting, session profile")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            os.close(master)
            for session_id in sessions().keys() - before.keys():
                api("delete", f"/api/session/{session_id}")

    def click(master, rows):
        row = next(i for i, line in enumerate(rows) if "WORK" in line)
        col = rows[row].index("WORK")
        os.write(master, f"\x1b[<0;{col + 1};{row + 1}M\x1b[<0;{col + 1};{row + 1}m".encode())

    run(click)
    run(lambda master, _: os.write(master, b"\x1b[109;6u"))
    run(lambda master, _: os.write(master, b"/mode work\r"), height=24, width=80)


if __name__ == "__main__":
    main()
