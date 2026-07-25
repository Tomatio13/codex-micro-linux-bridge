#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { CodexMicroEmulator } from "../src/emulator.js";
import { Link } from "../src/link.js";
import { SocketTransport } from "../src/transports/socket.js";
import { SocketServerTransport } from "../src/transports/socket-server.js";
import { StreamDeckBackend } from "../src/streamdeck.js";
import { KeyboardInput } from "../src/keyboard-input.js";
import { ReconnectingHidrawTransport } from "../src/transports/hidraw.js";
import { RawBridge } from "../src/raw-bridge.js";

const DEFAULT_SOCKET = path.join(os.tmpdir(), "codex-micro-vhid.sock");
const DEFAULT_MODE = process.platform === "linux" ? "shim" : "helper";

function parseArgs(argv) {
  const opts = {
    input: "streamdeck",
    mode: DEFAULT_MODE,
    socket: DEFAULT_SOCKET,
    device: null,
    battery: 100,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") opts.input = argv[++i];
    else if (a === "--mode") opts.mode = argv[++i];
    else if (a === "--socket") opts.socket = argv[++i];
    else if (a === "--device") opts.device = argv[++i];
    else if (a === "--battery") opts.battery = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      opts.help = true;
    }
  }
  if (!new Set(["helper", "shim"]).has(opts.mode)) {
    throw new Error(`Invalid --mode value: ${opts.mode}. Expected helper or shim.`);
  }
  if (!new Set(["streamdeck", "keyboard", "codex-micro"]).has(opts.input)) {
    throw new Error(
      `Invalid --input value: ${opts.input}. Expected streamdeck, keyboard, or codex-micro.`,
    );
  }
  if (!Number.isFinite(opts.battery) || opts.battery < 0 || opts.battery > 100) {
    throw new Error(`Invalid --battery value: ${opts.battery}. Expected a number from 0 to 100.`);
  }
  return opts;
}

function usage() {
  console.log(`codex-micro-emulator — present a virtual Codex Micro backed by a Stream Deck

Usage:
  codex-micro-emulator [options]

Options:
  --mode <helper|shim>           How the app reaches us (default: ${DEFAULT_MODE})
                                   helper: connect to the native virtual-HID helper
                                   shim:   listen for the in-app node-hid shim
  --input <source>               streamdeck, keyboard, or codex-micro
                                 (default: streamdeck)
  --device </dev/hidrawN>        Real Codex Micro path (default: auto-detect)
  --socket <path>                Unix socket path (default: ${DEFAULT_SOCKET})
  --battery <0-100>              Reported battery level (default: 100)
  -v, --verbose                  Log every RPC request/response
  -h, --help                     Show this help

helper mode: start the platform helper first (it owns the virtual USB HID
device). shim mode: start this bridge first, then launch the app via
shim/launch-chatgpt.sh (macOS) or shim/launch-chatgpt-linux.sh (Linux).
See the README.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // Transport: either connect to the native helper (helper mode) or listen for
  // the in-app node-hid shim to connect (shim mode).
  let transport;
  if (opts.mode === "shim") {
    transport = new SocketServerTransport(opts.socket);
    try {
      await transport.listen();
    } catch (err) {
      console.error(`Could not listen on ${opts.socket}: ${err.message}`);
      process.exit(1);
    }
    transport.on("open", () => console.error("Shim connected."));
    transport.on("client-close", () => console.error("Shim disconnected (waiting for reconnect)."));
    console.error(`Listening for the node-hid shim on ${opts.socket}.`);
    const launcher = process.platform === "linux"
      ? "./shim/launch-chatgpt-linux.sh"
      : "./shim/launch-chatgpt.sh";
    console.error(`Now launch the app:  ${launcher}`);
  } else {
    transport = new SocketTransport(opts.socket);
    try {
      await transport.connect();
    } catch (err) {
      console.error(`Could not connect to the virtual-HID helper at ${opts.socket}.`);
      console.error(`Is it running?  ${err.message}`);
      process.exit(1);
    }
    console.error(`Connected to virtual-HID helper at ${opts.socket}.`);
  }
  // Input source.
  let input;
  let link;
  if (opts.input === "codex-micro") {
    const physical = new ReconnectingHidrawTransport({ devicePath: opts.device });
    physical.on("open", (devicePath) => console.error(`Physical Codex Micro ready at ${devicePath}.`));
    physical.on("disconnect", (devicePath, err) => {
      const detail = err ? `: ${err.message}` : "";
      console.error(`Physical Codex Micro disconnected from ${devicePath}${detail}`);
    });
    physical.on("waiting", (err) => {
      console.error(`Waiting for physical Codex Micro: ${err.message}`);
    });
    physical.open();
    link = new RawBridge(transport, physical);
    link.on("error", (err) => console.error(`Codex Micro bridge error: ${err.message}`));
    input = physical;
  } else {
    const emulator = new CodexMicroEmulator({ battery: opts.battery });
    if (opts.verbose) {
      emulator.on("request", ({ method, id }) => console.error(`[rpc] <- ${method} (id ${id})`));
      emulator.on("send", (line) => console.error(`[rpc] -> ${line.trim()}`));
      emulator.on("log", (level, ...args) => console.error(`[${level}]`, ...args));
      emulator.on("lighting", (m) => console.error("[lighting]", JSON.stringify(m)));
    }
    link = new Link(emulator, transport);

    if (opts.input === "keyboard") {
      input = new KeyboardInput(emulator);
      input.start();
    } else {
      const backend = new StreamDeckBackend(emulator);
      try {
        await backend.start();
        console.error("Stream Deck ready.");
      } catch (err) {
        console.error(`Stream Deck backend failed: ${err.message}`);
        console.error("Tip: retry with `--input keyboard` to test without hardware.");
        process.exit(1);
      }
      input = backend;
    }
  }

  const shutdown = async () => {
    console.error("\nShutting down…");
    if (opts.input === "codex-micro") {
      // Closing an active hidraw or shim socket can block during teardown.
      // Process exit releases both; the next start removes any stale socket.
      process.exit(0);
    }

    link.dispose?.();
    transport.close();
    try {
      await input.stop?.();
      input.close?.();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { parseArgs, DEFAULT_MODE, DEFAULT_SOCKET, fileURLToPath };
