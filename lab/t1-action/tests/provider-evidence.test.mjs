import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProviderLog } from "../provider-evidence.mjs";

test("IntelliJ fatal Maven evidence overrides later import markers", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT STD]: [INFO] BUILD FAILURE
    [IMPORT STD]: [ERROR] Failed to execute goal on project kryo-benchmarks
    [IMPORT STD]: [ERROR] Could not resolve dependencies
    Successfully imported C:\\kryo
    Workspace model cache saved (45 K)
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.fatalLogMatches, [
    "maven-build-failure",
    "maven-goal-failed",
    "dependency-resolution-failed",
  ]);
});

test("IntelliJ successful build has complete native evidence", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT STD]: BUILD SUCCESSFUL in 41s
    Successfully imported C:\\supertokens
    Workspace model cache saved (93 K)
    Updated 100061 files
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.fatalLogMatches, []);
  assert.deepEqual(evidence.nativeCompletionMatches, [
    "successfully-imported",
    "workspace-model-cache-saved",
  ]);
});

test("IntelliJ analyzer-only work can become a functional fallback", () => {
  const evidence = analyzeProviderLog(
    "intellij",
    "Updated 8 files\nRocksDB flush took 2 s",
  );
  assert.equal(evidence.nativeCompleted, false);
  assert.equal(evidence.updatedFileCount, 8);
  assert.equal(evidence.functionalCandidate, true);
});

test("IntelliJ import output does not fall back before completion", () => {
  const evidence = analyzeProviderLog(
    "intellij",
    "[IMPORT STD]: Downloading dependencies\nUpdated 8 files",
  );
  assert.equal(evidence.functionalCandidate, false);
  assert.equal(evidence.importStarted, true);
});

test("JDT LS requires initialization and build completion", () => {
  const evidence = analyzeProviderLog("jdtls", `
    >> initialization job finished
    >> build jobs finished
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.nativeCompletionMatches, [
    "initialization-completed",
    "build-jobs-finished",
  ]);
});
