import { Act, Effect, Keys } from "./protocol.js";
import {
  DEFAULT_LAYOUT,
  layoutForKeyCount,
  overflowSlots,
  resolveKey,
  keycapAt,
  unpackRgb,
} from "./mapping.js";
import { ICON_TO_LUCIDE } from "./keycaps.js";
import { renderKey, canRenderIcons } from "./renderer.js";

// Neutral "light key" background for action keys, matching the hardware's
// white keycaps with dark glyphs.
const ACTION_BG = { r: 236, g: 234, b: 230 };
const OFF_BG = { r: 0, g: 0, b: 0 };

/**
 * Drives a physical Elgato Stream Deck as the Codex Micro's front end:
 *  - key presses  -> v.oai.hid notifications
 *  - dial rotation -> encoder events (the "how deeply the agent thinks" knob)
 *  - host lighting -> per-key state colors (idle/thinking/complete/needs-input/
 *    error) plus action-key icons
 *
 * The layout adapts to the connected model. On a Stream Deck + (8 keys, 4 dials,
 * LCD strip) the six agent slots that don't fit on keys are shown on the LCD.
 *
 * `@elgato-stream-deck/node` is an optional dependency, imported dynamically so
 * the rest of the tool (and the self-test) runs without it or without hardware.
 */
export class StreamDeckBackend {
  /**
   * @param {import("./emulator.js").CodexMicroEmulator} emulator
   * @param {object} [opts]
   * @param {string} [opts.path]      specific device path; otherwise first found
   * @param {Array}  [opts.layout]    key layout (see mapping.js); auto by default
   * @param {number} [opts.thinkDial] which dial drives the think-depth encoder
   */
  constructor(emulator, opts = {}) {
    this.emulator = emulator;
    this.explicitLayout = opts.layout ?? null;
    this.path = opts.path;
    this.thinkDial = opts.thinkDial ?? 0;
    this.deck = null;
    this.layout = opts.layout ?? DEFAULT_LAYOUT;
    this.keySize = 72;
    this.icons = false;
    this.lcdSlots = [];
  }

  async start() {
    let mod;
    try {
      mod = await import("@elgato-stream-deck/node");
    } catch {
      throw new Error(
        "@elgato-stream-deck/node is not installed. Run `npm install` (it is an " +
          "optional dependency) or use --input keyboard to test without hardware.",
      );
    }

    const { openStreamDeck, listStreamDecks } = mod;
    let path = this.path;
    if (!path) {
      const found = await listStreamDecks();
      if (!found.length) throw new Error("No Stream Deck found.");
      path = found[0].path;
    }

    this.deck = await openStreamDeck(path);
    this.keySize = this.deck.ICON_SIZE ?? 72;
    this.icons = await canRenderIcons();

    const numKeys = this.deck.NUM_KEYS ?? this.deck.NUM_BUTTONS ?? DEFAULT_LAYOUT.length;
    this.layout = this.explicitLayout ?? layoutForKeyCount(numKeys);
    this.lcdSlots = overflowSlots(this.layout);

    await this.deck.clearPanel();

    // --- keys -> host notifications ---
    this.deck.on("down", (control) => this._onKey(indexOf(control), Act.PRESS));
    this.deck.on("up", (control) => this._onKey(indexOf(control), Act.RELEASE));

    // --- dials -> think-depth encoder ---
    this.deck.on?.("rotate", (...args) => this._onRotate(...args));
    this.deck.on?.("encoderDown", (...args) => {
      if (encoderIndexOf(args) === this.thinkDial) this.emulator.sendKey(Keys.ENCODER_CLICK, Act.PRESS);
    });
    this.deck.on?.("encoderUp", (...args) => {
      if (encoderIndexOf(args) === this.thinkDial) this.emulator.sendKey(Keys.ENCODER_CLICK, Act.RELEASE);
    });

    // --- LCD touch -> focus an overflow agent slot ---
    this.deck.on?.("lcdShortPress", (...args) => this._onLcdPress(...args));

    // --- host lighting -> keys + LCD ---
    this.emulator.on("lighting", (model) => this._paint(model).catch(() => {}));

    await this._paintStatic();
    return this.deck;
  }

  _onKey(keyIndex, act) {
    if (keyIndex == null) return;
    const resolved = resolveKey(keyIndex, this.layout);
    if (!resolved) return;
    this.emulator.sendKey(resolved.keycode, act, resolved.agent);
  }

  _onRotate(...args) {
    const idx = encoderIndexOf(args);
    if (idx !== this.thinkDial) return;
    const ticks = rotateTicksOf(args);
    const key = ticks >= 0 ? Keys.ENCODER_CW : Keys.ENCODER_CCW;
    for (let i = 0; i < Math.max(1, Math.abs(ticks)); i++) {
      this.emulator.sendKey(key, Act.PRESS);
      this.emulator.sendKey(key, Act.RELEASE);
    }
  }

