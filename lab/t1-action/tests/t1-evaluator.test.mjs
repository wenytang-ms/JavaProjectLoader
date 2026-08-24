import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateT1,
  T1_COLLECTOR_VERSION,
  T1_EVIDENCE_SCHEMA_VERSION,
  T1_RULE_VERSION,
} from "../t1-evaluator.mjs";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "fixtures",
  "evaluator",
);

function baseEvidence() {
  return {
    schemaVersion: T1_EVIDENCE_SCHEMA_VERSION,
    ruleVersion: T1_RULE_VERSION,
    collectorVersion: T1_COLLECTOR_VERSION,
    collectionMode: "replay",
    project: "fixture",
    provider: "jdtls",
    providerEvidence: {
      state: "ready",
      loaded: true,
      importCompleted: true,
      importStatus: "ready",
      completionEvidence: "native-log",
      fatalLogMatches: [],
      fatalBuildOutputMatches: [],
      fatalStatusMatches: [],
      buildEvidence: [],
      providerFatalEvidence: [],
      nativeCompletionMatches: [
        "initialization-completed",
        "build-jobs-finished",
      ],
      finalStatusBarText: "0 0 | Java: Ready",
    },
    projectEvidence: {
      health: "clean",
      buildEvidence: [],
    },
    semanticEvidence: {
      state: "ready",
      sourceReady: true,
      documentSymbolReady: true,
      hoverReady: true,
      sourceAttempts: 1,
      failureCategory: "",
      error: null,
      lastError: null,
    },
    diagnosticEvidence: {
      state: "clean",
      scope: "workspace",
      captured: true,
      stable: true,
      counts: {
        error: 0,
        warning: 0,
        information: 0,
        hint: 0,
      },
      excludedCounts: {
        error: 0,
        warning: 0,
        information: 0,
        hint: 0,
      },
      statusProblemCounts: {
        raw: "0 0",
        errorCount: 0,
        warningCount: 0,
        informationCount: 0,
      },
      discrepancy: false,
    },
    harnessEvidence: {
      state: "ok",
      error: null,
    },
  };
}

for (const fileName of fs.readdirSync(fixtureDirectory).sort()) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, fileName), "utf8"),
  );
  test(`replays ${fixture.name}`, () => {
    const evidence = baseEvidence();
    Object.assign(evidence.providerEvidence, fixture.providerPatch);
    Object.assign(evidence.projectEvidence, fixture.projectPatch);
    Object.assign(evidence.semanticEvidence, fixture.semanticPatch);
    Object.assign(evidence.diagnosticEvidence, fixture.diagnosticPatch);

    const first = evaluateT1(evidence);
    const second = evaluateT1(structuredClone(evidence));
    assert.deepEqual(second, first);
    assert.equal(first.verdict, fixture.expected.verdict);
    assert.equal(first.failedPhase, fixture.expected.failedPhase);
    if (fixture.expected.reasonCode) {
      assert.ok(first.reasonCodes.includes(fixture.expected.reasonCode));
    } else {
      assert.deepEqual(first.reasonCodes, []);
    }
  });
}

test("rejects unsupported rule versions", () => {
  assert.throws(
    () => evaluateT1(baseEvidence(), "t1-v99"),
    /Unsupported T1 rule version/,
  );
});
