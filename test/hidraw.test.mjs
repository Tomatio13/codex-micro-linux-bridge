import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findCodexMicroHidraw,
  HidrawTransport,
  normaliseHidrawFrame,
  ReconnectingHidrawTransport,
} from "../src/transports/hidraw.js";
import { RawBridge } from "../src/raw-bridge.js";
import { REPORT_ID, REPORT_SIZE } from "../src/framing.js";

class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(report) {
    this.writes.push(Buffer.from(report));
  }
}

test("Codex Micro discovery accepts Bluetooth HID and selects its hidraw node", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-micro-sysfs-"));
  const device = path.join(root, "hidraw7", "device");
  mkdirSync(device, { recursive: true });
  writeFileSync(
    path.join(device, "uevent"),
    "HID_ID=0005:0000303A:00008360\nHID_NAME=Codex Micro #1\n",
  );

  try {
    assert.equal(
      findCodexMicroHidraw({ sysfsRoot: root, devRoot: "/devices" }),
      "/devices/hidraw7",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hidraw report normalization restores a stripped report ID", () => {
  const payload = Buffer.alloc(REPORT_SIZE - 1, 0);
  payload[0] = 2;
  const frame = normaliseHidrawFrame(payload);
  assert.equal(frame.length, REPORT_SIZE);
  assert.equal(frame[0], REPORT_ID);
  assert.equal(frame[1], 2);
});

test("hidraw report normalization pads short Bluetooth reports", () => {
  const withId = normaliseHidrawFrame(Buffer.from([REPORT_ID, 2, 1, 0x7b]));
  assert.equal(withId.length, REPORT_SIZE);
  assert.deepEqual([...withId.subarray(0, 4)], [REPORT_ID, 2, 1, 0x7b]);

  const stripped = normaliseHidrawFrame(Buffer.from([2, 1, 0x7b]));
  assert.equal(stripped.length, REPORT_SIZE);
  assert.deepEqual([...stripped.subarray(0, 4)], [REPORT_ID, 2, 1, 0x7b]);
});

test("closing hidraw ignores a late stream error from the discarded descriptor", () => {
  const stream = new EventEmitter();
  stream.destroy = () => stream.emit("error", Object.assign(new Error("closed"), { code: "EBADF" }));
  let synchronousCloses = 0;
  const fsApi = {
    openSync: () => 42,
    createReadStream: () => stream,
    closeSync: () => {
      synchronousCloses += 1;
    },
  };
  const hidraw = new HidrawTransport("/dev/hidraw-test", { fsApi });
  let errors = 0;
  hidraw.on("error", () => {
    errors += 1;
  });
  hidraw.open();
  hidraw.close();
  assert.equal(errors, 0);
  assert.equal(synchronousCloses, 0);
});

test("raw bridge forwards reports in both directions and can detach", () => {
  const host = new FakeTransport();
  const device = new FakeTransport();
  const bridge = new RawBridge(host, device);
  const frame = Buffer.alloc(REPORT_SIZE, 0);
  frame[0] = REPORT_ID;

  host.emit("report", frame);
  device.emit("report", frame);
  assert.deepEqual(device.writes, [frame]);
  assert.deepEqual(host.writes, [frame]);

  bridge.dispose();
  host.emit("report", frame);
  assert.equal(device.writes.length, 1);
});

test("physical transport rediscovers a renumbered hidraw node after disconnect", () => {
  const paths = ["/dev/hidraw5", "/dev/hidraw7"];
  const transports = [];
  const timers = [];
  const opened = [];
  const disconnected = [];

  class FakeHidraw extends FakeTransport {
    constructor(devicePath) {
      super();
      this.devicePath = devicePath;
      this.closed = false;
    }

    open() {}

    close() {
      this.closed = true;
    }
  }

  const physical = new ReconnectingHidrawTransport({
    discover: () => paths.shift(),
    createTransport: (devicePath) => {
      const transport = new FakeHidraw(devicePath);
      transports.push(transport);
      return transport;
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
  });
  physical.on("open", (devicePath) => opened.push(devicePath));
  physical.on("disconnect", (devicePath) => disconnected.push(devicePath));

  physical.open();
  physical.write(Buffer.from([1]));
  assert.deepEqual(opened, ["/dev/hidraw5"]);
  assert.deepEqual(transports[0].writes, [Buffer.from([1])]);

  transports[0].emit("close");
  assert.equal(transports[0].closed, true);
  assert.deepEqual(disconnected, ["/dev/hidraw5"]);
  assert.equal(timers.length, 1);

  timers.shift()();
  physical.write(Buffer.from([2]));
  assert.deepEqual(opened, ["/dev/hidraw5", "/dev/hidraw7"]);
  assert.deepEqual(transports[1].writes, [Buffer.from([2])]);

  physical.close();
  assert.equal(transports[1].closed, true);
});

test("physical transport keeps retrying while Codex Micro is absent", () => {
  const timers = [];
  let attempts = 0;
  const waiting = [];
  const physical = new ReconnectingHidrawTransport({
    discover: () => {
      attempts += 1;
      throw new Error("not found");
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
  });
  physical.on("waiting", (err) => waiting.push(err.message));

  physical.open();
  assert.equal(attempts, 1);
  assert.deepEqual(waiting, ["not found"]);
  assert.equal(physical.write(Buffer.from([1])), 0);

  timers.shift()();
  assert.equal(attempts, 2);
  assert.equal(timers.length, 1);
  assert.deepEqual(waiting, ["not found"]);

  physical.close();
});
