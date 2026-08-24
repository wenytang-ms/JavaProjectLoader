import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderLoadResult,
  detectProviderTerminalState,
  isProviderBusy,
} from "../result-classification.mjs";

test("JDT LS exposes Ready, Warning, and Error as terminal states", () => {
  assert.equal(
    detectProviderTerminalState("jdtls", "Java: Ready", false),
    "ready",
  );
  assert.equal(
    detectProviderTerminalState("jdtls", "Java: Warning", false),
    "warning",
  );
  assert.equal(
    detectProviderTerminalState("jdtls", "Java: Error", false),
    "error",
  );
  assert.equal(
    detectProviderTerminalState("jdtls", "Java: Building", true),
    null,
  );
});

test("provider busy states include long-running refresh and indexing text", () => {
  assert.equal(isProviderBusy("jdtls", "Java: Refreshing workspace"), true);
  assert.equal(isProviderBusy("jdtls", "Java: Searching... - 80%"), true);
  assert.equal(
    isProviderBusy("jdtls", "Java: Ready | Gradle: Configure project : started"),
    true,
  );
  assert.equal(isProviderBusy("intellij", "Indexing: 98%"), true);
  assert.equal(
    isProviderBusy("intellij", "Indexing: Just a few more moments..."),
    true,
  );
  assert.equal(isProviderBusy("intellij", "Java and Kotlin"), false);
});

test("JDT LS build errors override Java Ready", () => {
  const status = "9K 1K 914 | Java: Ready | Gradle: Build Error";
  assert.equal(isProviderBusy("jdtls", status), false);
  assert.equal(
    detectProviderTerminalState("jdtls", status, false),
    "error",
  );
});

test("JDT LS build errors override Java Warning", () => {
  const status = "Java: Warning | Gradle: Build Error";
  assert.equal(
    detectProviderTerminalState("jdtls", status, false),
    "error",
  );
});

test("IntelliJ requires its status item before UI is ready", () => {
  assert.equal(
    detectProviderTerminalState("intellij", "Java and Kotlin", false),
    "ready",
  );
  assert.equal(
    detectProviderTerminalState("intellij", "Ln 1, Col 1", false),
    null,
  );
});

test("project warnings and service errors are distinct import failures", () => {
  const log = { loaded: true, failed: false };
  const warning = buildProviderLoadResult(log, {
    settled: true,
    terminalState: "warning",
  });
  assert.equal(warning.loaded, true);
  assert.equal(warning.importStatus, "loaded-with-project-errors");

  const error = buildProviderLoadResult(log, {
    settled: true,
    terminalState: "error",
  });
  assert.equal(error.loaded, false);
  assert.equal(error.importStatus, "import-failed");
});

test("completed initialization and active indexing are not not-loaded", () => {
  const finalizing = buildProviderLoadResult({
    loaded: false,
    failed: false,
    initializationCompleted: true,
    lastObservation: "initialization-finished",
  }, null);
  assert.equal(finalizing.loaded, true);
  assert.equal(finalizing.importStatus, "loaded-finalization-timeout");
  assert.equal(finalizing.failureCategory, "provider-finalization-timeout");

  const indexing = buildProviderLoadResult(
    { loaded: true, failed: false },
    {
      settled: false,
      terminalState: null,
      finalStatusBarText: "Java: Searching... - 79% 5 files to index",
    },
  );
  assert.equal(indexing.loaded, true);
  assert.equal(indexing.importStatus, "loaded-indexing-timeout");
  assert.equal(indexing.failureCategory, "provider-indexing-timeout");

  const uiTimeout = buildProviderLoadResult(
    { loaded: true, failed: false },
    {
      settled: false,
      terminalState: null,
      finalStatusBarText: "",
    },
  );
  assert.equal(uiTimeout.loaded, true);
  assert.equal(uiTimeout.importStatus, "loaded-ui-timeout");
  assert.equal(uiTimeout.failureCategory, "provider-ui-timeout");
});
