import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBuildOutput,
  analyzeProviderLog,
  analyzeProviderStatus,
  analyzeStatusProblemCounts,
  combinedFatalEvidence,
} from "../provider-evidence.mjs";

test("IntelliJ fatal Maven evidence overrides later import markers", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT STD]: [INFO] BUILD FAILURE
    [IMPORT STD]: [ERROR] Failed to execute goal on project kryo-benchmarks
    [IMPORT STD]: [ERROR] Could not resolve dependencies
    [IMPORT STD]: [ERROR] Could not find artifact com.example:missing:jar:1.0
    Successfully imported C:\\kryo
    Workspace model cache saved (45 K)
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.fatalLogMatches, [
    "maven-build-failure",
    "maven-goal-failed",
    "dependency-resolution-failed",
    "artifact-missing",
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

test("IntelliJ stderr warnings are not fatal by themselves", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT ERR]: WARNING: A restricted method in java.lang.System has been called
    [IMPORT ERR]: WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning
    Successfully imported /tmp/guava
    Workspace model cache saved (93 K)
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.fatalLogMatches, []);
});

test("IntelliJ stderr failures remain fatal", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT ERR]: fatal: not a git repository
    [IMPORT ERR]: Process 'command git' finished with non-zero exit value 128
  `);
  assert.deepEqual(evidence.fatalLogMatches, ["import-stderr-failure"]);
});

test("IntelliJ optional source and Javadoc misses are not fatal", () => {
  const evidence = analyzeProviderLog("intellij", `
    [IMPORT STD]: [Project Libraries] Resolution failed: sources absent:
    Could not find artifact com.example:library:jar:sources:1.0 in central
    Successfully imported /tmp/guava
    Workspace model cache saved (134 K)
  `);
  assert.equal(evidence.nativeCompleted, true);
  assert.deepEqual(evidence.fatalLogMatches, []);
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

test("Oracle distinguishes language client readiness from fatal startup logs", () => {
  const ready = analyzeProviderLog("oracle", `
    [INFO]: LSP server launching: 1234
    [INFO]: Language Client: Starting
    [INFO]: Language Client: Ready
    INFO: 4 projects opened in 18,974ms
    INFO: Indexing finished, indexing took 8,597 ms.
  `);
  assert.equal(ready.nativeCompleted, true);
  assert.deepEqual(ready.nativeCompletionMatches, [
    "language-client-ready",
    "projects-opened",
    "indexing-finished",
  ]);
  assert.deepEqual(ready.fatalLogMatches, []);

  const clientOnly = analyzeProviderLog(
    "oracle",
    "[INFO]: Language Client: Ready",
  );
  assert.equal(clientOnly.nativeCompleted, false);
  assert.equal(clientOnly.initializationCompleted, true);

  const failed = analyzeProviderLog("oracle", `
    [ERROR]: Cannot find org.netbeans.modules.java.lsp.server in the log!
    [ERROR]: Oracle Java SE Language Server not enabled!
  `);
  assert.equal(failed.nativeCompleted, false);
  assert.deepEqual(failed.fatalLogMatches, [
    "language-server-module-missing",
    "language-server-not-enabled",
  ]);
});

test("JDT LS Guava Gradle failure is fatal build output", () => {
  const fatalBuildOutputMatches = analyzeBuildOutput(`
    [error] FAILURE: Build failed with an exception.
    CONFIGURE FAILED in 2m 20s
    [error] The supplied build action failed with an exception.
  `);
  assert.deepEqual(fatalBuildOutputMatches, [
    "gradle-build-failed",
    "build-action-failed",
  ]);
});

test("JDT LS Ready cannot override a Gradle build error", () => {
  const fatalStatusMatches = analyzeProviderStatus(
    "jdtls",
    "9K 1K 914 | Java: Ready | Gradle: Build Error",
  );
  assert.deepEqual(fatalStatusMatches, ["gradle-build-error"]);
  assert.deepEqual(
    combinedFatalEvidence({
      fatalLogMatches: [],
      fatalBuildOutputMatches: ["gradle-build-failed"],
      fatalStatusMatches,
    }),
    ["gradle-build-failed", "gradle-build-error"],
  );
});

test("status Problems errors remain separate from Provider state", () => {
  assert.deepEqual(
    analyzeStatusProblemCounts(
      "40e7de08 | 9K 1K 914 | Java: Ready | Java | CRLF",
    ),
    {
      raw: "9K 1K 914",
      errorCount: 9000,
      warningCount: 1000,
      informationCount: 914,
    },
  );
  assert.deepEqual(
    analyzeProviderStatus(
      "jdtls",
      "40e7de08 | 9K 1K 914 | Java: Ready | Java | CRLF",
    ),
    [],
  );
});

test("status Problems warnings do not fail the gate", () => {
  assert.deepEqual(
    analyzeStatusProblemCounts(
      "22a34127 | 0 223 | Java: Ready | Java | CRLF",
    ),
    {
      raw: "0 223",
      errorCount: 0,
      warningCount: 223,
      informationCount: 0,
    },
  );
  assert.deepEqual(
    analyzeProviderStatus(
      "jdtls",
      "22a34127 | 0 223 | Java: Ready | Java | CRLF",
    ),
    [],
  );
});

test("in-progress builder text is not a final Problems count", () => {
  assert.deepEqual(
    analyzeProviderStatus(
      "jdtls",
      "4e481d50 | 0 0 | Java: Building - 50% " +
        "(Found 1416 errors + 3 warnings)",
    ),
    [],
  );
});
