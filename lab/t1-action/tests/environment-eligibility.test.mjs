import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createEnvironmentBlockedResult } from "../environment-result.mjs";
import {
  createNormalizedEvidence,
  evaluateT1,
  evidenceSufficiency,
  normalizedEvidenceFromArtifacts,
  T1_ENVIRONMENT_RULE_VERSION,
  T1_ENVIRONMENT_COLLECTOR_VERSION,
} from "../t1-evaluator.mjs";
import { summarizeResults } from "../summarize-results.mjs";
import {
  buildProviderComparisons,
  summarizeComparison,
  summarizeProviderComparisons,
} from "../summarize-jdtls-oracle.mjs";

const operatingSystem = "windows-latest";
const ready = {
  state: "ENV_READY",
  project: "demo",
  commit: "project-sha",
  operatingSystem,
  planHash: "plan-sha",
  lockHash: "lock-sha",
  blockers: [],
  unresolved: [],
};

function cleanEvidence(options = {}) {
  return createNormalizedEvidence({
    project: "demo",
    provider: "jdtls",
    operatingSystem,
    providerLoad: {
      loaded: true,
      importCompleted: true,
      importStatus: "ready",
      terminalState: "ready",
    },
    sourceResult: { sourceAttempts: 1, documentSymbolReady: true, hoverReady: true },
    sourceReady: true,
    diagnostics: {
      scope: "workspace",
      captured: true,
      stable: true,
      counts: { error: 0, warning: 0 },
    },
    ...options,
  });
}

for (const [state, category] of [
  ["ENV_BLOCKED", "environment-blocked"],
  ["ENV_UNVERIFIED", "environment-unverified"],
  ["PROJECT_BASELINE_FAILED", "project-baseline-failed"],
]) {
  test(`${state} takes precedence over false-clean and every provider/runner failure`, () => {
    for (const fatal of [false, true]) {
      const evidence = cleanEvidence({
        environmentRequired: true,
        environment: {
          ...ready, state,
          blockers: [{ code: "jdk-missing" }],
          unresolved: ["dependency-source"],
        },
        harnessError: fatal ? "early setup failure" : null,
      });
      if (fatal) {
        evidence.providerEvidence.providerFatalEvidence = ["server-crashed"];
        evidence.providerEvidence.state = "error";
        evidence.projectEvidence.buildEvidence = ["maven-build-failure"];
      }
      const judgment = evaluateT1(evidence);
      assert.equal(judgment.verdict, "NOT_EVALUATED");
      assert.equal(judgment.status, "blocked");
      assert.equal(judgment.successful, false);
      assert.equal(judgment.loadSuccessful, false);
      assert.equal(judgment.failureCategory, category);
      assert.equal(judgment.failedPhase, "environment");
      assert.ok(judgment.reasonCodes.includes(category));
      assert.ok(judgment.reasonCodes.includes("environment-blocker:jdk-missing"));
      assert.ok(judgment.reasonCodes.includes("environment-unresolved:dependency-source"));
      assert.equal(evidenceSufficiency(evidence, judgment).sufficient, false);
    }
  });
}

test("strict missing, missing-state, and invalid-state proof are unverified", () => {
  for (const [environment, reason] of [
    [undefined, "environment-evidence-missing"],
    [{}, "environment-state-missing"],
    [{ state: "ready" }, "environment-state-invalid"],
  ]) {
    const evidence = cleanEvidence({ environmentRequired: true, environment });
    const judgment = evaluateT1(evidence);
    assert.equal(judgment.verdict, "NOT_EVALUATED");
    assert.equal(judgment.failureCategory, "environment-unverified");
    assert.ok(judgment.reasonCodes.includes(reason));
  }
  const evidence = cleanEvidence();
  delete evidence.environmentEvidence;
  evidence.environmentRequired = true;
  assert.equal(evaluateT1(evidence).verdict, "NOT_EVALUATED");
});

