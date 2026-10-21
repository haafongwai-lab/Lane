# Lane

Lane is a small, Windows-local gateway for one provider and two agents:

- Provider: WorkBuddy
- Agents: Claude Desktop and Codex

It is intentionally independent from magpie. It does not read magpie's data
directory, use its port, or control its processes.

## What is implemented

- Local HTTP gateway on `127.0.0.1:3426`
- `GET /healthz`
- OpenAI `GET /v1/models` and `POST /v1/chat/completions`
- Anthropic `POST /v1/messages` with streaming and tool-call translation
- OpenAI Responses `POST /v1/responses` with streaming and tool-call translation
- Streamed tool calls for both Claude `tool_use` and Codex `function_call`
- Non-stream clients also work: Lane gathers WorkBuddy's required SSE reply
- Stable Claude-facing aliases for WorkBuddy model ids
- WorkBuddy sign-in, token persistence, refresh, model discovery and request
  handling through the community plugin
- Reversible Claude Desktop and Codex wiring

The gateway intentionally does not implement a GUI, plugin marketplace,
multi-provider routing, WSL, cloud sync, sessions, usage analytics or
background updater. Those are magpie capabilities that this project does not
need for the single-provider, Windows-local use case.

## Commands

```powershell
npm install
npm test
npm run serve
npm run doctor
```

### First run

```powershell
npm install
npm run doctor
npm run serve
```

In a second terminal:

```powershell
node src/cli.js login
```

Open the printed WorkBuddy URL and finish sign-in in the browser. Lane keeps
the result in its own `%LOCALAPPDATA%\lane\workbuddy-auth.json`.

Then wire an agent:

```powershell
node src/cli.js connect claude-desktop
node src/cli.js connect codex
```

Restart the agent after connecting. To undo only Lane's changes:

```powershell
node src/cli.js disconnect claude-desktop
node src/cli.js disconnect codex
```

Disconnect restores the values Lane stored before its first write. It does
not remove unrelated settings.

To start Lane automatically when this Windows user signs in:

```powershell
node src/cli.js autostart install
node src/cli.js autostart uninstall
```

This creates a per-user Scheduled Task named `Lane Gateway`; it does not
install a Windows service or require administrator access. Logs go to
`%LOCALAPPDATA%\lane\lane.log`.

`connect` and `disconnect` commands write only the keys Lane owns. A copy of
the previous values is kept under Lane's own data directory.

## Data

Runtime data is kept under `%LOCALAPPDATA%\lane` by default. An explicit
`LANE_DATA_DIR` overrides it. The path is deliberately separate from
magpie's.

## Endpoint mapping

| Client | Endpoint | Upstream |
| --- | --- | --- |
| Codex | `/v1/responses` | WorkBuddy Chat Completions |
| Claude Desktop | `/v1/messages` | WorkBuddy Chat Completions |
| Generic OpenAI client | `/v1/chat/completions` | WorkBuddy Chat Completions |

WorkBuddy only accepts streamed Chat Completions. Lane forces streaming
upstream and presents either a normal JSON response or an SSE stream to the
client, depending on what that client asked for.

The Codex provider entry sets `supports_websockets = false`. Codex therefore
uses HTTP Responses instead of trying the unsupported WebSocket transport.

## Known limits

- The Codex Responses WebSocket is not implemented. Lane wires Codex to HTTP
  Responses explicitly, so normal Codex turns do not use that transport.
- WorkBuddy's own API can refuse a system prompt or wording it does not
  recognize. The community plugin handles known cases and returns its error
  text; Lane passes that text through.
- Claude Desktop's model picker only accepts Anthropic-looking ids. Lane
  therefore exposes `anthropic/lane-<stable-hash>` aliases and displays the
  real WorkBuddy model name beside them.
- Autostart runs only after the user signs in. Lane does not install a
  system-wide Windows service.

## WorkBuddy plugin

The WorkBuddy adapter uses
`@magpie-community/opencode-workbuddy-auth`. The plugin is MIT licensed.
Its package is kept as a dependency so WorkBuddy-specific sign-in, refresh,
model discovery, headers, and request fixes stay in one maintained place.

The plugin is not copied into this repository. If it is missing, Lane still
reports the missing dependency clearly; `npm install` restores it.
See `THIRD_PARTY_NOTICES.md`.
