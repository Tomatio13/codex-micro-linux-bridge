#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export const CODEX_MICRO_FEATURE_GATE = "3207467860";

const PATCHABLE_ASSET_PREFIXES = ["app-initial-", "use-visible-settings-sections-"];
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function patchCodexMicroFeatureGate(source) {
  const quotedGate = "([`'\"])" + CODEX_MICRO_FEATURE_GATE + "\\1";
  const standaloneGateCall = new RegExp(
    `(?<![.$\\w])[$A-Z_a-z][$\\w]*\\(\\s*${quotedGate}\\s*\\)`,
    "g",
  );
  let replacements = 0;
  const code = source.replace(standaloneGateCall, () => {
    replacements += 1;
    return "true";
  });
  return { code, replacements };
}

export async function discoverPatchedAssets(webviewRoot, archive = null) {
  const entries = archive == null ? (await readdir(path.join(webviewRoot, "assets"), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name) : archive.filesUnder("webview/assets");
  const patchedAssets = new Map();
  let replacements = 0;
  for (const entryName of entries) {
    const name = archive == null ? entryName : path.posix.basename(entryName);
    if (!name.endsWith(".js") || !PATCHABLE_ASSET_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const source = archive == null ? await readFile(path.join(webviewRoot, "assets", name), "utf8") : (await archive.readFile(entryName)).toString("utf8");
    const patched = patchCodexMicroFeatureGate(source);
    if (patched.replacements === 0) continue;
    patchedAssets.set(`/assets/${name}`, Buffer.from(patched.code));
    replacements += patched.replacements;
  }
  if (patchedAssets.size === 0) throw new Error(`Codex Micro feature gate ${CODEX_MICRO_FEATURE_GATE} was not found in the expected webview assets`);
  return { patchedAssets, replacements };
}

class AsarArchive {
  constructor(fileHandle, bodyOffset, files) { this.fileHandle = fileHandle; this.bodyOffset = bodyOffset; this.files = files; }
  static async open(filePath) {
    const fileHandle = await open(filePath, "r");
    const prefix = Buffer.alloc(16);
    await fileHandle.read(prefix, 0, prefix.length, 0);
    const jsonSize = prefix.readUInt32LE(12);
    const header = Buffer.alloc(jsonSize);
    await fileHandle.read(header, 0, jsonSize, 16);
    const files = new Map();
    const walk = (node, name) => {
      for (const [childName, child] of Object.entries(node.files ?? {})) {
        const childPath = `${name}/${childName}`;
        if (child.files) walk(child, childPath); else files.set(childPath, child);
      }
    };
    walk(JSON.parse(header.toString("utf8")), "");
    const padding = (4 - (jsonSize % 4)) % 4;
    return new AsarArchive(fileHandle, 16 + jsonSize + padding, files);
  }
  filesUnder(prefix) { const root = prefix.startsWith("/") ? prefix : `/${prefix}`; return [...this.files.keys()].filter((name) => name.startsWith(`${root}/`)); }
  async readFile(name) {
    const entry = this.files.get(name);
    if (!entry) throw new Error(`ASAR file not found: ${name}`);
    const buffer = Buffer.alloc(entry.size);
    await this.fileHandle.read(buffer, 0, entry.size, this.bodyOffset + Number(entry.offset));
    return buffer;
  }
  close() { return this.fileHandle.close(); }
}

function parseArgs(argv) {
  const options = { asar: null, checkOnly: false, host: "127.0.0.1", port: 0, readyFile: null, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--check-only") {
      options.checkOnly = true;
      continue;
    }
    if (!["--asar", "--host", "--port", "--ready-file", "--root"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (value == null) throw new Error(`Missing value for ${name}`);
    index += 1;
    if (name === "--asar") options.asar = path.resolve(value);
    if (name === "--host") options.host = value;
    if (name === "--port") options.port = Number(value);
    if (name === "--ready-file") options.readyFile = value;
    if (name === "--root") options.root = path.resolve(value);
  }

  if (options.root == null && options.asar == null) throw new Error("--root or --asar is required");
  if (options.root != null && options.asar != null) throw new Error("--root and --asar are mutually exclusive");
  if (!options.checkOnly && options.readyFile == null) throw new Error("--ready-file is required");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return options;
}

function resolveRequestPath(webviewRoot, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(webviewRoot, relative);
  const rootPrefix = `${webviewRoot}${path.sep}`;
  if (resolved !== webviewRoot && !resolved.startsWith(rootPrefix)) return null;
  return { pathname, resolved };
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (match == null) return null;
  const start = match[1] === "" ? 0 : Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size) {
    return null;
  }
  return { start, end };
}

async function serveFile(request, response, filePath, bodyOverride = null) {
  const fileStat = bodyOverride == null ? await stat(filePath) : null;
  const size = bodyOverride?.length ?? fileStat.size;
  const range = bodyOverride == null ? parseRange(request.headers.range, size) : null;
  const status = range == null ? 200 : 206;
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(Math.max(0, end - start + 1)),
    "Content-Type": contentType(filePath),
  };
  if (range != null) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(status, headers);
  if (request.method === "HEAD") return response.end();
  if (bodyOverride != null) return response.end(bodyOverride);
  createReadStream(filePath, { start, end }).pipe(response);
}

export async function startOverlayServer({ host, port, readyFile, root }) {
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Webview root is not a directory: ${root}`);
  const indexPath = path.join(root, "index.html");
  await stat(indexPath);
  const { patchedAssets, replacements } = await discoverPatchedAssets(root);

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end("Method not allowed");
        return;
      }
      const requestPath = resolveRequestPath(root, request.url ?? "/");
      if (requestPath == null) {
        response.writeHead(400);
        response.end("Invalid path");
        return;
      }
      const patched = patchedAssets.get(requestPath.pathname);
      if (patched != null) {
        await serveFile(request, response, requestPath.resolved, patched);
        return;
      }
      try {
        const requestedStat = await stat(requestPath.resolved);
        if (requestedStat.isFile()) {
          await serveFile(request, response, requestPath.resolved);
          return;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (path.extname(requestPath.pathname) === "") {
        await serveFile(request, response, indexPath);
        return;
      }
      response.writeHead(404);
      response.end("Not found");
    } catch (error) {
      response.writeHead(500);
      response.end(`Overlay server error: ${error.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  await writeFile(readyFile, `${url}\n${replacements}\n`, { mode: 0o600 });
  return { server, url, replacements };
}

export async function startAsarOverlayServer({ host, port, readyFile, asar: asarPath }) {
  const archive = await AsarArchive.open(asarPath);
  if (!archive.files.has("/webview/index.html")) { await archive.close(); throw new Error(`ASAR webview index not found: ${asarPath}`); }
  const { patchedAssets, replacements } = await discoverPatchedAssets(null, archive);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); response.end("Method not allowed"); return; }
      const requestPath = resolveRequestPath("/webview", request.url ?? "/");
      if (requestPath == null) { response.writeHead(400); response.end("Invalid path"); return; }
      const patched = patchedAssets.get(requestPath.pathname);
      if (patched != null) { await serveFile(request, response, requestPath.resolved, patched); return; }
      const archiveName = `/webview${requestPath.pathname}`;
      if (archive.files.has(archiveName)) { await serveFile(request, response, archiveName, await archive.readFile(archiveName)); return; }
      if (path.extname(requestPath.pathname) === "") { await serveFile(request, response, "/webview/index.html", await archive.readFile("/webview/index.html")); return; }
      response.writeHead(404); response.end("Not found");
    } catch (error) { response.writeHead(500); response.end(`Overlay server error: ${error.message}`); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  await writeFile(readyFile, `${url}\n${replacements}\n`, { mode: 0o600 });
  return { server, url, replacements, archive };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.checkOnly) {
    const archive = options.asar == null ? null : await AsarArchive.open(options.asar);
    const { replacements } = await discoverPatchedAssets(options.root, archive);
    await archive?.close();
    console.log(replacements);
    return;
  }
  const result = options.asar == null ? await startOverlayServer(options) : await startAsarOverlayServer(options);
  const { server, url, replacements, archive } = result
  console.error(`Codex Micro feature gate forced on (${replacements} replacements).`);
  console.error(`Serving patched webview at ${url}`);
  const close = () => server.close(async () => { await archive?.close(); process.exit(0); });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