test("strict ENV_READY preserves normal provider evaluation and provenance", () => {
  const evidence = cleanEvidence({ environmentRequired: true, environment: ready });
  assert.equal(evaluateT1(evidence).verdict, "PASS");
  assert.equal(evidence.ruleVersion, T1_ENVIRONMENT_RULE_VERSION);
  assert.equal(evidence.collectorVersion, T1_ENVIRONMENT_COLLECTOR_VERSION);
  assert.equal(evidence.environmentEvidence.required, true);
  assert.equal(evidence.environmentEvidence.eligible, true);
  assert.deepEqual(evidence.environmentEvidence.provenance, {
    project: ready.project,
    commit: ready.commit,
    operatingSystem,
    planHash: ready.planHash,
    lockHash: ready.lockHash,
  });
  evidence.providerEvidence.state = "error";
  assert.equal(evaluateT1(evidence).failureCategory, "provider-import-failed");
});

test("strict infrastructure failures are not evaluated even when the environment is ready", () => {
  for (const harnessError of ["Marketplace HTTP 503", "VSCode launch failed", "screenshot transport failed"]) {
    const evidence = cleanEvidence({
      environmentRequired: true,
      environment: { ...ready, workspaceMode: "prebuilt-workspace" },
      harnessError,
    });
    const judgment = evaluateT1(evidence);
    assert.equal(evidence.environmentEvidence.state, "ENV_READY");
    assert.equal(evidence.environmentEvidence.eligible, true);
    assert.equal(evidence.environmentEvidence.workspaceMode, "prebuilt-workspace");
    assert.equal(judgment.verdict, "NOT_EVALUATED");
    assert.equal(judgment.status, "blocked");
    assert.equal(judgment.successful, false);
    assert.equal(judgment.failureCategory, "infrastructure-error");
    assert.equal(judgment.failedPhase, "runner");
    assert.equal(judgment.eligibility, "infrastructure-ineligible");
    assert.deepEqual(judgment.reasonCodes, ["harness-error", "infrastructure-error"]);
    assert.equal(evidenceSufficiency(evidence, judgment).reason, "infrastructure-ineligible");
  }
  const evidence = cleanEvidence({
    environmentRequired: true, environment: ready,
  });
  evidence.harnessEvidence = { error: "uncategorized startup failure" };
  assert.equal(evaluateT1(evidence).verdict, "NOT_EVALUATED");
});

test("strict started-provider fatal evidence remains FAIL despite secondary harness errors", () => {
  for (const providerPatch of [
    { providerFatalEvidence: ["server-crashed"] },
    { importStatus: "import-failed" },
    { state: "error" },
  ]) {
    const evidence = cleanEvidence({
      environmentRequired: true, environment: ready,
      harnessError: "subsequent screenshot failure",
    });
    Object.assign(evidence.providerEvidence, providerPatch);
    const judgment = evaluateT1(evidence);
    assert.equal(judgment.verdict, "FAIL");
    assert.equal(judgment.failureCategory, "provider-import-failed");
  }
  const legacy = cleanEvidence({
    environment: ready, harnessError: "Marketplace HTTP 503",
  });
  assert.equal(evaluateT1(legacy).verdict, "FAIL");
  assert.equal(evaluateT1(legacy).failureCategory, "runner-error");
  legacy.providerEvidence.providerFatalEvidence = ["server-crashed"];
  assert.equal(evaluateT1(legacy).failureCategory, "runner-error");
});

