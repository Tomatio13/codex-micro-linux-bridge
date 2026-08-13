// Preload entry point for the node-hid shim.
//
// Injected into the ChatGPT app's main process via:
//   NODE_OPTIONS="--require /abs/path/to/shim/preload.cjs"
//
// It installs the require hook (see patch.cjs) so the app enumerates and opens
// the virtual Codex Micro, bridged over a Unix socket to the external emulator.
// Set CODEX_MICRO_SOCKET to match the bridge's --socket, and optionally
// CODEX_MICRO_SHIM_LOG to a writable file for diagnostics.

const { installHook, defaultSocketPath } = require("./patch.cjs");

function overlayLog(message) {
  const line = "[codex-micro-shim] " + message + "\n";
  try { process.stderr.write(line); } catch {}
  const logPath = process.env.CODEX_MICRO_SHIM_LOG;
  if (!logPath) return;
  try {
    require("node:fs").appendFileSync(logPath, "[" + new Date().toISOString() + "] " + line);
  } catch {}
}

function installRendererOverlayHook() {
  const overlayUrl = process.env.CODEX_MICRO_RENDERER_URL;
  if (!overlayUrl) return;

  // Electron is not resolvable while NODE_OPTIONS is loading a preload.
  // Install the BrowserWindow patch only after Electron itself is requested.
  const Module = require("node:module");
  const originalLoad = Module._load;
  let patched = false;
  Module._load = function(request, parent, isMain) {
    const result = originalLoad.apply(this, arguments);
    if (request === "electron" && !patched) {
      patched = true;
      const BrowserWindow = result && result.BrowserWindow;
      if (!BrowserWindow || !BrowserWindow.prototype || typeof BrowserWindow.prototype.loadURL !== "function") {
        overlayLog("Electron BrowserWindow.loadURL is unavailable");
        return result;
      }
      const originalLoadURL = BrowserWindow.prototype.loadURL;
      let redirected = false;
      BrowserWindow.prototype.loadURL = function(url, ...args) {
        overlayLog("loadURL " + String(url));
        if (!redirected && typeof url === "string" && (url.includes("/webview/index.html") || url.includes("app://-/index.html"))) {
          redirected = true;
          overlayLog("redirecting packaged webview to " + overlayUrl);
          return originalLoadURL.call(this, overlayUrl, ...args);
        }
        return originalLoadURL.call(this, url, ...args);
      };
      overlayLog("Electron BrowserWindow hook installed");
    }
    return result;
  };
}

try {
  const socketPath = defaultSocketPath();
  installHook({ socketPath });
  installRendererOverlayHook();
} catch (err) {
  // Never take the host app down if the shim fails to install.
  try {
    process.stderr.write(`[codex-micro-shim] install failed: ${err && err.stack}\n`);
  } catch {
    /* ignore */
  }
}
