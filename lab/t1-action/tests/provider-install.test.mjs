import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("JDT LS installation refreshes the pack and pins the fixed Java extension", () => {
  const runner = fs.readFileSync(
    path.resolve(import.meta.dirname, "../run-t1-autotest.mjs"),
    "utf8",
  );
  assert.match(runner, /vscjava\.vscode-java-pack@0\.31\.1/);
  assert.match(runner, /redhat\.java@1\.56\.2026073109/);
  assert.match(runner, /redhat\/vsextensions\/java\/1\.56\.2026073109\/vspackage/);
  assert.match(
    runner,
    /providerRefreshExtensions[\s\S]*redhat\.java[\s\S]*installProvider/,
  );
});
