import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createComparisonMatrix,
} from "./create-jdtls-oracle-matrix.mjs";
import { loadProjects } from "./create-matrix.mjs";
import { resultEnvironment, summarizeResults } from "./summarize-results.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function comparisonKey(row) {
  return `${row.project}|${row.operatingSystem}`;
}

function resultSummary(row) {
  const environment = resultEnvironment(row);
  const missing = environment.eligibility === "incomplete";
  return {
    verdict: missing ? "MISSING" : environment.evaluationEligible
      ? row?.verdict ?? "MISSING" : "NOT_EVALUATED",
    ...environment,
    providerState: row?.providerState ?? "missing",
    projectHealth: row?.projectHealth ?? "missing",
    semanticState: row?.semanticState ?? "missing",
    diagnosticState: row?.diagnosticState ?? "missing",
    errorCount: row?.errorCount ?? null,
    warningCount: row?.warningCount ?? null,
    totalDurationMs: row?.totalDurationMs ?? null,
    failureCategory: row?.failureCategory ?? "missing-result-artifact",
  };
}

function outcome(jdtls, oracle) {
  if (!jdtls || !oracle ||
      [jdtls, oracle].some((row) => resultEnvironment(row).eligibility === "incomplete")) {
    return "incomplete";
  }
  if ([jdtls, oracle].some(
    (row) => resultEnvironment(row).eligibility === "environment-ineligible",
  )) {
    return "environment-ineligible";
  }
  if ([jdtls, oracle].some(
    (row) => resultEnvironment(row).eligibility === "infrastructure-ineligible",
  )) {
    return "infrastructure-ineligible";
  }
  if (jdtls.verdict === "PASS" && oracle.verdict === "PASS") {
    return "both-pass";
  }
  if (jdtls.verdict === "PASS") {
    return "jdtls-only-pass";
  }
  if (oracle.verdict === "PASS") {
    return "oracle-only-pass";
  }
  return "both-fail";
}

export function buildProviderComparisons(results) {
  const grouped = new Map();
  for (const row of results) {
    const key = comparisonKey(row);
    const group = grouped.get(key) ?? {
      project: row.project,
      operatingSystem: row.operatingSystem,
    };
    group[row.provider] = row;
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => {
      const jdtls = resultSummary(group.jdtls);
      const oracle = resultSummary(group.oracle);
      const pairOutcome = outcome(group.jdtls, group.oracle);
      const eligibility = ["incomplete", "environment-ineligible", "infrastructure-ineligible"].includes(pairOutcome)
        ? pairOutcome : "eligible";
      return {
        project: group.project,
        operatingSystem: group.operatingSystem,
        outcome: pairOutcome,
        environmentState: jdtls.environmentState === oracle.environmentState
          ? jdtls.environmentState : "mixed",
        environmentEligible: eligibility === "incomplete" ? null : eligibility !== "environment-ineligible",
        evaluationEligible: eligibility === "incomplete" ? null : eligibility === "eligible",
        eligibility,
        sameVerdict: jdtls.verdict === oracle.verdict,
        sameDiagnosticState:
          jdtls.diagnosticState === oracle.diagnosticState,
        errorDelta:
          jdtls.errorCount === null || oracle.errorCount === null
            ? null
            : oracle.errorCount - jdtls.errorCount,
        durationDeltaMs:
          jdtls.totalDurationMs === null || oracle.totalDurationMs === null
            ? null
            : oracle.totalDurationMs - jdtls.totalDurationMs,
        jdtls,
        oracle,
      };
    })
    .sort(
      (left, right) =>
        left.project.localeCompare(right.project) ||
        left.operatingSystem.localeCompare(right.operatingSystem),
    );
}

