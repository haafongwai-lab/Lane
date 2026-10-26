# Lane

Lane is a small, Windows-local desktop gateway for one provider and three agents:

- Provider: WorkBuddy — the domestic build (copilot.tencent.com) and the
  international build (www.workbuddy.ai), signed in side by side
- Agents: Claude Desktop, Codex and ZCode

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
- Reversible Claude Desktop, Codex and ZCode wiring

The desktop app keeps the scope intentionally small. It does not implement a
plugin marketplace, multi-provider routing, WSL, cloud sync, project sessions,
or a background updater. Those are magpie capabilities that this project does
not need for the single-provider, Windows-local use case.

## ZCode

ZCode keeps its providers in `~/.zcode/v2/provider_config.json`. Lane adds one
custom rule named `lane` there — speaking Anthropic Messages at the gateway,
with the account's model list — and puts it first in `providerOrder`. A rule
without a template is complete on its own in ZCode's schema, so nothing else
in the file changes: the user's API keys, other providers and settings are
written back as they were. Disconnect removes the rule and its order entry.
ZCode must be restarted to read the new provider.

## Accounts

Both WorkBuddy builds are supported. An account belongs to the build it was
signed in through: `lane login --site workbuddy-ai` joins the international
one, plain `lane login` the domestic one. The two have separate endpoints and
separate model catalogues, and an account always talks to its own build —
switching the route to an international account moves requests with it.
Accounts written before this existed count as domestic.

WorkBuddy accepts several accounts at once. Each one that signs in is kept in
`%LOCALAPPDATA%\lane\accounts.json` with its own tokens, and one of them is
the route:

- **Switch** makes another account carry requests. The previous one stays
  signed in and idle.
- **Switch off** keeps the sign-in but takes the account out of the route and
  out of the daily check-in. Switching off the active account hands the route
  to the next account that is on.
- **Remove** deletes the tokens Lane stored for that account.

The account's uid names it, so signing the same account in again refreshes its
entry instead of adding a second one. A team account is a separate entry from
the same person's personal account, because it carries a different enterprise.

The single account Lane used before is imported once, and
`workbuddy-auth.json` keeps mirroring whichever account is active.

## Daily check-in

Each account has a daily check-in that grants credits. Lane claims it with the
same two calls WorkBuddy's own client makes:

```
POST /v2/billing/meter/checkin-status   today's check-in
POST /v2/billing/meter/daily-checkin    claim it
```

By default the check-in runs at 09:00 local time for every account that is
switched on, and only from the process that owns the gateway. An account
already checked in today is skipped without a request; a failure is retried
thirty minutes later. The time and the on/off switch live in the desktop app's
**账号** view, and in `%LOCALAPPDATA%\lane\checkin.json`.

## Desktop app

Run the desktop control panel from source:

```powershell
npm run desktop
```

It shows the live route from Codex or Claude Desktop through Lane to
WorkBuddy, starts and stops the local gateway, manages WorkBuddy sign-in,
connects/disconnects both agents, lists models, and keeps recent request
timing and token usage locally. Closing the window keeps Lane in the system
tray; choose **Exit** in the tray to stop the gateway.

The **用量信息** view breaks usage down for today, the last 7 days or the
last 15 days: a daily chart of credits and tokens, the account's own cycle
credits beside it, a per-model breakdown, and the most recent requests. The
gateway's own accounting bills a request with what WorkBuddy itself charged
(`credit`, when the upstream reports one) and otherwise estimates from a
calibrated price; the catalogue's `rate` is a relative multiplier, not a
price. It is kept separate from WorkBuddy's whole-account meter, which
cannot be split per request.

Build the Windows installer and portable executable:

```powershell
npm run build
```

The outputs are named after the version in package.json:

- `dist\Lane Setup <version>.exe` - per-user installer
- `dist\Lane <version>.exe` - portable executable

## Commands

```powershell
npm install
npm test
npm run serve
npm run doctor
```

### Accounts and check-in

```powershell
node src/cli.js accounts            # every account, which one is active
node src/cli.js login               # add an account
node src/cli.js use <account>       # switch the route
node src/cli.js disable <account>   # keep the sign-in, leave the route
node src/cli.js enable <account>
node src/cli.js forget <account>    # remove the stored tokens
node src/cli.js checkin             # claim today, for every enabled account
node src/cli.js checkin off         # stop the daily check-in
node src/cli.js checkin at 08:30    # move it
```

`<account>` is the full id, the account label, or a unique prefix of either.

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
node src/cli.js connect zcode
```

Restart the agent after connecting. To undo only Lane's changes:

```powershell
node src/cli.js disconnect claude-desktop
node src/cli.js disconnect codex
node src/cli.js disconnect zcode
```

Disconnect restores the values Lane stored before its first write. It does
not remove unrelated settings.

To start Lane automatically when this Windows user signs in:

```powershell
node src/cli.js autostart install
node src/cli.js autostart uninstall
```

This creates a per-user shortcut named `Lane Gateway` in the current user's
Startup folder. It does not install a Windows service, register a Scheduled
Task, or require administrator access. Logs go to
`%LOCALAPPDATA%\lane\lane.log` and `%LOCALAPPDATA%\lane\lane-error.log`.

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
