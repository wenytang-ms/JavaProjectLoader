import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEnvironmentEvidence,
  evaluateT1Eligibility,
  T1_RULE_VERSION,
  T1_ENVIRONMENT_RULE_VERSION,
} from "./t1-evaluator.mjs";

function resultEligibility(row, environmentEvidence) {
  const captured = row.normalizedEvidence ?? row.evidence;
  const infrastructureError = ["runner-error", "infrastructure-error"].includes(row.failureCategory);
  return evaluateT1Eligibility({
    environmentEvidence,
    harnessEvidence: captured?.harnessEvidence ?? row.harnessEvidence ?? {
      state: infrastructureError ? "error" : "ok",
      error: infrastructureError ? row.error ?? row.failureCategory : null,
    },
    providerEvidence: captured?.providerEvidence ?? row.providerEvidence ?? {
      state: row.providerState ?? row.providerTerminalState,
      importStatus: row.providerImportStatus,
      providerFatalEvidence: [],
    },
    projectEvidence: captured?.projectEvidence ?? row.projectEvidence ?? {
      buildEvidence: row.failureCategory === "project-build-failure"
        ? ["project-build-failure"] : [],
    },
  });
}

export function resultEnvironment(row) {
  if (!row || row.loadStatus === "missing-result" || row.verdict === "MISSING") {
    return {
      environmentRequired: null,
      environmentState: "missing",
      environmentEligible: null,
      evaluationEligible: null,
      eligibility: "incomplete",
    };
  }
  const captured = row.environmentEvidence ??
    row.normalizedEvidence?.environmentEvidence ?? row.evidence?.environmentEvidence;
  const environmentRequired = row.environmentRequired === true ||
    captured?.required === true;
  const environmentEvidence = createEnvironmentEvidence({
    environmentRequired,
    environment: captured ?? row.environment ??
      (row.environmentState ? { state: row.environmentState } : null),
  });
  const judgment = resultEligibility(row, environmentEvidence);
  const eligibility = !environmentEvidence.eligible || row.environmentEligible === false ||
    row.eligibility === "environment-ineligible"
    ? "environment-ineligible"
    : judgment?.eligibility === "infrastructure-ineligible" ||
      row.eligibility === "infrastructure-ineligible"
      ? "infrastructure-ineligible"
      : row.verdict === "NOT_EVALUATED"
        ? environmentRequired ? "infrastructure-ineligible" : "environment-ineligible"
        : "eligible";
  return {
    environmentRequired,
    environmentState: !environmentRequired && (
      row.environmentState === "not-required" ||
      (!captured && !row.environment && !row.environmentState)
    ) ? "not-required" : environmentEvidence.state,
    environmentEligible: eligibility !== "environment-ineligible",
    evaluationEligible: eligibility === "eligible",
    eligibility,
    environmentEvidence,
  };
}

function outcomeCounts(rows) {
  const eligible = rows.filter((row) => row.eligibility === "eligible");
  const success = eligible.filter((row) => row.verdict === "PASS").length;
  const environmentIneligibleCount = rows.filter(
    (row) => row.eligibility === "environment-ineligible",
  ).length;
  const infrastructureIneligibleCount = rows.filter(
    (row) => row.eligibility === "infrastructure-ineligible",
  ).length;
  return {
    total: rows.length,
    success,
    failure: rows.filter((row) => row.verdict === "FAIL").length,
    eligibleCount: eligible.length,
    eligibleFailureCount: eligible.filter((row) => row.verdict === "FAIL").length,
    environmentIneligibleCount,
    infrastructureIneligibleCount,
    invalidCount: environmentIneligibleCount + infrastructureIneligibleCount,
    missingCount: rows.filter((row) => row.eligibility === "incomplete").length,
    successRate: eligible.length ? success / eligible.length : null,
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function listResultFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.name === "result.json") {
        files.push(target);
      }
    }
  };
  visit(root);
  return files;
}

function normalizeOs(value, artifactName = "") {
  if (["ubuntu-latest", "windows-latest", "macos-latest"].includes(value)) {
    return value;
  }
  if (artifactName.endsWith("-Linux") || value === "linux") {
    return "ubuntu-latest";
  }
  if (artifactName.endsWith("-Windows") || value === "win32") {
    return "windows-latest";
  }
  if (artifactName.endsWith("-macOS") || value === "darwin") {
    return "macos-latest";
  }
  return value || "unknown";
}

