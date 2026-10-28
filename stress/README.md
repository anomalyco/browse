# Stress testing browse

Scripts that stress browse end to end on a real, headed Chrome: a scenario suite, a soak with chaos, a fuzzer and a
smoke test. They run on a disposable Linux box (we use the exe.dev VM `browse-stress.exe.xyz`), never on a machine
whose browser or relay someone uses.

## The box

`exe/provision.sh` sets up an Ubuntu 24.04 box and is safe to re-run:

- Node 24 (in `/usr/local`), Bun (the `packageManager` version), Xvfb + fluxbox, Noto fonts (CJK, emoji), ffmpeg,
  x11vnc + noVNC, and Chrome for Testing stable (`~/chrome-for-testing/current`).
- `~/browse`: a clone of this repo, built and paired with `bun run setup`.
- systemd units (`exe/units/`): `browse-xvfb` (display `:99`), `browse-wm`, `browse-chrome` (headed Chrome with the
  extension, restarted on crash), `browse-vnc` (localhost only) and `browse-novnc` (port 8000).
- The relay is not a service: like on a laptop, any CLI or MCP call starts it on `127.0.0.1:19988`.

Chrome's flags are in `exe/chrome.sh`. The profile is `~/stress-profile` with developer mode on (browse's
`install`/`update` reload the extension, and Chrome disables reloaded unpacked extensions while developer mode is
off). Chrome also listens on `127.0.0.1:9222` (`--remote-debugging-port`): **that port is for the harness only**, to
click handoff cards like a person, stop the extension's service worker and count tabs, groups and debugger
attachments. browse never uses it.

Watch the browser at <https://browse-stress.exe.xyz/vnc.html> (exe.dev's proxy, private to people with access to the
VM; keep it private). Click **Connect**; no VNC password, the proxy is the gate.

```sh
wssh browse-stress.exe.xyz                                 # shell (wssh: ssh with the work key)
wssh browse-stress.exe.xyz 'node ~/browse/cli/dist/cli.mjs status'
wssh browse-stress.exe.xyz 'sudo systemctl restart browse-chrome'
stress/exe/deploy.sh                                       # copy this working tree to the box, rebuild, restart the relay
```

`deploy.sh` rsyncs uncommitted work too (nothing is pushed), keeping the box's `.git`, `node_modules`, builds and
pairing code.

## Runners

All of them run on the box from `~/browse`, write JSONL plus a `summary.md` under `~/stress-results/<time>-<kind>/`
and exit non-zero when something failed.

| Command | What it does |
| --- | --- |
| `node stress/smoke.ts` | One MCP stdio session: initialize, tools/list, status, navigate, snapshot, fill, click, screenshot, network capture, recording, session_delete |
| `node stress/run-scenarios.ts [--only a,b] [--tag core] [--repeat N]` | The scenario suite (`scenarios.ts`) once, serially, a fresh session per scenario |
| `node stress/soak.ts [--workers 8] [--minutes 60] [--chaos-every 120] [--chaos a,b]` | N agents loop scenarios and real sites while chaos hits; metrics every 30 s |
| `node stress/fuzz.ts [--minutes 15] [--seed N]` | Malformed and hostile input at the HTTP API, CDP WebSocket, /extension and MCP tools |
| `bash stress/run-all.sh [soakMinutes] [fuzzMinutes]` | All of the above in order (run it in tmux) |

```sh
wssh browse-stress.exe.xyz "tmux new -d -s stress 'bash ~/browse/stress/run-all.sh 60 15 2>&1 | tee ~/stress-results/run-all.log'"
rsync -az -e wssh browse-stress.exe.xyz:stress-results/ /tmp/browse-stress-results/   # fetch results
```

Type-check the runners with `cli/node_modules/.bin/tsgo --noEmit -p stress/tsconfig.json` (they run with Node's type
stripping, no build step).

The scenarios serve a fixture site on `127.0.0.1:4510` (and `localhost:4510` as a second origin). Add a scenario by
appending to `scenarios` in `scenarios.ts`; tag it `soak` if it's safe to run beside other agents.

**Soak chaos events:** `relay-kill9` (kill -9; the next call restarts it), `sw-stop` (terminates the extension's
service worker), `close-agent-tabs`, `close-windows`, `chrome-restart`, `network-drop` (iptables drops ports 80, 443
and 53 for 10 to 25 s), `session-delete` (mid-task), `mcp-kill` (an agent's MCP server dies), `tabs-cleanup`,
`toolbar-stop` (the user clicks the toolbar button on an agent's tab, the kill switch). After each one a probe session
must run an execute within `--recovery-bound` seconds. Tasks overlapping a chaos window are left out of the success
rate. Pass criteria: calm success rate, every event recovered, no stuck workers, no relay restarts that chaos didn't
cause, bounded growth (relay RSS, fds, tabs per hour, fitted after a 5-minute warm-up), every tab a session holds
tracked for idle cleanup throughout, and no leaked tabs after the run (neither held by a session nor a window's active
tab).

`toolbar-stop` clicks through a test hook the extension has only when built with `OPENCODE_BROWSER_TEST_HOOKS=1`
(`exe/deploy.sh` builds it that way; release builds compile the hook out). It lives in the service worker's globals,
which the harness reaches over the debugging port; pages can't.

**Fuzz checks:** the relay never restarts or stops answering `/version`, nothing but `/` and `/version` answers without
the token, foreign `Host` headers and non-extension origins are refused, an unpaired `/extension` client never
displaces the real extension, and the MCP server never exits on bad input.

## Driving the box from a Mac

The MCP server can run on the box over SSH, so an agent on a Mac drives the box's browser:

```sh
node stress/smoke.ts --remote browse-stress.exe.xyz   # initialize, tools/list, status through wssh
```

An opencode MCP server entry for it (add it yourself; nothing here edits your config):

```json
{
  "mcp": {
    "servers": {
      "browse-stress": {
        "type": "local",
        "command": ["wssh", "browse-stress.exe.xyz", "/usr/local/bin/node", "/home/exedev/browse/cli/dist/cli.mjs", "mcp"]
      }
    }
  }
}
```

Use the full `/usr/local/bin/node` path: exe.dev's SSH `PATH` lists `/usr/local/bin` last.
