"""Manual, no-generation TUI smoke test against a configured example project.

Usage: python3 tests/smoke.py /path/to/example-project
The project should configure the three README example profiles and connected
providers. The test creates/deletes only its own sessions; it sends no prompts.
Optional: install pyte to additionally check sidebar placement and clicking.
"""
import argparse
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import termios
import time
import urllib.parse


def api(method, path, data=None):
    command = ["opencode", "api", method, path]
    if data is not None:
        command += ["--data", json.dumps(data)]
    result = subprocess.run(command, text=True, capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None


def capture(fd, duration):
    output = bytearray()
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        output.extend(chunk)
        for query, response in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[?u", b"\x1b[?1u")]:
            if query in chunk:
                os.write(fd, response)
    return bytes(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    args = parser.parse_args()
    directory = os.path.abspath(args.directory)
    query = "?" + urllib.parse.urlencode({"location[directory]": directory})
    ids = []
    process = None
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 180, 0, 0))
    try:
        for title in ["Profiles smoke test", "Profiles isolation test"]:
            ids.append(api("post", "/api/session", {"title": title, "location": {"directory": directory}})["data"]["id"])
        session_id, other = ids
        before = api("get", f"/api/session/{other}")
        env = {**os.environ, "TERM": "xterm-256color", "OPENCODE_CLI_CONFIG_CONTENT": json.dumps({
            "session": {"sidebar": "auto"}, "animations": False, "plugins": ["*", "-session-modes.tui"],
        })}
        process = subprocess.Popen(["opencode", directory, "--session", session_id], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        output = capture(master, 8)
        assert all(label in output for label in [b"Profiles", b"PRIVATE", b"WORK", b"DUMB TASK", b"(Current)"])
        for mode in ["work", "dumb-task"]:
            os.write(master, b"\x1b[109;6u")
            output += capture(master, 2)
            state = api("get", f"/api/session/{session_id}")["data"]
            assert state["metadata"]["opencode.session-modes"] == mode, state
        assert state["model"]["id"] == "gpt-6-luna" and state["model"]["variant"] == "max"
        api("post", f"/api/session/{session_id}/agent", {"agent": "plan"})
        output += capture(master, 2)
        assert api("get", f"/api/session/{session_id}")["data"]["model"]["id"] == "gpt-6.1-sol"

        # Manual overrides must survive server reconciliation and live TUI events.
        manual = {"providerID": "github-copilot", "id": "gpt-6-luna", "variant": "high"}
        api("post", f"/api/session/{session_id}/model", {"model": manual})
        output += capture(master, 2)
        api("post", "/api/rpc/opencode-session-profiles/reconcile" + query, {"input": {"sessionID": session_id}})
        assert api("get", f"/api/session/{session_id}")["data"]["model"] == manual
        assert before == api("get", f"/api/session/{other}")
        print("PASS: packed plugin, sidebar, cycling, agent defaults, manual override, session isolation")

        os.write(master, b"\x1b[109;6u")
        output += capture(master, 2)
        assert api("get", f"/api/session/{session_id}")["data"]["metadata"]["opencode.session-modes"] == "private"
        try:
            import pyte
        except ImportError:
            return
        screen = pyte.Screen(180, 60)
        stream = pyte.Stream(screen)
        stream.feed(output.decode(errors="replace"))
        rows = screen.display
        assert next(i for i, row in enumerate(rows) if row.rstrip().endswith("Profiles")) > next(i for i, row in enumerate(rows) if "MCP" in row)
        assert any("PRIVATE (Current)" in row for row in rows)
        row = next(i for i, line in enumerate(rows) if "WORK" in line)
        col = rows[row].index("WORK")
        os.write(master, f"\x1b[<0;{col + 1};{row + 1}M\x1b[<0;{col + 1};{row + 1}m".encode())
        stream.feed(capture(master, 2).decode(errors="replace"))
        assert api("get", f"/api/session/{session_id}")["data"]["metadata"]["opencode.session-modes"] == "work"
        assert any("WORK (Current)" in line for line in screen.display)
        print("PASS: sidebar is below MCP; clicking switches profile without success toast")
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)
        for session_id in ids:
            api("delete", f"/api/session/{session_id}")


if __name__ == "__main__":
    main()
