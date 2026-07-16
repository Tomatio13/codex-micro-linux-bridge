# Development

How the emulator works, the wire protocol it reimplements, and the two ways it
gets the ChatGPT app to see a virtual Codex Micro.

## Architecture

The interesting logic lives in `src/` (pure JS). Getting the app to *see* a
device is a separate, platform-specific concern handled two ways.

```
 ChatGPT app ──▶ virtual device ──▶  bridge (src/)  ──▶ Stream Deck
 (unmodified)    (shim OR helper)     emulator + backend    (your hardware)
      ▲                                     │
      └──────── key events / lighting ──────┘
```

- **`src/emulator.js`** — the JSON-RPC state machine. Transport-agnostic: feed it
  complete request lines, it emits response/notification lines and a `lighting`
  event when the app pushes new colors.
- **`src/framing.js`** — HID report framing and reassembly (see the gotcha below).
- **`src/link.js`** — binds an emulator to a transport (reports ⇄ messages).
- **`src/transports/`** — `socket.js` (connect to the native helper), `socket-server.js`
  (listen for the shim), `loopback.js` (in-memory, for tests).
- **`src/streamdeck.js`** — the Stream Deck backend (input → notifications,
  lighting → keys/LCD).
- **`src/mapping.js`, `keycaps.js`, `states.js`, `renderer.js`** — layout, icons,
  colors, image rendering.

The bridge is identical across both device modes; only which end opens the
socket differs.

## Getting the app to see the device

### Shim mode (works today, no Apple)

The ChatGPT app is Electron and discovers HID devices through the `node-hid`
native module in its **main process**. Shim mode injects a wrapper around
`node-hid` so the app enumerates and opens a synthetic Codex Micro backed by our
bridge.

- `shim/patch.cjs` — monkeypatches `Module._load` so `require('node-hid')`
  returns a patched module: `devices()` gains the fake device; `HIDAsync.open()`
  returns a fake device whose 64-byte reports are forwarded over a Unix socket to
  the bridge (`SocketServerTransport`).
- `shim/preload.cjs` — installs the hook; injected via `NODE_OPTIONS`.
- `shim/launch-chatgpt.sh` — sets `NODE_OPTIONS="--require .../preload.cjs"` and
  execs the app binary directly (macOS's `open` won't propagate the env var).

This works because the app's Electron fuses permit it — check them with:

```bash
# EnableNodeOptionsEnvironmentVariable must be enabled
python3 - "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Codex Framework" <<'EOF'
import sys
d=open(sys.argv[1],'rb').read(); s=b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'; i=d.find(s)
raw=d[i+len(s):i+len(s)+18]; body=raw[2:]  # [version][count][states...]
names=["RunAsNode","CookieEncryption","NodeOptionsEnvVar","NodeCliInspect","AsarIntegrity","OnlyLoadAppFromAsar","V8Snapshot","GrantFileProto"]
for n,b in zip(names,body): print(f"{n}: {'on' if b==0x31 else 'off'}")
EOF
```

Injecting into another app's process is inherently fragile (it can break on app
updates) and is for personal use only. No app files are modified and the app's
code signature is untouched.

### Helper mode (proper, needs an Apple entitlement)

`native/CodexMicroVirtualHID` is a small Swift helper that creates a *real* IOKit
virtual HID device (`IOHIDUserDeviceCreateWithProperties`) with the Codex Micro's
identity, and pumps 64-byte reports over a socket to the bridge. It uses only
public-SDK symbols, surfaced to Swift via `IOHIDUserDeviceShim.h` (the header
isn't in IOKit's Swift module map).

```bash
npm run build:native
./scripts/start.sh   # runs the helper + bridge
```

On macOS 26 (Apple Silicon) this is gated by a **restricted entitlement**,
confirmed empirically:

- **Root is not enough** — `IOHIDUserDeviceCreateWithProperties` returns `nil`
  without the entitlement.
- **Ad-hoc signing the entitlement is SIGKILL'd** by AMFI at launch (exit 137).
  It's only honored from a genuine Apple-issued provisioning profile.

