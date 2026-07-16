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
- The ChatGPT desktop app with the Codex Micro integration enabled

## Quick start

```bash
npm install                       # optional deps: stream-deck lib, sharp, lucide
npm run build:native              # compiles the Swift helper
./scripts/start.sh                # builds if needed, runs helper (sudo) + bridge
```

`start.sh` runs the helper under `sudo` (see [caveats](#macos-virtual-hid-caveats)),
waits for the virtual device, then starts the bridge. To test without a Stream
Deck attached, add `--input keyboard` and drive it from the terminal.

Once running, the ChatGPT app should detect a "Codex Micro". Press keys / turn
the dial on your Stream Deck and watch the app react; start agent tasks and watch
the keys change color.

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

## macOS virtual-HID caveats

Creating an `IOHIDUserDevice` is the one genuinely fiddly part:

1. **Root.** On current macOS the helper almost always needs `sudo`. `start.sh`
   does this for you.
2. **Entitlement.** If creation still fails, macOS wants the
   `com.apple.developer.hid.virtual.device` entitlement on a **signed** binary.
   Request it from Apple, then:
   ```bash
   codesign --sign "Developer ID Application: …" \
     --entitlements native/CodexMicroVirtualHID/entitlements.plist \
     native/CodexMicroVirtualHID/CodexMicroVirtualHID
   ```
   The helper prints this guidance itself if it exits with a creation error.

There is no way around presenting a real IOKit HID device — the app enumerates
via `node-hid`/IOKit and matches on the vendor usage page, so a pure-userspace
shim without the driver won't be seen.

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
| Native helper compiles (real SDK)  | ✅ builds with `swiftc`                       |
| Virtual device created at runtime  | ⚠️ needs your Mac (root/entitlement)         |
| Stream Deck keys/dial/LCD          | ⚠️ needs the physical device to validate     |

The protocol layer and the native build are validated here; the two hardware
paths are wired up but want on-device testing — PRs welcome.

## Legal

This project exists for **interoperability and personal use** by people who
already own a Codex Micro and/or a Stream Deck. It ships no OpenAI, Work Louder,
or Elgato code or assets — only an independent reimplementation of the wire
protocol (reverse-engineered for compatibility) and a mapping to open-licensed
Lucide icons. Trademarks belong to their owners. Provided "as is" under the MIT
License; use at your own risk.