function key(project, provider, operatingSystem) {
  return `${project}|${provider}|${operatingSystem}`;
}

function countBy(rows, field) {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const value = row[field] || "none";
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const fields = [
    "project",
    "provider",
    "operatingSystem",
    "status",
    "loadStatus",
    "providerImportStatus",
    "providerTerminalState",
    "providerState",
    "projectHealth",
    "semanticState",
    "diagnosticState",
    "verdict",
    "environmentRequired",
    "environmentState",
    "environmentEligible",
    "evaluationEligible",
    "eligibility",
    "failureCategory",
    "failedPhase",
    "reasonCodes",
    "ruleVersion",
    "errorCount",
    "warningCount",
    "totalDurationMs",
    "artifact",
  ];
  const lines = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvValue(row[field])).join(",")),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function providerRows(rows) {
  return [...new Set(rows.map((row) => row.provider))].sort().map((provider) => {
    const selected = rows.filter((row) => row.provider === provider);
    return {
      provider,
      ...outcomeCounts(selected),
      importFailed: selected.filter(
        (row) => row.loadStatus === "import-failed",
      ).length,
      projectErrors: selected.filter(
        (row) => row.loadStatus === "loaded-with-project-errors",
      ).length,
      finalizationTimeouts: selected.filter(
        (row) => row.loadStatus === "loaded-finalization-timeout",
      ).length,
      indexingTimeouts: selected.filter(
        (row) => row.loadStatus === "loaded-indexing-timeout",
      ).length,
      uiTimeouts: selected.filter(
        (row) => row.loadStatus === "loaded-ui-timeout",
      ).length,
      notLoaded: selected.filter((row) => row.loadStatus === "not-loaded").length,
    };
  });
}

function osRows(rows) {
  return [...new Set(rows.map((row) => row.operatingSystem))].sort().map(
    (operatingSystem) => {
      const selected = rows.filter(
        (row) => row.operatingSystem === operatingSystem,
      );
      return {
        operatingSystem,
        ...outcomeCounts(selected),
      };
    },
  );
}

function markdown(summary) {
  const lines = [
    "## T1 aggregate conclusion",
    "",
    `**Rule:** ${summary.ruleVersion}`,
    "",
    `**Overall:** ${summary.successCount}/${summary.eligibleCount} eligible results succeeded; ` +
      `${summary.failureCount} failed (including missing artifacts); ` +
      `${summary.environmentIneligibleCount} environment-ineligible; ` +
      `${summary.infrastructureIneligibleCount} infrastructure-ineligible; ` +
      `${summary.missingCount} result artifact(s) missing; ${summary.expectedCount} scoped results.`,
    "",
    `**Scoped projects:** ${summary.scopedProjectCount}; invalid (environment/infrastructure): ${summary.invalidCount}.`,
    "",
    "### Environment eligibility",
    "",
    "| Environment state | Count |",
    "|---|---:|",
    ...Object.entries(summary.environmentStateCounts).map(
      ([state, count]) => `| ${state} | ${count} |`,
    ),
    "",
    "### Outcome classification",
    "",
    "| Load status | Count |",
    "|---|---:|",
    ...Object.entries(summary.loadStatusCounts).map(
      ([status, count]) => `| ${status} | ${count} |`,
    ),
    "",
    "### Failure categories",
    "",
    "| Failure category | Count |",
    "|---|---:|",
    ...Object.entries(summary.failureCategoryCounts).map(
      ([category, count]) => `| ${category} | ${count} |`,
    ),
    "",
    "### Provider conclusion",
    "",
    "| Provider | Eligible success | Failure | Environment ineligible | Infrastructure ineligible | Missing | Import failed | Project errors | Finalization timeout | Indexing timeout | UI timeout | Not loaded |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.providers.map(
      (row) =>
        `| ${row.provider} | ${row.success}/${row.eligibleCount} | ${row.failure} | ` +
        `${row.environmentIneligibleCount} | ${row.infrastructureIneligibleCount} | ${row.missingCount} | ` +
        `${row.importFailed} | ${row.projectErrors} | ` +
        `${row.finalizationTimeouts} | ${row.indexingTimeouts} | ` +
        `${row.uiTimeouts} | ${row.notLoaded} |`,
    ),
    "",
    "### OS conclusion",
    "",
    "| OS | Eligible success | Failure | Environment ineligible | Infrastructure ineligible | Missing |",
    "|---|---:|---:|---:|---:|---:|",
    ...summary.operatingSystems.map(
      (row) =>
        `| ${row.operatingSystem} | ${row.success}/${row.eligibleCount} | ${row.failure} | ` +
        `${row.environmentIneligibleCount} | ${row.infrastructureIneligibleCount} | ${row.missingCount} |`,
    ),
    "",
    "### Detailed results",
    "",
    "| Project | Provider | OS | Verdict | Environment state | Eligibility | Provider | Project | Semantic | Diagnostics | Phase | Reasons | Duration |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---:|",
    ...summary.results.map((row) => {
      const duration = row.totalDurationMs === null
        ? "-"
        : `${(row.totalDurationMs / 1000).toFixed(1)}s`;
      return (
        `| ${row.project} | ${row.provider} | ${row.operatingSystem} | ` +
        `${row.verdict} | ${row.environmentState} | ${row.eligibility} | ` +
        `${row.providerState} | ${row.projectHealth} | ` +
        `${row.semanticState} | ${row.diagnosticState} | ` +
        `${row.failedPhase || "-"} | ${row.reasonCodes || "-"} | ` +
        `${duration} |`
      );
    }),
    "",
  ];
  return lines.join("\n");
}