To ship it properly, request **`com.apple.developer.hid.virtual.device`** (the
"Virtual HID" option on Apple's entitlement request form), then:

1. Create an App ID with that capability + a Developer ID provisioning profile
   embedding it.
2. Wrap the CLI in a minimal background `.app` bundle (a bare CLI can't carry a
   provisioning profile; a `.app` embeds `embedded.provisionprofile`).
3. Sign (Developer ID + `native/CodexMicroVirtualHID/entitlements.plist.template`),
   notarize, staple.

If Apple steers you to DriverKit, the equivalent set is
`com.apple.developer.driverkit` + `com.apple.developer.driverkit.transport.hid`
(a larger build). Prefer Virtual HID — the existing helper already targets it.

There's no pure-userspace way around presenting a real IOKit HID device: the app
enumerates through IOKit and matches on the vendor usage page.

## Wire protocol

Reimplemented for compatibility from the Work Louder device kit and the ChatGPT
app's `CodexMicroService`.

### Discovery

The app matches a device on **all** of:

| Field | Value |
| --- | --- |
| Vendor ID | `0x303A` (Espressif) |
| Product ID | `0x8360` (Codex Micro) |
| HID usage page | `0xFF00` (vendor-defined) |
| Manufacturer | contains `Work Louder` (soft; falls back to VID-only) |

`bcdDevice & 0x0003 == 0` marks the link as USB.

### HID report framing

Each logical message is one or more 64-byte HID reports:

```
byte 0 : 0x06        report ID
byte 1 : channel     1 = debug log, 2 = RPC
byte 2 : length      payload bytes in this report (0..61)
3..63  : payload      up to 61 UTF-8 bytes; longer messages span reports
```

### The framing gotcha (asymmetric!)

The two directions terminate messages **differently** — this is the single
easiest thing to get wrong, and it makes every request silently time out:

- **device → host** (our responses/notifications): **newline-delimited**. The app
  accumulates and splits on `\n`. So we append `\n` to everything we send.
- **host → device** (the app's requests): **bare JSON, no terminator**.
  `WLRPCClient.sendRpcCall` writes the escaped JSON directly. The firmware parses
  by JSON completion, so we detect complete objects by **balanced braces**
  (`extractJsonObjects` in `framing.js`), not by newline.

### JSON-RPC

Requests carry an `id` (0–999) and omit the `jsonrpc` field. Every `id` request
**must** get a reply — the app's transport serializes on a single queue with a
10 s timeout, so one missing reply wedges everything behind it.

Requests the app sends → our reply:

| Method | Purpose | Reply |
| --- | --- | --- |
| `device.status` | poll (~60 s) | `{version, profile_index, layer_index, battery, is_charging}` |
| `sys.version` | firmware version | version string |
| `v.oai.rgbcfg` | keys + ambient lighting | `true` |
| `v.oai.thstatus` | per-thread (slot) lighting | `true` |
| `lights.preview` | live preview | `true` |

Notifications we send (no `id`, compact `{m, p}` form):

- `v.oai.hid` — key events: `{k, act, ag?}`
- `v.oai.rad` — joystick: `{a, d}` (angle, distance 0–1)

### Keycodes (`k` in `v.oai.hid`)

The `KV_OAI_*` configurator codes with the prefix stripped:

- `AG00`–`AG05` — agent/thread keys (also carry per-slot lighting)
- `ACT06`–`ACT12` — action keys (`ACT10` is the wide push-to-talk mic; `ACT12` is submit)
- `ENC_CW` / `ENC_CC` / `ENC_CLK` — encoder clockwise / counter-clockwise / click

### The `act` field (another gotcha)

- `0` = release, `1` = press
- `2` = **encoder rotation tick**. The app only advances reasoning depth on
  `ENC_CW`/`ENC_CC` when `act === 2` (mapping them to ArrowUp/ArrowDown); it
  ignores those keys with act 0/1. Send one `act: 2` event per detent, not a
  press/release pair.

### Lighting / state colors

The app pushes packed-RGB colors per slot via `v.oai.thstatus`; the backend
paints what it receives. Values from the app's own status→color function (see
`src/states.js`):

| State | App status | Packed RGB |
| --- | --- | --- |
| idle | `idle` | `0xFFFFFF` white |
| thinking | `working` | `0x304FFE` blue |
| complete | `unread` | `0x00FF4C` green |
| needs input | `awaiting-*` | `0xFF6D00` amber |
| error | `error`/`failed` | `0xFF0033` pink |

Agent keys "follow" tasks by a source mode (recent / priority / pinned / custom);
an unassigned slot is `off`.

### Keycaps

The action-key catalogue (id, icon, default command) is in `src/keycaps.js`,
recovered from the app's `codex-micro-layout` module. The app renders these with
OpenAI's proprietary icons, which we do **not** ship — each maps to a
visually-equivalent [Lucide](https://lucide.dev) (ISC) icon by the same name.

## Stream Deck backend (v7 API notes)

`@elgato-stream-deck/node` v7 uses a `CONTROLS` model — there is no `NUM_KEYS` or
`ICON_SIZE`. Read `deck.CONTROLS` and filter by `type` (`button` / `encoder` /
`lcd-segment`); each carries its own `index`, `pixelSize`, etc. Both key and dial
presses arrive via `down`/`up` with a control object (there is no
`encoderDown`/`encoderUp`); rotation is the `rotate` event. `fillLcdRegion` takes
`(lcdIndex, x, y, buffer, options)`.

## Testing

```bash
npm test
```

- `test/framing.test.mjs` — the no-newline / multi-report / back-to-back JSON
  reassembly (the timeout bug).
- `test/selftest.mjs` — full JSON-RPC handshake over a loopback transport, with
  the fake host sending bare JSON like the real app.
- `test/shim.test.mjs` — the real shim (`patch.cjs`) round-tripping over an actual
  Unix socket.
- `test/streamdeck.test.mjs` — input mapping (dial rotation `act: 2`, dial
  presses, key→keycode) without hardware.

## Project status

| Piece | State |
| --- | --- |
| JSON-RPC protocol + framing | ✅ verified by `npm test` and in the real app |
| Shim mode end-to-end | ✅ working (keys, dials, lighting, presses) |
| Native helper compiles (real SDK) | ✅ builds with `swiftc` |
| Helper virtual device at runtime | ⚠️ blocked on the Apple entitlement |

## Reverse-engineering notes

The protocol was recovered from two apps on macOS:

- **Work Louder configurator** (`input.app`) — bundles `@worklouder/wl-device-kit`
  with source maps; source of the framing, discovery, and RPC client.
- **ChatGPT app** — bundles `@worklouder/device-kit-oai` and a
  `codex-micro-service` plus webview modules; source of the OAI vendor methods,
  keycodes, state colors, keycap layout, and the `act: 2` encoder behavior.

Nothing from either app is redistributed here.
