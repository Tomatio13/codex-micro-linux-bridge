import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { REPORT_ID, REPORT_SIZE } from "../framing.js";
import { USB } from "../protocol.js";

const DEFAULT_SYSFS_ROOT = "/sys/class/hidraw";
const DEFAULT_DEV_ROOT = "/dev";

/**
 * Find the vendor-defined Codex Micro hidraw interface exposed by Linux.
 *
 * Bus 0003 is USB HID and bus 0005 is Bluetooth HID. Matching HID_ID avoids
 * selecting the keyboard or consumer-control interfaces of the composite
 * device and works for Bluetooth devices backed by Linux uhid.
 */
export function findCodexMicroHidraw({
  sysfsRoot = DEFAULT_SYSFS_ROOT,
  devRoot = DEFAULT_DEV_ROOT,
  fsApi = fs,
} = {}) {
  let entries;
  try {
    entries = fsApi.readdirSync(sysfsRoot).filter((entry) => entry.startsWith("hidraw")).sort();
  } catch (err) {
    throw new Error(`Cannot inspect ${sysfsRoot}: ${err.message}`);
  }

  const vendor = USB.VENDOR_ID.toString(16).toUpperCase().padStart(8, "0");
  const product = USB.PRODUCT_ID.toString(16).toUpperCase().padStart(8, "0");
  const expected = new RegExp(`^HID_ID=000[35]:${vendor}:${product}$`, "m");

  for (const entry of entries) {
    const ueventPath = path.join(sysfsRoot, entry, "device", "uevent");
    try {
      if (expected.test(fsApi.readFileSync(ueventPath, "utf8"))) {
        return path.join(devRoot, entry);
      }
    } catch {
      // A disappearing device is normal during Bluetooth reconnects.
    }
  }

  throw new Error(
    "Codex Micro vendor HID interface not found (expected VID 303A, PID 8360 over USB or Bluetooth).",
  );
}

/** Convert a Linux hidraw packet into the bridge's fixed 64-byte frame. */
export function normaliseHidrawFrame(packet) {
  const buf = Buffer.from(packet);
  if (buf.length === REPORT_SIZE) return buf;
  if (buf.length === 0 || buf.length > REPORT_SIZE) {
    throw new Error(`Unexpected Codex Micro HID report length: ${buf.length}`);
  }

  const frame = Buffer.alloc(REPORT_SIZE);
  if (buf[0] === REPORT_ID) {
    buf.copy(frame);
  } else {
    frame[0] = REPORT_ID;
    buf.copy(frame, 1);
  }
  return frame;
}

/**
 * Bidirectional transport for the real Codex Micro vendor hidraw interface.
 */
export class HidrawTransport extends EventEmitter {
  constructor(devicePath, { fsApi = fs } = {}) {
    super();
    this.devicePath = devicePath;
    this.fs = fsApi;
    this.fd = null;
    this.stream = null;
  }

  open() {
    if (this.fd !== null) return;
    this.fd = this.fs.openSync(this.devicePath, "r+");
    const stream = this.fs.createReadStream(this.devicePath, {
      fd: this.fd,
      autoClose: true,
      highWaterMark: REPORT_SIZE,
    });
    this.stream = stream;
    stream.on("data", (packet) => {
      if (this.stream !== stream) return;
      try {
        this.emit("report", normaliseHidrawFrame(packet));
      } catch (err) {
        this.emit("error", err);
      }
    });
    stream.on("error", (err) => {
      if (this.stream === stream) this.emit("error", err);
    });
    stream.on("close", () => {
      if (this.stream === stream) this.emit("close");
    });
    this.emit("open");
  }

  write(packet) {
    if (this.fd === null) throw new Error("Codex Micro hidraw device is not open.");
    const frame = normaliseHidrawFrame(packet);
    const written = this.fs.writeSync(this.fd, frame, 0, frame.length);
    if (written !== frame.length) {
      throw new Error(`Short write to ${this.devicePath}: ${written}/${frame.length} bytes`);
    }
  }

