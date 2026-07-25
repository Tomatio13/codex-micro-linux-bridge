import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_MICRO_FEATURE_GATE,
  discoverPatchedAssets,
  patchCodexMicroFeatureGate,
} from "../scripts/force-codex-micro-webview.mjs";

test("feature gate patch replaces standalone hook calls only", () => {
  const source = [
    `const enabled=Rh(\`${CODEX_MICRO_FEATURE_GATE}\`);`,
    `const settings=check('${CODEX_MICRO_FEATURE_GATE}');`,
    `const method=client.checkGate(\`${CODEX_MICRO_FEATURE_GATE}\`);`,
    "const unrelated=Rh(`123`);",
  ].join("\n");

  const result = patchCodexMicroFeatureGate(source);
  assert.equal(result.replacements, 2);
  assert.match(result.code, /const enabled=true/);
  assert.match(result.code, /const settings=true/);
  assert.match(result.code, /client\.checkGate\(`3207467860`\)/);
  assert.match(result.code, /Rh\(`123`\)/);
});

test("feature gate discovery patches only expected webview assets", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-micro-gate-"));
  const assets = path.join(root, "assets");
  mkdirSync(assets);
  writeFileSync(path.join(root, "index.html"), "<!doctype html>");
  writeFileSync(path.join(assets, "app-initial-test.js"), "const enabled=Rh(`3207467860`);");
  writeFileSync(
    path.join(assets, "use-visible-settings-sections-test.js"),
    "const visible=check(`3207467860`);",
  );
  writeFileSync(path.join(assets, "unrelated.js"), "const enabled=Rh(`3207467860`);");

  const result = await discoverPatchedAssets(root);
  assert.equal(result.replacements, 2);
  assert.equal(result.patchedAssets.size, 2);
  assert.equal(result.patchedAssets.get("/assets/app-initial-test.js").toString(), "const enabled=true;");
  assert.equal(result.patchedAssets.has("/assets/unrelated.js"), false);
});
