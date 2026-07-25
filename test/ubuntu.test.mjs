import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

test("Ubuntu shell launchers pass bash syntax validation", () => {
  for (const script of [
    "native/build.sh",
    "native/CodexMicroVirtualHIDLinux/build.sh",
    "shim/launch-chatgpt-linux-forced.sh",
    "shim/launch-chatgpt-linux.sh",
    "scripts/install-user-service.sh",
    "scripts/start-linux.sh",
    "scripts/uninstall-user-service.sh",
  ]) {
    const result = run("bash", ["-n", script]);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("systemd user service installer renders a restartable physical bridge", () => {
  const result = run("bash", ["scripts/install-user-service.sh", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WantedBy=default\.target/);
  assert.match(result.stdout, /Restart=on-failure/);
  assert.match(result.stdout, /KillSignal=SIGKILL/);
  assert.match(result.stdout, /SuccessExitStatus=SIGKILL/);
  assert.match(result.stdout, /--mode shim --input codex-micro --verbose/);
  assert.match(result.stdout, /WorkingDirectory=\/.*codex-micro-linux-bridge/);
  assert.doesNotMatch(result.stdout, /@PROJECT_ROOT@|@NODE_BIN@/);
  assert.doesNotMatch(result.stdout, /PrivateTmp=true/i);
});

test("systemd user service installer rejects an unsafe Node path", () => {
  const result = run("bash", ["scripts/install-user-service.sh", "--dry-run"], {
    env: { ...process.env, CODEX_MICRO_NODE: "relative/node" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /absolute path/);
});

test("forced Codex Micro launcher uses a temporary patched webview", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "codex-micro-forced-state-"));
  const webview = mkdtempSync(path.join(os.tmpdir(), "codex-micro-webview-"));
  const assets = path.join(webview, "assets");
  mkdirSync(assets);
  writeFileSync(path.join(webview, "index.html"), "<script type=module src=/assets/app-initial-test.js></script>");
  writeFileSync(path.join(assets, "app-initial-test.js"), "const enabled=Rh(`3207467860`);");
  writeFileSync(
    path.join(assets, "use-visible-settings-sections-test.js"),
    "const visible=check(`3207467860`);",
  );

  const result = run("bash", ["shim/launch-chatgpt-linux-forced.sh", "--dry-run"], {
    env: {
      ...process.env,
      CHATGPT_APP: "/bin/true",
      CHATGPT_WEBVIEW_ROOT: webview,
      XDG_STATE_HOME: state,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /forced launcher dry run/);
  assert.match(result.stdout, /patches: 2/);
  assert.match(result.stdout, /temporary unsupported override/);
});

test("Linux ChatGPT launcher supports a side-effect-free dry run", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "codex-micro-state-"));
  const result = run("bash", ["shim/launch-chatgpt-linux.sh", "--dry-run"], {
    env: { ...process.env, CHATGPT_APP: "/bin/true", XDG_STATE_HOME: state },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex Micro shim/);
  assert.match(result.stdout, /codex-micro-vhid\.sock/);
});

test("Linux ChatGPT launcher accepts only the safe multi-instance option", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "codex-micro-state-"));
  const capture = path.join(state, "capture-args.sh");
  const output = path.join(state, "args.txt");
  writeFileSync(
    capture,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${output}"\n`,
    { mode: 0o755 },
  );

  const result = run("bash", ["shim/launch-chatgpt-linux.sh", "--new-instance"], {
    env: { ...process.env, CHATGPT_APP: capture, XDG_STATE_HOME: state },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "--new-instance\n");

  const invalid = run("bash", ["shim/launch-chatgpt-linux.sh", "--unsafe-option"], {
    env: { ...process.env, CHATGPT_APP: capture, XDG_STATE_HOME: state },
  });
  assert.equal(invalid.status, 2);
});

test("CLI selects shim by default on Linux and rejects invalid modes", { skip: process.platform !== "linux" }, () => {
  const help = run(process.execPath, ["bin/codex-micro-emulator.js", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /default: shim/);

  const invalid = run(process.execPath, ["bin/codex-micro-emulator.js", "--mode", "invalid"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected helper or shim/);
});

test("udev rule does not grant world-writable raw-device access", () => {
  for (const file of ["udev/50-elgato.rules", "udev/60-codex-micro.rules"]) {
    const rule = readFileSync(path.join(root, file), "utf8");
    assert.match(rule, /MODE="0660"/);
    assert.match(rule, /GROUP="plugdev"/);
    assert.doesNotMatch(rule, /MODE="0666"/);
  }
});

test("Codex Micro udev rule covers USB and Bluetooth HID only", () => {
  const rule = readFileSync(path.join(root, "udev/60-codex-micro.rules"), "utf8");
  assert.match(rule, /0003:303A:8360/);
  assert.match(rule, /0005:303A:8360/);
  assert.match(rule, /SUBSYSTEM=="hidraw"/);
});

test("Linux uhid helper compiles with strict warnings", { skip: process.platform !== "linux" }, () => {
  const result = run(process.env.CC || "cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-Werror",
    "-fsyntax-only",
    "native/CodexMicroVirtualHIDLinux/main.c",
  ]);
  assert.equal(result.status, 0, result.stderr);
});
