# codex-micro-emulator

Use an **Elgato Stream Deck** as a **Codex Micro** — the Work Louder × OpenAI
macro pad for the ChatGPT desktop app. The ChatGPT app sees your Stream Deck as
the real device: agent keys light up with your tasks' status, the action keys run
Codex commands, and a dial controls how deeply the agent thinks.

Best on a **Stream Deck +** (it has the dial), but any model works.

> Not affiliated with OpenAI, Work Louder, or Elgato. "Codex", "Stream Deck", and
> "Work Louder" are trademarks of their owners. This is an interoperability
> project for people who own the hardware. See [Legal](#legal).

## Requirements

- macOS
- Node.js ≥ 18
- An Elgato Stream Deck
- The ChatGPT desktop app (with the Codex Micro integration)

## Get started

```bash
npm install
```

You run two things: a **bridge** (the long-running process that talks to your
Stream Deck) and the **ChatGPT app launched with a small shim** so it detects the
virtual device.

**1. Start the bridge:**

```bash
node bin/codex-micro-emulator.js --mode shim
```

**2. In another terminal, launch ChatGPT with the shim:**

```bash
./shim/launch-chatgpt.sh
```

This quits any running ChatGPT, then relaunches it so it picks up the shim. The
app should now detect a "Codex Micro", and your Stream Deck comes to life.

> The shim works by injecting a tiny module into the ChatGPT app at launch (no
> app files are modified). It's meant for personal use on your own machine and
> may break when the app updates. There's also a cleaner "helper mode" that needs
> an Apple entitlement — see [DEVELOPMENT.md](./DEVELOPMENT.md).

To try it without a Stream Deck plugged in, add `--input keyboard` to the bridge
and drive it from the terminal.

## Using your Stream Deck +

```
┌─────────┬─────────┬─────────┬─────────┐
│ agent 1 │ agent 2 │ agent 3 │ agent 4 │   top row  → your Codex tasks (status colors)
├─────────┼─────────┼─────────┼─────────┤
│  Fast   │ Approve │ Reject  │  Split  │   bottom row → action keys
└─────────┴─────────┴─────────┴─────────┘
    dial 1        dial 2       dial 3
  reasoning     push-to-talk   submit
   (rotate)       (press)      (press)
```

- **Top row — agent keys:** each follows one of your Codex tasks. Press one to
  jump to that task; the color shows its state (see below). They start as blank
  cream keycaps until you assign tasks (next section).
- **Bottom row — action keys:** Fast mode, Approve, Reject, Split — with icons.
- **Dial 1 (rotate):** reasoning depth — right = deeper, left = shallower. Press
  it to click.
- **Dial 2 (press):** hold to talk (push-to-talk mic).
- **Dial 3 (press):** submit.
- **LCD strip:** labels the three dials.

### Making the agent keys light up

The agent keys **follow your Codex tasks**, and you choose which ones. In the app,
open **Codex Micro settings → Agent keys** and either:

- pick a mode (**recent / priority / pinned**) to auto-follow those tasks, or
- choose **custom** and assign a specific task to each key.

Once a key follows an active task, its color tracks the task state:

| State        | Color   |
| ------------ | ------- |
| idle         | white   |
| thinking     | blue    |
| complete     | green   |
| needs input  | amber   |
| error        | pink    |

Your Plus shows four agent keys (the first four slots); the real device has six.

## Troubleshooting

| Symptom | Try this |
| --- | --- |
| ChatGPT doesn't detect the device | Start the bridge **first**, then launch via `./shim/launch-chatgpt.sh`. Opening ChatGPT normally from the Dock won't load the shim. |
| Keys/colors don't respond, app logs `TIMEOUT` | Restart the bridge, then relaunch the app so it reconnects. |
| Agent keys stay blank | Assign tasks to them in Codex Micro settings (see above). They only color when a followed task is active. |
| Dial turns the wrong way | Edit `_onRotate` in `src/streamdeck.js` (or open an issue). |
| No icons, just solid colors | `sharp` / `lucide-static` failed to install — re-run `npm install`. The bridge still works without them. |

For anything deeper, run the bridge with `--verbose` and check `shim.log`.

## Customizing

- **Key layout, dial roles:** `src/mapping.js`
- **Which icon each action key shows:** `src/keycaps.js` (or drop SVGs in
  `assets/icons/`)
- **Colors:** `src/states.js`

## Contributing

Internals, protocol details, the macOS entitlement path, and how this was built
are in **[DEVELOPMENT.md](./DEVELOPMENT.md)**. Tests: `npm test`.

## Legal

For **interoperability and personal use** by people who already own the hardware.
Ships no OpenAI, Work Louder, or Elgato code or assets — only an independent
reimplementation of the wire protocol and a mapping to open-licensed
[Lucide](https://lucide.dev) icons. Trademarks belong to their owners. MIT
licensed; use at your own risk.