export function summarizeResults({
  resultsDirectory,
  matrix,
  outputDirectory,
  summaryPath,
}) {
  const expected = matrix.include ?? [];
  const actual = new Map();
  for (const resultFile of listResultFiles(resultsDirectory)) {
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    const evidencePath = path.join(path.dirname(resultFile), "normalized-evidence.json");
    const capturedEvidence = result.normalizedEvidence ??
      (fs.existsSync(evidencePath)
        ? JSON.parse(fs.readFileSync(evidencePath, "utf8"))
        : null);
    const evidenceResult = {
      ...result,
      normalizedEvidence: capturedEvidence,
    };
    const environment = resultEnvironment(evidenceResult);
    const judgment = resultEligibility(evidenceResult, environment.environmentEvidence) ?? {};
    const verdict = judgment.verdict ?? result.verdict ??
      (result.status === "success" ? "PASS" : "FAIL");
    const ineligible = environment.evaluationEligible === false;
    const diagnosticsCaptured = capturedEvidence?.diagnosticEvidence?.captured ??
      result.diagnosticsCaptured ??
      (result.diagnosticState === "not-captured" ? false : undefined);
    const count = (value) => value === null ||
      (ineligible && (value === undefined || diagnosticsCaptured === false))
      ? null : Number(value ?? 0);
    const relative = path.relative(resultsDirectory, resultFile);
    const artifact = relative.split(path.sep)[0];
    const project = result.project;
    const provider = result.product ?? result.provider;
    const operatingSystem = normalizeOs(result.operatingSystem ?? result.os, artifact);
    actual.set(key(project, provider, operatingSystem), {
      project,
      provider,
      operatingSystem,
      status: ineligible ? "blocked" : result.status === "success" ? "success" : "failure",
      verdict: ineligible ? "NOT_EVALUATED" : verdict,
      ...environment,
      loadStatus: judgment.loadStatus ?? result.loadStatus ?? result.status ?? "unknown",
      providerImportStatus: result.providerImportStatus ?? "unknown",
      providerTerminalState: result.providerTerminalState ?? null,
      providerState:
        result.providerState ??
        result.providerTerminalState ??
        "unknown",
      projectHealth: result.projectHealth ?? "unknown",
      semanticState:
        result.semanticState ??
        (result.sourceReady ? "ready" : "unknown"),
      diagnosticState:
        result.diagnosticState ??
        (Number(result.errorCount ?? 0) > 0 ? "errors" : "unknown"),
      failureCategory: judgment.failureCategory ?? result.failureCategory ?? "",
      failedPhase: judgment.failedPhase ?? result.failedPhase ?? "",
      reasonCodes: Array.isArray(judgment.reasonCodes ?? result.reasonCodes)
        ? (judgment.reasonCodes ?? result.reasonCodes).join(";")
        : result.reasonCodes ?? "",
      ruleVersion: environment.environmentRequired
        ? environment.environmentEvidence.ruleVersion
        : result.ruleVersion ?? "legacy",
      errorCount: count(result.errorCount),
      warningCount: count(result.warningCount),
      totalDurationMs:
        result.totalDurationMs === undefined || result.totalDurationMs === null
          ? null
          : Number(result.totalDurationMs),
      artifact,
      resultPath: resultFile,
    });
  }

  const results = expected.map((entry) => {
    const project = entry.project.id;
    const provider = entry.provider;
    const operatingSystem = entry.os;
    return actual.get(key(project, provider, operatingSystem)) ?? {
      project,
      provider,
      operatingSystem,
      status: "failure",
      verdict: "FAIL",
      ...resultEnvironment(null),
      loadStatus: "missing-result",
      providerImportStatus: "unknown",
      providerTerminalState: null,
      providerState: "unknown",
      projectHealth: "unknown",
      semanticState: "unknown",
      diagnosticState: "not-captured",
      failureCategory: "missing-result-artifact",
      failedPhase: "aggregate",
      reasonCodes: "missing-result-artifact",
      ruleVersion: "unknown",
      errorCount: null,
      warningCount: null,
      totalDurationMs: null,
      artifact: "",
      resultPath: "",
    };
  });
  const ruleVersions = [...new Set(
    results
      .filter((row) => row.loadStatus !== "missing-result")
      .map((row) => row.ruleVersion),
  )];
  if (ruleVersions.length > 1 && !ruleVersions.every(
    (version) => [T1_RULE_VERSION, T1_ENVIRONMENT_RULE_VERSION].includes(version),
  )) {
    throw new Error(
      `Aggregate input mixes incompatible rule versions: ${ruleVersions.join(", ")}`,
    );
  }
  const counts = outcomeCounts(results);
  const successCount = counts.success;
  const missingCount = results.filter(
    (row) => row.loadStatus === "missing-result",
  ).length;
  const summary = {
    schemaVersion: 3,
    ruleVersion: ruleVersions.length > 1 ? "mixed" : ruleVersions[0] ?? "unknown",
    ruleVersions,
    generatedAt: new Date().toISOString(),
    expectedCount: expected.length,
    resultCount: expected.length - missingCount,
    missingCount,
    successCount,
    failureCount: counts.failure,
    eligibleCount: counts.eligibleCount,
    eligibleFailureCount: counts.eligibleFailureCount,
    environmentIneligibleCount: counts.environmentIneligibleCount,
    infrastructureIneligibleCount: counts.infrastructureIneligibleCount,
    invalidCount: counts.invalidCount,
    successRate: counts.successRate,
    scopedProjects: [...new Set(results.map((row) => row.project))].sort(),
    scopedProjectCount: new Set(results.map((row) => row.project)).size,
    environmentStateCounts: countBy(results, "environmentState"),
    eligibilityCounts: countBy(results, "eligibility"),
    loadStatusCounts: countBy(results, "loadStatus"),
    failureCategoryCounts: countBy(
      results.filter((row) => row.verdict !== "PASS"),
      "failureCategory",
    ),
    providers: providerRows(results),
    operatingSystems: osRows(results),
    results,
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  const markdownText = markdown(summary);
  fs.writeFileSync(
    path.join(outputDirectory, "aggregate-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeCsv(path.join(outputDirectory, "aggregate-results.csv"), results);
  fs.writeFileSync(
    path.join(outputDirectory, "aggregate-summary.md"),
    `${markdownText}\n`,
  );
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${markdownText}\n`);
  }
  return summary;
}

function main() {
  const resultsDirectory = path.resolve(
    argument("--results", path.join(path.dirname(fileURLToPath(import.meta.url)), "aggregate-input")),
  );
  const outputDirectory = path.resolve(
    argument("--output", path.join(path.dirname(fileURLToPath(import.meta.url)), "aggregate-output")),
  );
  const matrixJson = argument("--matrix-json", process.env.T1_MATRIX_JSON);
  if (!matrixJson) {
    throw new Error("T1 matrix JSON is required.");
  }
  const summary = summarizeResults({
    resultsDirectory,
    matrix: JSON.parse(matrixJson),
    outputDirectory,
    summaryPath: argument("--summary", process.env.GITHUB_STEP_SUMMARY),
  });
  console.log(
    `Aggregated ${summary.resultCount}/${summary.expectedCount} result(s): ` +
      `${summary.successCount} success, ${summary.failureCount} failure.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