test("legacy evidence and replay remain opt-in and keep v4 judgments", (t) => {
  const previous = process.env.T1_REQUIRE_ENVIRONMENT_READY;
  process.env.T1_REQUIRE_ENVIRONMENT_READY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.T1_REQUIRE_ENVIRONMENT_READY;
    else process.env.T1_REQUIRE_ENVIRONMENT_READY = previous;
  });
  const legacy = cleanEvidence();
  delete legacy.environmentEvidence;
  assert.equal(legacy.ruleVersion, "t1-v4");
  assert.equal(legacy.collectorVersion, "t1-v4");
  assert.equal(evaluateT1(legacy).verdict, "PASS");
  assert.equal(normalizedEvidenceFromArtifacts({
    normalizedEvidence: legacy, result: {},
  }), legacy);
  legacy.environmentEvidence = { state: "ENV_BLOCKED" };
  assert.equal(evaluateT1(legacy).verdict, "PASS");
  const optional = cleanEvidence({ environment: { state: "ENV_BLOCKED" } });
  assert.equal(optional.environmentEvidence.required, false);
  assert.equal(evaluateT1(optional).verdict, "PASS");
  const reconstructed = normalizedEvidenceFromArtifacts({
    result: { project: "legacy", product: "oracle", loadStatus: "not-loaded" },
  });
  assert.equal(reconstructed.environmentEvidence.required, false);
  assert.equal(evaluateT1(reconstructed).failureCategory, "provider-load-failed");
});

test("replay handles captured strict evidence and result-only opt-in", () => {
  const result = createEnvironmentBlockedResult({
    project: "demo", provider: "jdtls", operatingSystem,
    environment: { ...ready, state: "ENV_BLOCKED" },
  });
  assert.equal(evaluateT1(normalizedEvidenceFromArtifacts({ result })).verdict, "NOT_EVALUATED");
  const withoutEmbedded = { ...result };
  delete withoutEmbedded.normalizedEvidence;
  assert.equal(evaluateT1(normalizedEvidenceFromArtifacts({
    result: withoutEmbedded,
  })).failureCategory, "environment-blocked");
  const legacy = cleanEvidence();
  delete legacy.environmentEvidence;
  const reconstructed = normalizedEvidenceFromArtifacts({
    normalizedEvidence: legacy,
    result: { environmentRequired: true },
  });
  assert.equal(evaluateT1(reconstructed).failureCategory, "environment-unverified");
});

test("pre-install blocked helper has no fabricated provider or clean diagnostic evidence", () => {
  const result = createEnvironmentBlockedResult({
    project: { id: "demo" }, provider: "oracle", operatingSystem,
    environment: { ...ready, state: "PROJECT_BASELINE_FAILED" },
    harnessCommit: "harness-sha",
  });
  assert.equal(result.verdict, "NOT_EVALUATED");
  assert.equal(result.status, "blocked");
  assert.equal(result.project, "demo");
  assert.equal(result.environmentRequired, true);
  assert.equal(result.providerState, "unknown");
  assert.equal(result.semanticState, "not-run");
  assert.equal(result.diagnosticState, "not-captured");
  assert.equal(result.errorCount, null);
  assert.equal(result.warningCount, null);
  assert.equal(result.totalDurationMs, null);
  assert.deepEqual(result.normalizedEvidence.diagnosticEvidence.counts, {
    error: null, warning: null, information: null, hint: null,
  });
  assert.equal(result.normalizedEvidence.harnessCommit, "harness-sha");
  assert.throws(() => createEnvironmentBlockedResult({
    project: "demo", provider: "oracle", operatingSystem, environment: ready,
  }), /ENV_READY/);
});

test("pairing gates before verdicts while absent provider artifacts stay incomplete", () => {
  const base = { project: "demo", operatingSystem, verdict: "FAIL" };
  for (const blocked of [
    { ...base, verdict: "NOT_EVALUATED" },
    { ...base, environmentRequired: true, environmentState: "ENV_BLOCKED" },
    { ...base, verdict: "PASS", environmentRequired: true },
  ]) {
    const pair = buildProviderComparisons([
      { ...blocked, provider: "jdtls" },
      { ...base, provider: "oracle" },
    ])[0];
    assert.equal(pair.outcome, "environment-ineligible");
    assert.equal(pair.jdtls.verdict, "NOT_EVALUATED");
    assert.equal(pair.environmentEligible, false);
    const summary = summarizeProviderComparisons([pair]);
    assert.equal(summary.eligiblePairCount, 0);
    assert.equal(summary.providerSuccessRates.jdtls.successRate, null);
  }
  const blocked = { ...base, verdict: "NOT_EVALUATED", provider: "jdtls" };
  assert.equal(buildProviderComparisons([blocked])[0].outcome, "incomplete");
  assert.equal(buildProviderComparisons([
    blocked, { ...base, provider: "oracle", loadStatus: "missing-result" },
  ])[0].outcome, "incomplete");
  assert.equal(buildProviderComparisons([
    { ...base, provider: "jdtls" }, { ...base, provider: "oracle" },
  ])[0].outcome, "both-fail");
});

