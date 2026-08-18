import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderLoadResult,
  classifyLoadResult,
  detectProviderTerminalState,
  reconcileProviderLoadResult,
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

test("BSP source readiness can complete a missing build marker", () => {
  const reconciled = reconcileProviderLoadResult(
    {
      loaded: true,
      importCompleted: false,
      importStatus: "loaded-finalization-timeout",
      terminalState: null,
      failureCategory: "provider-finalization-timeout",
      log: { bspClasspathsUpdated: true },
      ui: null,
    },
    {
      sourceReady: true,
      diagnosticsStable: true,
      errorCount: 0,
    },
  );
  assert.equal(reconciled.importStatus, "ready");
  assert.equal(reconciled.terminalState, "ready");
  assert.equal(reconciled.completionEvidence, "bsp-source-ready");
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

  const indexing = classifyLoadResult({
    sourceReady: false,
    providerLoad: { importStatus: "loaded-indexing-timeout" },
    diagnosticsStable: true,
    errorCount: 0,
  });
  assert.deepEqual(indexing, {
    successful: false,
    loadStatus: "loaded-indexing-timeout",
    failureCategory: "provider-indexing-timeout",
    failedPhase: "source-index",
  });
});
