import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rejudgeArtifacts } from "../rejudge-artifacts.mjs";
import { writeOuterRunnerFailure } from "../run-t1-autotest.mjs";
import { createNormalizedEvidence } from "../t1-evaluator.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

test("offline rejudgment preserves Provider Ready and fails Problems errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-rejudge-"));
  const artifact = path.join(root, "t1-fixture-jdtls-Windows");
  const output = path.join(root, "output");
  try {
    writeJson(path.join(artifact, "result.json"), {
      project: "fixture",
      product: "jdtls",
      operatingSystem: "windows-latest",
      completedAt: "2026-08-24T00:00:00.000Z",
      sourceReady: true,
      sourceAttempts: 1,
      documentSymbolReady: true,
      hoverReady: true,
      providerLoaded: false,
      providerImportCompleted: true,
      providerImportStatus: "import-failed",
      providerTerminalState: "error",
      diagnosticsCaptured: true,
      diagnosticsStable: true,
      diagnosticScope: "workspace",
    });

    writeJson(path.join(artifact, "rule-evidence.json"), {
      fatalLogMatches: [],
      fatalBuildOutputMatches: [],
      fatalStatusMatches: ["workspace-problems-errors"],
      finalStatusBarText: "40e7de08 | 458 37 29 | Java: Ready",
      statusProblemCounts: {
        raw: "458 37 29",
        errorCount: 458,
        warningCount: 37,
        informationCount: 29,
      },
    });
    writeJson(path.join(artifact, "diagnostics-result.json"), {
      scope: "workspace",
      stable: true,
      counts: {
        error: 0,
        warning: 0,
        information: 0,
        hint: 0,
      },
      excludedCounts: {
        error: 9709,
        warning: 1101,
        information: 914,
        hint: 0,
      },
    });

    const summary = rejudgeArtifacts({
      artifactRoots: [root],
      outputDirectory: output,
      projects: ["fixture"],
    });
    assert.equal(summary.resultCount, 1);
    assert.equal(summary.results[0].verdict, "FAIL");
    assert.equal(summary.results[0].providerState, "ready");
    assert.equal(summary.results[0].failedPhase, "diagnostics");
    assert.ok(
      summary.results[0].reasonCodes.includes("workspace-problems-errors"),
    );
    assert.equal(summary.results[0].evidenceSufficient, true);
    assert.ok(fs.existsSync(path.join(output, "rejudged-results.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("outer setup failures still write versioned T1 v4 evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-outer-error-"));
  try {
    const result = writeOuterRunnerFailure(root, new Error("setup failed"));
    const evidence = JSON.parse(
      fs.readFileSync(path.join(root, "normalized-evidence.json"), "utf8"),
    );
    assert.equal(result.ruleVersion, "t1-v4");
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.failedPhase, "runner");
    assert.deepEqual(result.reasonCodes, ["harness-error"]);
    assert.equal(evidence.collectorVersion, "t1-v4");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("outer finalization failures replace an existing PASS result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-finalize-error-"));
  try {
    writeJson(path.join(root, "result.json"), {
      schemaVersion: 2,
      ruleVersion: "t1-v4",
      collectorVersion: "t1-v4",
      project: "fixture",
      product: "jdtls",
      operatingSystem: "windows-latest",
      verdict: "PASS",
      status: "success",
      sourceReady: true,
      sourceAttempts: 1,
      documentSymbolReady: true,
      hoverReady: true,
      providerLoaded: true,
      providerImportCompleted: true,
      providerImportStatus: "ready",
      providerTerminalState: "ready",
      diagnosticsCaptured: true,
      diagnosticsStable: true,
      diagnosticScope: "workspace",
    });

    const result = writeOuterRunnerFailure(
      root,
      new Error("finalization failed"),
    );
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, "result.json"), "utf8"),
    );
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.failedPhase, "runner");
    assert.deepEqual(result.reasonCodes, ["harness-error"]);
    assert.equal(persisted.verdict, "FAIL");
    assert.equal(persisted.project, "fixture");
    assert.match(persisted.error, /finalization failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejudgment prefers captured normalized evidence over legacy fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-normalized-"));
  const artifact = path.join(root, "t1-fixture-intellij-macOS");
  const output = path.join(root, "output");
  try {
    writeJson(path.join(artifact, "result.json"), {
      project: "fixture",
      product: "intellij",
      operatingSystem: "macos-latest",
      completedAt: "2026-08-24T00:00:00.000Z",
      status: "failure",
      failureCategory: "runner-error",
    });
    writeJson(
      path.join(artifact, "normalized-evidence.json"),
      createNormalizedEvidence({
        project: "fixture",
        provider: "intellij",
        operatingSystem: "macos-latest",
        effectiveTimeoutSeconds: 1800,
        providerLoad: {
          loaded: true,
          importCompleted: true,
          importStatus: "ready",
          terminalState: "ready",
          log: {},
          ui: { finalStatusBarText: "0 0 | Java and Kotlin" },
        },
        sourceResult: {
          status: "source-ready",
          sourceAttempts: 1,
          documentSymbolReady: true,
          hoverReady: true,
        },
        sourceReady: true,
        diagnostics: {
          scope: "workspace",
          stable: true,
          diagnosticsCaptured: true,
          counts: { error: 0, warning: 0 },
        },
      }),
    );

    const summary = rejudgeArtifacts({
      artifactRoots: [root],
      outputDirectory: output,
      projects: ["fixture"],
    });
    assert.equal(summary.results[0].verdict, "PASS");
    assert.equal(summary.results[0].evidenceSufficient, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