function fixture(t) {
  const root = path.join(import.meta.dirname, `environment-eligibility-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeResult(root, result) {
  const directory = path.join(root, "input", `${result.project}-${result.product}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
  return directory;
}

test("aggregation retains scoped ineligible and incomplete results with eligible denominators", (t) => {
  const root = fixture(t);
  const projects = ["good", "blocked", "unverified", "partial"];
  const providers = ["jdtls", "oracle"];
  for (const project of projects) {
    for (const provider of providers) {
      if (project === "partial" && provider === "oracle") continue;
      const environment = project === "unverified"
        ? undefined : { ...ready, project, state: "ENV_BLOCKED" };
      const result = project === "good" ? {
        project, product: provider, operatingSystem,
        ruleVersion: T1_ENVIRONMENT_RULE_VERSION,
        environmentRequired: true, environmentState: "ENV_READY",
        verdict: provider === "jdtls" ? "PASS" : "FAIL",
        status: provider === "jdtls" ? "success" : "failure",
        errorCount: provider === "jdtls" ? 0 : 1,
        warningCount: 0,
      } : createEnvironmentBlockedResult({ project, provider, operatingSystem, environment });
      writeResult(root, result);
    }
  }
  const { aggregate, comparisons, comparisonSummary } = summarizeComparison({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: projects.flatMap((project) => providers.map((provider) => ({
      project: { id: project }, provider, os: operatingSystem,
    }))) },
  });
  assert.equal(aggregate.expectedCount, 8);
  assert.equal(aggregate.resultCount, 7);
  assert.equal(aggregate.eligibleCount, 2);
  assert.equal(aggregate.successCount, 1);
  assert.equal(aggregate.successRate, 0.5);
  assert.equal(aggregate.failureCount, 2);
  assert.equal(aggregate.eligibleFailureCount, 1);
  assert.equal(aggregate.invalidCount, 5);
  assert.equal(aggregate.environmentIneligibleCount, 5);
  assert.equal(aggregate.missingCount, 1);
  assert.deepEqual(aggregate.scopedProjects, [...projects].sort());
  assert.equal(aggregate.providers.find((row) => row.provider === "jdtls").successRate, 1);
  assert.equal(aggregate.operatingSystems[0].successRate, 0.5);
  for (const row of aggregate.results.filter((row) => row.environmentEligible === false)) {
    assert.equal(row.status, "blocked");
    assert.equal(row.verdict, "NOT_EVALUATED");
    assert.equal(row.errorCount, null);
    assert.equal(row.warningCount, null);
    assert.equal(row.totalDurationMs, null);
  }
  assert.equal(comparisonSummary.eligiblePairCount, 1);
  assert.equal(comparisonSummary.invalidPairCount, 2);
  assert.equal(comparisonSummary.incompleteCount, 1);
  assert.equal(comparisonSummary.providerSuccessRates.jdtls.successRate, 1);
  assert.equal(comparisonSummary.providerSuccessRates.oracle.successRate, 0);
  assert.equal(comparisons.find((row) => row.project === "partial").outcome, "incomplete");
  assert.equal(comparisons.find((row) => row.project === "partial").oracle.environmentRequired, null);
  assert.equal(comparisons.find((row) => row.project === "blocked").errorDelta, null);
  for (const name of ["aggregate-results.csv", "jdtls-oracle-comparison.csv"]) {
    assert.match(fs.readFileSync(path.join(root, "output", name), "utf8"), /environmentState/);
    assert.match(fs.readFileSync(path.join(root, "output", name), "utf8"), /ENV_BLOCKED/);
  }
  for (const name of ["aggregate-summary.md", "jdtls-oracle-comparison.md"]) {
    assert.match(fs.readFileSync(path.join(root, "output", name), "utf8"), /environment-ineligible/);
    assert.match(fs.readFileSync(path.join(root, "output", name), "utf8"), /ENV_UNVERIFIED/);
  }
});