  _onLcdPress(...args) {
    // Map an LCD touch to whichever overflow slot's segment was pressed.
    const x = lcdXOf(args);
    if (x == null || !this.lcdSlots.length) return;
    const width = this.deck?.LCD_STRIP_SIZE?.width ?? this.deck?.lcdStripSize?.width ?? 800;
    const seg = Math.min(this.lcdSlots.length - 1, Math.floor((x / width) * this.lcdSlots.length));
    const slot = this.lcdSlots[seg];
    this.emulator.sendKey(Keys.AGENT[slot], Act.PRESS, slot);
    this.emulator.sendKey(Keys.AGENT[slot], Act.RELEASE, slot);
  }

  async _paintStatic() {
    for (let i = 0; i < this.layout.length; i++) {
      if (this.layout[i]?.kind === "action") await this._drawAction(i);
    }
  }

  async _paint(model) {
    for (let i = 0; i < this.layout.length; i++) {
      const entry = this.layout[i];
      if (entry?.kind !== "agent") continue;
      const bg = colorFor(model.slots[entry.slot], model);
      await this._fill(i, bg, { dot: dotColor(bg) });
    }
    await this._paintLcd(model);
  }

  async _drawAction(keyIndex) {
    const cap = keycapAt(keyIndex, this.layout);
    const lucide = cap ? ICON_TO_LUCIDE[cap.icon] ?? null : null;
    await this._fill(keyIndex, ACTION_BG, { lucide });
  }

  async _fill(keyIndex, bg, { lucide = null, dot = null } = {}) {
    if (!this.deck) return;
    if (this.icons && (lucide || dot)) {
      const buf = await renderKey({ size: this.keySize, bg, lucide, dot });
      if (buf) {
        try {
          await this.deck.fillKeyBuffer(keyIndex, buf, { format: "rgb" });
          return;
        } catch {
          /* fall through */
        }
      }
    }
    await this.deck.fillKeyColor(keyIndex, bg.r, bg.g, bg.b).catch(() => {});
  }

  /** Draw the overflow agent slots as colored segments on the LCD strip. */
  async _paintLcd(model) {
    if (!this.deck || !this.lcdSlots.length) return;
    if (typeof this.deck.fillLcdRegion !== "function") return;
    const size = this.deck.LCD_STRIP_SIZE ?? this.deck.lcdStripSize;
    if (!size || !this.icons) return; // needs sharp to build the strip buffer

    try {
      const { default: sharp } = await import("sharp");
      const segW = Math.floor(size.width / this.lcdSlots.length);
      for (let i = 0; i < this.lcdSlots.length; i++) {
        const bg = colorFor(model.slots[this.lcdSlots[i]], model);
        const buf = await sharp({
          create: { width: segW, height: size.height, channels: 3, background: bg },
        })
          .removeAlpha()
          .raw()
          .toBuffer();
        await this.deck.fillLcdRegion(i * segW, 0, buf, {
          width: segW,
          height: size.height,
          format: "rgb",
        });
      }
    } catch {
      /* LCD painting is best-effort */
    }
  }

  async stop() {
    if (!this.deck) return;
    try {
      await this.deck.clearPanel();
      await this.deck.close();
    } catch {
      /* ignore */
    }
    this.deck = null;
  }
}

function colorFor(thread, model) {
  if (thread && thread.b !== 0 && thread.e !== Effect.off) return unpackRgb(thread.c ?? 0);
  if (model.ambient && model.ambient.effect !== Effect.off) return unpackRgb(model.ambient.color ?? 0);
  return OFF_BG;
}

function dotColor(bg) {
  const luma = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
  return luma > 30 ? { r: 60, g: 60, b: 80 } : null;
}

// --- event-shape normalisation across @elgato-stream-deck versions ---

function indexOf(control) {
  if (typeof control === "number") return control;
  if (control && typeof control.index === "number") return control.index;
  if (control && typeof control.keyIndex === "number") return control.keyIndex;
  return null;
}

function encoderIndexOf(args) {
  const first = args[0];
  if (typeof first === "number") return first;
  if (first && typeof first.index === "number") return first.index;
  if (first && typeof first.encoderIndex === "number") return first.encoderIndex;
  return 0; // single-encoder / unknown shape -> treat as dial 0
}

function rotateTicksOf(args) {
  // Shapes seen: (index, amount) | (controlObj, amount) | (controlObj{ticks})
  if (typeof args[1] === "number") return args[1];
  const first = args[0];
  if (first && typeof first.ticks === "number") return first.ticks;
  if (first && typeof first.amount === "number") return first.amount;
  return 1;
}

function lcdXOf(args) {
  const first = args[0];
  if (first && typeof first.x === "number") return first.x;
  if (args[1] && typeof args[1].x === "number") return args[1].x;
  return null;
}
