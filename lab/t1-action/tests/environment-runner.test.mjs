import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";
import { writeOuterRunnerFailure } from "../run-t1-autotest.mjs";

const project = loadProjects().find((item) => item.id === "analysis-ik");
const runner = path.resolve(import.meta.dirname, "../run-t1-autotest.mjs");
const read = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));

for (const state of ["ENV_BLOCKED", "ENV_UNVERIFIED", "PROJECT_BASELINE_FAILED", null]) {
  test(`runner skips all IDE work with ${state ?? "missing"} environment qualification`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-environment-gate-"));
    try {
      const directory = path.join(root, "environment");
      const output = path.join(root, "output");
      fs.mkdirSync(directory);
      if (state) {
        fs.writeFileSync(path.join(directory, "environment-result.json"), JSON.stringify({
          project: project.id, commit: project.commit, operatingSystem: "windows-latest",
          state, reason: "Fixture environment does not qualify.",
        }));
      }
      const run = spawnSync(process.execPath, [runner, "--project", project.id, "--provider", "oracle"], {
        env: {
          ...process.env,
          T1_REQUIRE_ENVIRONMENT_READY: "1",
          T1_ENVIRONMENT_DIRECTORY: directory,
          T1_OUTPUT_DIR: output,
          T1_OPERATING_SYSTEM: "windows-latest",
          T1_VSCODE_VERSION: "must-not-download",
          T1_ORACLE_VSIX: path.join(root, "must-not-install.vsix"),
          RUNNER_TEMP: root,
          GITHUB_STEP_SUMMARY: "",
        },
        encoding: "utf8", timeout: 30_000,
      });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error ?? ""}`);
      const result = read(output, "result.json");
      assert.equal(result.verdict, "NOT_EVALUATED");
      assert.equal(result.environmentState, state ?? "ENV_UNVERIFIED");
      assert.equal(result.evaluationEligible, false);
      assert.equal(result.ruleVersion, "t1-v5");
      assert.equal(result.collectorVersion, "t1-v5");
      assert.equal(result.errorCount, null);
      assert.equal(result.warningCount, null);
      assert.equal(result.diagnosticsCaptured, false);
      assert.equal(result.semanticState, "not-run");
      assert.equal(read(output, "rule-evidence.json").result, "NOT_EVALUATED");
      assert.equal(read(output, "run-metadata.json").ideStarted, false);
      assert.equal(read(output, "run-metadata.json").vscodeVersion, "must-not-download");
      assert.ok(!fs.existsSync(path.join(output, "vscode-settings.json")));
      assert.ok(!fs.readdirSync(root).some((name) => name.includes("checkout")));
      assert.ok(!fs.readdirSync(output).some((name) => name.endsWith(".png")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("qualified environment plus provider installation error stays outside the provider denominator", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-environment-infra-"));
  try {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ project: project.id, product: "oracle" }));
    const result = writeOuterRunnerFailure(root, new Error("Marketplace HTTP 503"), {
      environmentRequired: true, environment: { state: "ENV_READY" },
    });
    assert.equal(result.verdict, "NOT_EVALUATED");
    assert.equal(result.failureCategory, "infrastructure-error");
    assert.equal(result.environmentEligible, true);
    assert.equal(result.evaluationEligible, false);
    assert.equal(result.ruleVersion, "t1-v5");
    assert.equal(result.errorCount, null);
    assert.equal(read(root, "rule-evidence.json").result, "NOT_EVALUATED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup error does not erase a real provider import failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-environment-provider-"));
  try {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({
      project: project.id, product: "oracle",
      providerLoaded: true, providerImportStatus: "import-failed", providerTerminalState: "error",
      providerLoad: { loaded: true, importStatus: "import-failed", terminalState: "error", log: {} },
    }));
    const result = writeOuterRunnerFailure(root, new Error("Driver cleanup failed"), {
      environmentRequired: true, environment: { state: "ENV_READY" },
    });

    assert.equal(result.verdict, "FAIL");
    assert.equal(result.evaluationEligible, true);
    assert.equal(result.providerImportStatus, "import-failed");
    assert.equal(result.providerTerminalState, "error");
    assert.notEqual(result.failureCategory, "infrastructure-error");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collection failure preserves an observed fatal import before final result persistence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-environment-observation-"));
  try {
    const observed = {
      loaded: false, importCompleted: true, importStatus: "import-failed", terminalState: "error",
      log: { fatalLogMatches: ["language-server-module-missing"] }, ui: null,
    };
    const result = writeOuterRunnerFailure(root, new Error("Target page, context or browser has been closed"), {
      environmentRequired: true, environment: { state: "ENV_READY" }, providerLoad: observed,
    });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.evaluationEligible, true);
    assert.equal(result.providerImportStatus, "import-failed");
    assert.deepEqual(result.providerLoad, observed);
    assert.ok(read(root, "normalized-evidence.json").providerEvidence.providerFatalEvidence.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