test("aggregation enforces normalized strict proof without changing legacy semantics", (t) => {
  const root = fixture(t);
  const directory = writeResult(root, {
    project: "strict", product: "jdtls", operatingSystem,
    ruleVersion: "t1-v4", status: "success", verdict: "PASS",
  });
  fs.writeFileSync(path.join(directory, "normalized-evidence.json"), JSON.stringify(
    cleanEvidence({ environmentRequired: true }),
  ));
  writeResult(root, {
    project: "legacy", product: "jdtls", operatingSystem,
    ruleVersion: "t1-v4", status: "success", verdict: "PASS",
    environment: { state: "ENV_BLOCKED" },
  });
  const summary = summarizeResults({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: ["strict", "legacy"].map((project) => ({
      project: { id: project }, provider: "jdtls", os: operatingSystem,
    })) },
  });
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failureCount, 0);
  assert.equal(summary.invalidCount, 1);
  assert.equal(summary.successRate, 1);
  assert.equal(summary.ruleVersion, "mixed");
  assert.equal(summary.results.find((row) => row.project === "strict").verdict, "NOT_EVALUATED");
  assert.equal(summary.results.find((row) => row.project === "legacy").verdict, "PASS");
});

test("all-ineligible aggregation has no failure or fake zero-percent success rate", (t) => {
  const root = fixture(t);
  const providers = ["jdtls", "oracle"];
  for (const provider of providers) {
    writeResult(root, createEnvironmentBlockedResult({
      project: "demo", provider, operatingSystem,
    }));
  }
  const { aggregate, comparisonSummary } = summarizeComparison({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: providers.map((provider) => ({
      project: { id: "demo" }, provider, os: operatingSystem,
    })) },
  });
  assert.equal(aggregate.successCount, 0);
  assert.equal(aggregate.failureCount, 0);
  assert.equal(aggregate.eligibleCount, 0);
  assert.equal(aggregate.successRate, null);
  assert.equal(aggregate.providers[0].successRate, null);
  assert.equal(comparisonSummary.outcomeCounts["both-fail"], 0);
  assert.equal(comparisonSummary.outcomeCounts["environment-ineligible"], 1);
  assert.equal(comparisonSummary.providerSuccessRates.oracle.successRate, null);
});