  close() {
    if (this.fd === null) return;
    const fd = this.fd;
    const stream = this.stream;
    this.fd = null;
    this.stream = null;
    if (stream) {
      // The stream owns the descriptor. destroy() closes it asynchronously,
      // avoiding a blocking closeSync while hidraw has a pending read.
      stream.destroy();
    } else {
      try {
        this.fs.closeSync(fd);
      } catch (err) {
        if (err?.code !== "EBADF" && err?.code !== "ENODEV") throw err;
      }
    }
  }
}

/**
 * Keep a physical Codex Micro attached across Bluetooth disconnects.
 *
 * BlueZ destroys and recreates the hidraw node when the keyboard reconnects,
 * often under a different number. This wrapper discards the stale transport,
 * periodically rediscovers the vendor interface, and exposes one stable
 * transport to RawBridge.
 */
export class ReconnectingHidrawTransport extends EventEmitter {
  constructor({
    devicePath = null,
    retryIntervalMs = 1000,
    discover = findCodexMicroHidraw,
    createTransport = (currentPath) => new HidrawTransport(currentPath),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    super();
    this.devicePath = devicePath;
    this.retryIntervalMs = retryIntervalMs;
    this.discover = discover;
    this.createTransport = createTransport;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.transport = null;
    this.currentPath = null;
    this.retryTimer = null;
    this.running = false;
    this.lastWaitingMessage = null;
  }

  open() {
    if (this.running) return this.currentPath;
    this.running = true;
    this._connect();
    return this.currentPath;
  }

  _connect() {
    if (!this.running || this.transport) return;

    let currentPath;
    try {
      currentPath = this.devicePath ?? this.discover();
      const transport = this.createTransport(currentPath);
      this.transport = transport;
      this.currentPath = currentPath;
      this._attach(transport);
      transport.open();
      this.lastWaitingMessage = null;
      this.emit("open", currentPath);
    } catch (err) {
      this._discardTransport(this.transport);
      this._waitForReconnect(err);
    }
  }

  _attach(transport) {
    transport.__reconnectingHandlers = {
      report: (report) => this.emit("report", report),
      error: (err) => this._handleDisconnect(transport, err),
      close: () => this._handleDisconnect(transport),
    };
    for (const [event, handler] of Object.entries(transport.__reconnectingHandlers)) {
      transport.on(event, handler);
    }
  }

  _detach(transport) {
    if (!transport?.__reconnectingHandlers) return;
    for (const [event, handler] of Object.entries(transport.__reconnectingHandlers)) {
      transport.off?.(event, handler);
    }
    delete transport.__reconnectingHandlers;
  }

  _handleDisconnect(transport, err) {
    if (transport !== this.transport) return;
    const disconnectedPath = this.currentPath;
    this._discardTransport(transport);
    this.emit("disconnect", disconnectedPath, err ?? null);
    this._waitForReconnect(err);
  }

  _discardTransport(transport) {
    if (!transport) return;
    this._detach(transport);
    if (transport === this.transport) {
      this.transport = null;
      this.currentPath = null;
    }
    try {
      transport.close();
    } catch {
      // The kernel may already have invalidated the old hidraw descriptor.
    }
  }

  _waitForReconnect(err) {
    if (!this.running || this.retryTimer) return;
    const message = err?.message ?? "Codex Micro is disconnected.";
    if (message !== this.lastWaitingMessage) {
      this.lastWaitingMessage = message;
      this.emit("waiting", err ?? new Error(message));
    }
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this._connect();
    }, this.retryIntervalMs);
  }

  write(packet) {
    // The desktop retries its startup RPCs while the keyboard is absent. Drop
    // those stale requests quietly; the waiting/disconnect events already
    // describe the state transition, and fresh RPCs arrive after reconnect.
    if (!this.transport) return 0;
    try {
      return this.transport.write(packet);
    } catch (err) {
      this._handleDisconnect(this.transport, err);
      throw err;
    }
  }

  close() {
    this.running = false;
    if (this.retryTimer) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = null;
    this._discardTransport(this.transport);
  }
}
