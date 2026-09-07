import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  collectSourceResultIfReady,
  observeFinalProviderLoad,
  refreshProviderLoadEvidence,
  waitForProviderIdle,
} from "../run-t1-autotest.mjs";
import { buildProviderLoadResult } from "../result-classification.mjs";
import { createNormalizedEvidence, evaluateT1 } from "../t1-evaluator.mjs";

function fixture(t) {
  const root = path.join(import.meta.dirname, `.ui-freshness-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profile: { userDataDirectory: root } };
}

function statusDriver(read) {
  return {
    getPage: () => ({
      locator: () => ({
        count: async () => 1,
        nth: () => ({ textContent: async () => read() }),
      }),
    }),
  };
}

const log = { loaded: true, failed: false, nativeCompleted: true };
const diagnostics = { stable: true, diagnosticsCaptured: true, scope: "workspace", counts: { error: 0, warning: 0 } };
const sourceReadyResult = {
  status: "source-ready", sourceReadyAt: "2026-09-07T00:00:00Z",
  documentSymbolReady: true, hoverReady: true, sourceAttempts: 1, error: null,
};

for (const status of ["Warning", "Error"]) {
  test(`${status} requires the same stable terminal window as Ready`, async (t) => {
    const { root, profile } = fixture(t);
    let time = 0;
    const ui = await waitForProviderIdle(
      statusDriver(() => `Java: ${status}`), "jdtls", profile, 40_000, root, 30_000,
      { now: () => time, sleep: async (ms) => { time += ms; } },
    );
    assert.equal(ui.settled, true);
    assert.equal(ui.stableMs, 30_000);
    assert.equal(ui.durationMs, 30_000);
    assert.equal(ui.terminalState, status.toLowerCase());
  });
}

test("Error -> busy -> Ready recovery restarts terminal stability", async (t) => {
  const { root, profile } = fixture(t);
  let time = 0;
  const driver = statusDriver(() =>
    time < 5000 ? "Java: Error" : time < 10000 ? "Java: Building" : "Java: Ready",
  );
  const ui = await waitForProviderIdle(
    driver, "jdtls", profile, 60_000, root, 30_000,
    { now: () => time, sleep: async (ms) => { time += ms; } },
  );
  assert.equal(ui.terminalState, "ready");
  assert.equal(ui.durationMs, 40_000);
  assert.deepEqual(ui.transitions.map((entry) => entry.text), ["Java: Error", "Java: Building", "Java: Ready"]);
  const refreshed = await refreshProviderLoadEvidence(
    driver, buildProviderLoadResult({ ...log, statusBarText: "Java: Error", fatalStatusMatches: ["java-error"] }, ui), "jdtls", profile,
  );
  assert.equal(refreshed.importStatus, "ready");
  assert.deepEqual(refreshed.log.fatalStatusMatches, []);
});

test("changing build output restarts the terminal window", async (t) => {
  const { root, profile } = fixture(t);
  const directory = path.join(root, "logs", "output_logging_1");
  fs.mkdirSync(directory, { recursive: true });
  let time = 0;
  const ui = await waitForProviderIdle(
    statusDriver(() => "Java: Warning"), "jdtls", profile, 60_000, root, 30_000,
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        if (time === 5000) fs.writeFileSync(path.join(directory, "Gradle for Java.log"), "Preparing dependencies");
      },
    },
  );
  assert.equal(ui.durationMs, 35_000);
});

test("a real build failure stays fatal if output is truncated during the stable window", async (t) => {
  const { root, profile } = fixture(t);
  const directory = path.join(root, "logs", "output_logging_1");
  fs.mkdirSync(directory, { recursive: true });
  const buildLog = path.join(directory, "Gradle for Java.log");
  fs.writeFileSync(buildLog, "FAILURE: Build failed with an exception.");
  let time = 0;
  const driver = statusDriver(() => "Java: Ready");
  const ui = await waitForProviderIdle(
    driver, "jdtls", profile, 60_000, root, 30_000,
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        if (time === 5000) fs.writeFileSync(buildLog, "BUILD SUCCESSFUL");
      },
    },
  );
  assert.equal(ui.durationMs, 35_000);
  assert.equal(ui.terminalState, "error");
  assert.deepEqual(ui.fatalBuildOutputMatches, ["gradle-build-failed"]);
  const refreshed = await refreshProviderLoadEvidence(driver, buildProviderLoadResult(log, ui), "jdtls", profile);
  assert.equal(refreshed.importStatus, "import-failed");
});

test("a recovery between terminal polling and live refresh gets its own stable Ready window", async (t) => {
  const { root, profile } = fixture(t);
  let time = 0;
  let reads = 0;
  const driver = statusDriver(() => ++reads <= 31 ? "Java: Error" : "Java: Ready");
  const refreshed = await observeFinalProviderLoad(
    driver, "jdtls", profile, 100_000, root, log,
    { now: () => time, sleep: async (ms) => { time += ms; } },
  );
  assert.equal(time, 60_000);
  assert.equal(refreshed.importStatus, "ready");
  assert.equal(refreshed.ui.settled, true);
  assert.equal(refreshed.ui.finalStatusBarText, "Java: Ready");
  assert.deepEqual(refreshed.log.fatalStatusMatches, []);
});

test("final refresh reads live Ready instead of cached Error but does not invent stability", async (t) => {
  const { profile } = fixture(t);
  const previous = buildProviderLoadResult(log, {
    settled: true, terminalState: "error", finalStatusBarText: "Java: Error",
  });
  const refreshed = await refreshProviderLoadEvidence(statusDriver(() => "Java: Ready"), previous, "jdtls", profile);
  assert.equal(refreshed.log.statusBarText, "Java: Ready");
  assert.equal(refreshed.ui.finalStatusBarText, "Java: Ready");
  assert.deepEqual(refreshed.log.fatalStatusMatches, []);
  assert.equal(refreshed.ui.settled, false);
  assert.notEqual(refreshed.importStatus, "import-failed");
  assert.notEqual(refreshed.importStatus, "ready");
});

test("final observation still reads live UI with an exhausted deadline and an initially failed load", async (t) => {
  const { root, profile } = fixture(t);
  let reads = 0;
  const refreshed = await observeFinalProviderLoad(
    statusDriver(() => { reads++; return "Java: Ready"; }),
    "jdtls", profile, Date.now() - 1, root, { ...log, statusBarText: "Java: Error" },
  );
  assert.ok(reads >= 2);
  assert.equal(refreshed.ui.finalStatusBarText, "Java: Ready");
  assert.equal(refreshed.ui.settled, false);
  assert.deepEqual(refreshed.log.fatalStatusMatches, []);
});

test("fresh Ready never masks real fatal log or build evidence, even if files rotate away", async (t) => {
  const { profile } = fixture(t);
  for (const priorEvidence of [
    { fatalLogMatches: ["language-server-module-missing"] },
    { fatalBuildOutputMatches: ["gradle-build-failed"] },
  ]) {
    const previous = buildProviderLoadResult({ ...log, ...priorEvidence }, {
      settled: true, terminalState: "ready", finalStatusBarText: "Java: Ready",
    });
    const refreshed = await refreshProviderLoadEvidence(statusDriver(() => "Java: Ready"), previous, "jdtls", profile);
    assert.equal(refreshed.importStatus, "import-failed");
    assert.ok(refreshed.log.fatalEvidenceMatches.length > 0);
  }
});

test("Oracle project log fatal evidence is included in the final refresh", async (t) => {
  const { root, profile } = fixture(t);
  const projectLogPath = path.join(root, "messages.log");
  fs.writeFileSync(projectLogPath, "Cannot find org.netbeans.modules.java.lsp.server in the log!");
  const previous = buildProviderLoadResult({ ...log, projectLogPath }, {
    settled: true, terminalState: "ready", finalStatusBarText: "",
  });
  const refreshed = await refreshProviderLoadEvidence(statusDriver(() => ""), previous, "oracle", profile);
  assert.equal(refreshed.importStatus, "import-failed");
  assert.ok(refreshed.log.fatalLogMatches.includes("language-server-module-missing"));
});

test("semantic not-run cannot PASS; recovered Ready collects a late semantic result", async (t) => {
  const { root } = fixture(t);
  const resultPath = path.join(root, "source-result.json");
  const providerLoad = buildProviderLoadResult(log, {
    settled: true, terminalState: "ready", finalStatusBarText: "Java: Ready",
  });
  const skipped = await collectSourceResultIfReady(
    {}, resultPath, Date.now() + 10_000, root,
    { importStatus: "import-failed", failureCategory: "provider-import-failed" },
    { id: "fixture" }, "jdtls",
  );
  const evidence = createNormalizedEvidence({
    provider: "jdtls", providerLoad, sourceResult: skipped, sourceReady: false, diagnostics,
  });
  assert.equal(evidence.semanticEvidence.state, "not-run");
  assert.equal(evaluateT1(evidence).successful, false);
  const pending = collectSourceResultIfReady(
    {}, resultPath, Date.now() + 10_000, root, providerLoad, { id: "fixture" }, "jdtls",
  );
  fs.writeFileSync(resultPath, JSON.stringify(sourceReadyResult));
  const collected = await pending;
  assert.equal(collected.documentSymbolReady, true);
  assert.equal(collected.hoverReady, true);
  assert.equal(evaluateT1(createNormalizedEvidence({
    provider: "jdtls", providerLoad, sourceResult: collected, sourceReady: true, diagnostics,
  })).successful, true);
});