test("strict infrastructure failures stay out of row and paired provider denominators", (t) => {
  const root = fixture(t);
  const projects = ["ready", "infrastructure", "provider-fatal"];
  const providers = ["jdtls", "oracle"];
  for (const project of projects) {
    for (const provider of providers) {
      const evidence = cleanEvidence({
        project, provider,
        environmentRequired: true, environment: { ...ready, project },
        harnessError: project === "ready" ? null : "Marketplace HTTP 503",
      });
      if (project === "provider-fatal") {
        evidence.providerEvidence.providerFatalEvidence = ["server-crashed"];
      }
      const judgment = evaluateT1(evidence);
      const result = {
        project, product: provider, operatingSystem,
        ruleVersion: evidence.ruleVersion,
        environmentRequired: true, environmentState: "ENV_READY",
        ...judgment,
        normalizedEvidence: evidence,
      };
      if (project === "infrastructure" && provider === "oracle") {
        // A runner's older hardcoded FAIL must not bypass captured strict eligibility.
        result.verdict = "FAIL";
        result.status = "failure";
        delete result.eligibility;
      }
      writeResult(root, result);
    }
  }
  const { aggregate, comparisons, comparisonSummary } = summarizeComparison({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: projects.flatMap((project) => providers.map((provider) => ({
      project: { id: project }, provider, os: operatingSystem,
    }))) },
  });
  assert.equal(aggregate.eligibleCount, 4);
  assert.equal(aggregate.successCount, 2);
  assert.equal(aggregate.failureCount, 2);
  assert.equal(aggregate.successRate, 0.5);
  assert.equal(aggregate.environmentIneligibleCount, 0);
  assert.equal(aggregate.infrastructureIneligibleCount, 2);
  assert.equal(aggregate.invalidCount, 2);
  for (const row of aggregate.results.filter((row) => row.project === "infrastructure")) {
    assert.equal(row.verdict, "NOT_EVALUATED");
    assert.equal(row.environmentState, "ENV_READY");
    assert.equal(row.environmentEligible, true);
    assert.equal(row.evaluationEligible, false);
    assert.equal(row.eligibility, "infrastructure-ineligible");
    assert.equal(row.errorCount, null);
    assert.match(row.reasonCodes, /harness-error/);
  }
  assert.equal(comparisons.find((row) => row.project === "infrastructure").outcome, "infrastructure-ineligible");
  assert.equal(comparisons.find((row) => row.project === "provider-fatal").outcome, "both-fail");
  assert.equal(comparisonSummary.infrastructureIneligibleCount, 1);
  assert.equal(comparisonSummary.eligiblePairCount, 2);
  assert.equal(comparisonSummary.providerSuccessRates.jdtls.successRate, 0.5);
  assert.equal(comparisonSummary.providerSuccessRates.oracle.successRate, 0.5);
  assert.match(
    fs.readFileSync(path.join(root, "output", "jdtls-oracle-comparison.csv"), "utf8"),
    /infrastructure-ineligible/,
  );
});

test("legacy harness failures remain eligible FAIL in aggregation", (t) => {
  const root = fixture(t);
  const evidence = cleanEvidence({ harnessError: "Marketplace HTTP 503" });
  writeResult(root, {
    project: "demo", product: "jdtls", operatingSystem,
    ruleVersion: "t1-v4", ...evaluateT1(evidence),
    normalizedEvidence: evidence,
  });
  const summary = summarizeResults({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: [{
      project: { id: "demo" }, provider: "jdtls", os: operatingSystem,
    }] },
  });
  assert.equal(summary.results[0].verdict, "FAIL");
  assert.equal(summary.results[0].failureCategory, "runner-error");
  assert.equal(summary.eligibleCount, 1);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.infrastructureIneligibleCount, 0);
  assert.equal(summary.successRate, 0);
});

test("result-only strict infrastructure proof is excluded without assuming missing providers", (t) => {
  const root = fixture(t);
  const result = {
    project: "demo", product: "jdtls", provider: "jdtls", operatingSystem,
    ruleVersion: "t1-v5",
    environmentRequired: true, environmentState: "ENV_READY",
    verdict: "FAIL", status: "failure", failureCategory: "runner-error",
    error: "VSCode launch failed", diagnosticsCaptured: false,
    errorCount: 0, warningCount: 0,
  };
  writeResult(root, result);
  assert.equal(evaluateT1(normalizedEvidenceFromArtifacts({ result })).verdict, "NOT_EVALUATED");
  assert.equal(buildProviderComparisons([
    result, { ...result, provider: "oracle", failureCategory: "", verdict: "PASS" },
  ])[0].outcome, "infrastructure-ineligible");
  const { aggregate, comparisons } = summarizeComparison({
    resultsDirectory: path.join(root, "input"),
    outputDirectory: path.join(root, "output"),
    matrix: { include: ["jdtls", "oracle"].map((provider) => ({
      project: { id: "demo" }, provider, os: operatingSystem,
    })) },
  });
  assert.equal(aggregate.eligibleCount, 0);
  assert.equal(aggregate.infrastructureIneligibleCount, 1);
  assert.equal(aggregate.missingCount, 1);
  assert.equal(aggregate.results[0].errorCount, null);
  assert.equal(aggregate.results[0].warningCount, null);
  assert.equal(comparisons[0].outcome, "incomplete");
  assert.equal(comparisons[0].jdtls.eligibility, "infrastructure-ineligible");
  assert.equal(comparisons[0].oracle.environmentRequired, null);
});
