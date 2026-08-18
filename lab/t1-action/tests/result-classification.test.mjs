import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderLoadResult,
  classifyLoadResult,
  detectProviderTerminalState,
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

test("final result prioritizes provider import state", () => {
  const warning = classifyLoadResult({
    sourceReady: false,
    sourceFailureCategory: "source-readiness-timeout",
    providerLoad: { importStatus: "loaded-with-project-errors" },
    diagnosticsStable: true,
    errorCount: 1,
  });
  assert.deepEqual(warning, {
    successful: false,
    loadStatus: "loaded-with-project-errors",
    failureCategory: "provider-project-errors",
    failedPhase: "provider-load",
  });

  const diagnostics = classifyLoadResult({
    sourceReady: true,
    providerLoad: { importStatus: "ready" },
    diagnosticsStable: true,
    errorCount: 3,
  });
  assert.equal(diagnostics.loadStatus, "loaded-with-diagnostics-errors");
});
