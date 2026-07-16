# codex-micro-emulator

Turn an **Elgato Stream Deck** into a **Codex Micro** — the Work Louder × OpenAI
macro pad — so the ChatGPT desktop app treats your Stream Deck as the real
hardware: agent keys that light up with thread state, action keys with the Codex
commands, and the dial that controls how deeply the agent thinks.

> Not affiliated with, endorsed by, or sponsored by OpenAI, Work Louder, or
> Elgato. "Codex", "Stream Deck", and "Work Louder" are trademarks of their
> respective owners. This is an interoperability project for people who own the
> hardware and want to use a Stream Deck instead. See [Legal](#legal).

## How it works

The ChatGPT app discovers a Codex Micro over USB HID (vendor `0x303A`, product
`0x8360`, vendor usage page `0xFF00`) and talks to it in newline-delimited
JSON-RPC 2.0 over 64-byte HID reports. A Stream Deck can't _be_ that device at
the USB level, so we present a **virtual** Codex Micro and bridge it to your real
Stream Deck:

```
 ChatGPT app ──USB──▶ virtual HID device ──▶ native helper ──socket──▶  Node bridge  ──USB──▶ Stream Deck
 (unmodified)         (IOKit, VID 0x303A)     (Swift, dumb pump)         (all the logic)       (your hardware)
      ▲                                                                        │
      └──────────────── v.oai.hid key events / thread-state lighting ──────────┘
```

- **`native/CodexMicroVirtualHID`** — a tiny Swift helper that creates the
  virtual HID device via `IOHIDUserDevice` and pumps raw 64-byte reports over a
  Unix socket. No protocol knowledge; you rarely touch it.
- **`src/`** — all the interesting logic in JS: the JSON-RPC emulator, the Stream
  Deck bridge, the keycap/color mapping. This is what contributors edit.

## Requirements

- macOS with the Xcode command line tools (`xcode-select --install`)
- Node.js ≥ 18
- An Elgato Stream Deck (any model; **Stream Deck +** is the best fit — it has
  the dial the Codex Micro's "think depth" encoder maps to)
- The ChatGPT desktop app with the latest update

## Two ways to make the app see the device

The device half can be provided two ways. They share the entire bridge —
emulator, Stream Deck backend, socket protocol — and differ only in how the
ChatGPT app is made to see a Codex Micro.

| | **Shim mode** (works today) | **Helper mode** (proper) |
| --- | --- | --- |
| Mechanism | injects a `node-hid` shim into the app | real IOKit virtual HID device |
| Needs | nothing special | Apple `com.apple.developer.hid.virtual.device` entitlement |
| App files | untouched (env-var injection) | untouched |
| Distributable | no (per-machine) | yes (notarized) |
| Caveat | must launch the app via a wrapper; breaks if the app changes | needs Apple approval + signing |

Use **shim mode** now; switch to **helper mode** once Apple grants the
entitlement (the native helper is already built for it).

### Shim mode (recommended to start)

```bash
npm install                       # optional deps: stream-deck lib, sharp, lucide

# 1) Start the bridge (it listens for the shim):
node bin/codex-micro-emulator.js --mode shim        # add --input keyboard to test hands-free

# 2) In another terminal, launch the app with the shim injected:
./shim/launch-chatgpt.sh
```

The launcher sets `NODE_OPTIONS=--require shim/preload.cjs` and execs the app
binary directly (macOS's `open` won't propagate the env var). Your app's Electron
fuses allow `EnableNodeOptionsEnvironmentVariable`, so this needs no file changes
and doesn't touch the app's signature. Diagnostics go to `shim.log`
(`CODEX_MICRO_SHIM_LOG`). The app should now detect a "Codex Micro".

> Shim mode injects code into the ChatGPT process. It only works because the
> app's fuses permit `NODE_OPTIONS`, and it may break on app updates. It's for
> personal/interoperability use on your own machine.

### Helper mode

```bash
npm run build:native              # compiles the Swift IOKit helper
./scripts/start.sh                # runs helper (needs the entitlement) + bridge
```

To test without a Stream Deck attached, add `--input keyboard` to either mode and
drive it from the terminal. Once running, press keys / turn the dial on your
Stream Deck and watch the app react; start agent tasks and watch the keys change
color.

## Your Stream Deck

The layout adapts to the model automatically (`src/mapping.js`):

- **Stream Deck + (8 keys, 4 dials, LCD)** — top row = agent slots 0–3, bottom
  row = the four core actions (Fast, Approve, Reject, Codex-submit). Agent slots
  4–5 render on the LCD strip. **Dial 0 is the "think depth" encoder**; the other
  three dials are free.
- **15-key decks** — six agent slots + six action keys, matching the hardware.
- Other sizes fall back to a truncated full layout.

Override with `--layout` in code or edit `src/mapping.js`.

### The dial ("how deeply the agent thinks")

Yes, it works. The Codex Micro's knob is a rotary encoder that emits
`ENC_CW` / `ENC_CC` / `ENC_CLK` over `v.oai.hid`. Rotating Stream Deck dial 0
sends those, and the ChatGPT app maps them to reasoning depth exactly as it does
for the real device. Pick a different dial with the `thinkDial` option.

## Agent key colors

These come _from_ the app — it pushes the packed RGB per slot over
`v.oai.thstatus`, and the bridge paints whatever it receives. The values (from
the app's own status→color function) are:

| State        | App status          | Color            |
| ------------ | ------------------- | ---------------- |
| idle         | `idle`              | white `#FFFFFF`  |
| thinking     | `working`           | blue `#304FFE`   |
| complete     | `unread`            | green `#00FF4C`  |
| needs input  | `awaiting-*`        | amber `#FF6D00`  |
| error        | `error`/`failed`    | pink `#FF0033`   |

`src/states.js` documents the mapping (used for the offline/keyboard demo).

## Key icons

The action keys show their Codex glyphs (lightning, check, ✗, branch, mic,
codex…). The ChatGPT app renders these with **OpenAI's proprietary icon set,
which this project does not redistribute.** Instead each key maps to a visually
equivalent [Lucide](https://lucide.dev) icon (ISC licensed) by the same semantic
name — see `src/keycaps.js`. Drop your own SVGs in `assets/icons/` to override.

Icon rendering uses the optional `sharp` + `lucide-static` dependencies. Without
them the bridge still runs and falls back to solid color fills.

## macOS virtual-HID caveats (helper mode)

On macOS 26 (Apple Silicon), creating an `IOHIDUserDevice` is gated by a
**restricted entitlement**, confirmed empirically:

- Running as **root is not sufficient** — `IOHIDUserDeviceCreateWithProperties`
  returns `nil` without the entitlement.
- **Ad-hoc signing the entitlement doesn't work** — AMFI SIGKILLs the process at
  launch (exit 137). The entitlement is only honored from a genuine Apple-issued
  provisioning profile.

So helper mode needs `com.apple.developer.hid.virtual.device`, granted by Apple:

1. Request it at the Apple entitlement form — the dropdown option is literally
   **"Virtual HID"** (= `com.apple.developer.hid.virtual.device`).
2. Create an App ID with that capability and a Developer ID provisioning profile
   embedding it. A standalone CLI can't carry a profile, so wrap the helper in a
   minimal background `.app` bundle (embeds `embedded.provisionprofile`).
3. Sign (Developer ID + `entitlements.plist.template`), notarize, staple.

The helper prints this guidance itself if creation fails. There's no pure-
userspace way to present a real IOKit HID device — which is exactly why **shim
mode** exists as the no-entitlement alternative.

If Apple's reviewer steers you to DriverKit instead, the equivalent set is
`com.apple.developer.driverkit` + `com.apple.developer.driverkit.transport.hid`
(a larger build); prefer the Virtual HID entitlement since the existing helper
already targets it.

## Development

```bash
npm test        # protocol self-test over an in-memory loopback (no hardware)
```

The self-test stands up the emulator behind a loopback transport and plays the
role of the ChatGPT app, asserting the JSON-RPC handshake, lighting events, key
notifications, and multi-report reassembly. It's the fastest way to iterate on
the protocol without a Stream Deck or the virtual device.

### Project status

| Piece                              | State                                        |
| ---------------------------------- | -------------------------------------------- |
| JSON-RPC protocol + framing        | ✅ verified by `npm test`                    |
| node-hid shim (discovery + I/O)    | ✅ verified by `npm test` (real socket)      |
| Native helper compiles (real SDK)  | ✅ builds with `swiftc`                       |
| Shim end-to-end in the real app    | ⚠️ needs your Mac + the ChatGPT app          |
| Helper virtual device at runtime   | ⚠️ blocked on the Apple entitlement          |
| Stream Deck keys/dial/LCD          | ⚠️ needs the physical device to validate     |

The protocol layer, the shim's device emulation, and the native build are
validated here; the remaining paths want on-device testing — PRs welcome.

## Legal

This project exists for **interoperability and personal use** by people who
already own a Codex Micro and/or a Stream Deck. It ships no OpenAI, Work Louder,
or Elgato code or assets — only an independent reimplementation of the wire
protocol (reverse-engineered for compatibility) and a mapping to open-licensed
Lucide icons. Trademarks belong to their owners. Provided "as is" under the MIT
License; use at your own risk.