export function summarizeProviderComparisons(comparisons) {
  const eligible = comparisons.filter((row) => row.eligibility === "eligible");
  const outcomeCounts = Object.fromEntries(
    ["both-pass", "jdtls-only-pass", "oracle-only-pass", "both-fail",
      "environment-ineligible", "infrastructure-ineligible", "incomplete"].map((name) => [
      name, comparisons.filter((row) => row.outcome === name).length,
    ]),
  );
  return {
    scopedProjects: [...new Set(comparisons.map((row) => row.project))].sort(),
    scopedProjectCount: new Set(comparisons.map((row) => row.project)).size,
    scopedPairCount: comparisons.length,
    eligiblePairCount: eligible.length,
    invalidCount: outcomeCounts["environment-ineligible"] + outcomeCounts["infrastructure-ineligible"],
    invalidPairCount: outcomeCounts["environment-ineligible"] + outcomeCounts["infrastructure-ineligible"],
    environmentIneligibleCount: outcomeCounts["environment-ineligible"],
    infrastructureIneligibleCount: outcomeCounts["infrastructure-ineligible"],
    incompleteCount: outcomeCounts.incomplete,
    outcomeCounts,
    providerSuccessRates: Object.fromEntries(["jdtls", "oracle"].map((provider) => {
      const successCount = eligible.filter((row) => row[provider].verdict === "PASS").length;
      return [provider, {
        successCount,
        eligibleCount: eligible.length,
        successRate: eligible.length ? successCount / eligible.length : null,
      }];
    })),
  };
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeComparisonCsv(filePath, comparisons) {
  const fields = [
    "project",
    "operatingSystem",
    "outcome",
    "environmentState",
    "eligibility",
    "environmentEligible",
    "evaluationEligible",
    "jdtlsEnvironmentState",
    "oracleEnvironmentState",
    "jdtlsEnvironmentRequired",
    "oracleEnvironmentRequired",
    "jdtlsEligibility",
    "oracleEligibility",
    "jdtlsVerdict",
    "oracleVerdict",
    "jdtlsErrors",
    "oracleErrors",
    "errorDelta",
    "jdtlsDurationMs",
    "oracleDurationMs",
    "durationDeltaMs",
  ];
  const rows = comparisons.map((row) => ({
    project: row.project,
    operatingSystem: row.operatingSystem,
    outcome: row.outcome,
    environmentState: row.environmentState,
    eligibility: row.eligibility,
    environmentEligible: row.environmentEligible,
    evaluationEligible: row.evaluationEligible,
    jdtlsEnvironmentState: row.jdtls.environmentState,
    oracleEnvironmentState: row.oracle.environmentState,
    jdtlsEnvironmentRequired: row.jdtls.environmentRequired,
    oracleEnvironmentRequired: row.oracle.environmentRequired,
    jdtlsEligibility: row.jdtls.eligibility,
    oracleEligibility: row.oracle.eligibility,
    jdtlsVerdict: row.jdtls.verdict,
    oracleVerdict: row.oracle.verdict,
    jdtlsErrors: row.jdtls.errorCount,
    oracleErrors: row.oracle.errorCount,
    errorDelta: row.errorDelta,
    jdtlsDurationMs: row.jdtls.totalDurationMs,
    oracleDurationMs: row.oracle.totalDurationMs,
    durationDeltaMs: row.durationDeltaMs,
  }));
  fs.writeFileSync(
    filePath,
    `${[
      fields.join(","),
      ...rows.map((row) =>
        fields.map((field) => csvValue(row[field])).join(",")
      ),
    ].join("\n")}\n`,
  );
}

function comparisonMarkdown(comparisons) {
  const summary = summarizeProviderComparisons(comparisons);
  const counts = summary.outcomeCounts;
  return [
    "## JDT LS versus Oracle comparison",
    "",
    `**Projects:** ${comparisons.length}; both pass: ${counts["both-pass"]}; ` +
      `JDT LS only: ${counts["jdtls-only-pass"]}; ` +
      `Oracle only: ${counts["oracle-only-pass"]}; ` +
      `both fail: ${counts["both-fail"]}; ` +
      `environment-ineligible: ${counts["environment-ineligible"]}; incomplete: ${counts.incomplete}.`,
    `Infrastructure-ineligible: ${counts["infrastructure-ineligible"]}.`,
    "",
    `**Scoped projects:** ${summary.scopedProjectCount}; eligible pairs: ${summary.eligiblePairCount}; ` +
      `invalid pairs: ${summary.invalidPairCount}.`,
    "",
    "**Eligible paired success:** " + ["jdtls", "oracle"].map((provider) => {
      const row = summary.providerSuccessRates[provider];
      return `${provider}: ${row.successCount}/${row.eligibleCount}`;
    }).join("; ") + ".",
    "",
    "| Project | OS | Outcome | Eligibility | Environment J/O | JDT LS | Oracle | Errors J/O | Duration J/O |",
    "|---|---|---|---|---|---|---|---:|---:|",
    ...comparisons.map((row) => {
      const duration = (value) =>
        value === null ? "-" : `${(value / 1000).toFixed(1)}s`;
      return (
        `| ${row.project} | ${row.operatingSystem} | ${row.outcome} | ` +
        `${row.eligibility} | ${row.jdtls.environmentState}/${row.oracle.environmentState} | ` +
        `${row.jdtls.verdict} | ${row.oracle.verdict} | ` +
        `${row.jdtls.errorCount ?? "-"}/${row.oracle.errorCount ?? "-"} | ` +
        `${duration(row.jdtls.totalDurationMs)}/${duration(row.oracle.totalDurationMs)} |`
      );
    }),
    "",
  ].join("\n");
}

export function summarizeComparison({
  resultsDirectory,
  matrix,
  outputDirectory,
  summaryPath,
}) {
  const aggregate = summarizeResults({
    resultsDirectory,
    matrix,
    outputDirectory,
    summaryPath,
  });
  const comparisons = buildProviderComparisons(aggregate.results);
  const comparisonSummary = summarizeProviderComparisons(comparisons);
  const document = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    providers: ["jdtls", "oracle"],
    ...comparisonSummary,
    comparisons,
  };
  fs.writeFileSync(
    path.join(outputDirectory, "jdtls-oracle-comparison.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  writeComparisonCsv(
    path.join(outputDirectory, "jdtls-oracle-comparison.csv"),
    comparisons,
  );
  const markdown = comparisonMarkdown(comparisons);
  fs.writeFileSync(
    path.join(outputDirectory, "jdtls-oracle-comparison.md"),
    `${markdown}\n`,
  );
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${markdown}\n`);
  }
  return { aggregate, comparisons, comparisonSummary };
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resultsDirectory = path.resolve(
    argument("--results", path.join(scriptDirectory, "comparison-input")),
  );
  const outputDirectory = path.resolve(
    argument("--output", path.join(scriptDirectory, "comparison-output")),
  );
  const matrixJson = argument("--matrix-json", process.env.T1_MATRIX_JSON);
  const matrix = matrixJson
    ? JSON.parse(matrixJson)
    : {
        include: createComparisonMatrix({
          projects: loadProjects(),
          requestedProjects: argument("--projects", ""),
          projectCount: Number(argument("--project-count", "10")),
          operatingSystem: argument("--os", "windows-latest"),
          exclusions: argument("--exclude", ""),
        }).matrixEntries,
      };
  const result = summarizeComparison({
    resultsDirectory,
    matrix,
    outputDirectory,
    summaryPath: argument("--summary", process.env.GITHUB_STEP_SUMMARY),
  });
  console.log(
    `Compared ${result.comparisons.length} JDT LS and Oracle project pair(s).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
