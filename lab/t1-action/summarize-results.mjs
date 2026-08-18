import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    "failureCategory",
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
      total: selected.length,
      success: selected.filter((row) => row.status === "success").length,
      failure: selected.filter((row) => row.status !== "success").length,
      importFailed: selected.filter(
        (row) => row.loadStatus === "import-failed",
      ).length,
      projectErrors: selected.filter(
        (row) => row.loadStatus === "loaded-with-project-errors",
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
        total: selected.length,
        success: selected.filter((row) => row.status === "success").length,
        failure: selected.filter((row) => row.status !== "success").length,
      };
    },
  );
}

function markdown(summary) {
  const lines = [
    "## T1 aggregate conclusion",
    "",
    `**Overall:** ${summary.successCount}/${summary.expectedCount} succeeded; ` +
      `${summary.failureCount} failed; ${summary.missingCount} result artifact(s) missing.`,
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
    "| Provider | Success | Failure | Import failed | Project errors | Not loaded |",
    "|---|---:|---:|---:|---:|---:|",
    ...summary.providers.map(
      (row) =>
        `| ${row.provider} | ${row.success}/${row.total} | ${row.failure} | ` +
        `${row.importFailed} | ${row.projectErrors} | ${row.notLoaded} |`,
    ),
    "",
    "### OS conclusion",
    "",
    "| OS | Success | Failure |",
    "|---|---:|---:|",
    ...summary.operatingSystems.map(
      (row) =>
        `| ${row.operatingSystem} | ${row.success}/${row.total} | ${row.failure} |`,
    ),
    "",
    "### Detailed results",
    "",
    "| Project | Provider | OS | Load status | Terminal | Errors | Warnings | Duration |",
    "|---|---|---|---|---|---:|---:|---:|",
    ...summary.results.map((row) => {
      const duration = row.totalDurationMs === null
        ? "-"
        : `${(row.totalDurationMs / 1000).toFixed(1)}s`;
      return (
        `| ${row.project} | ${row.provider} | ${row.operatingSystem} | ` +
        `${row.loadStatus} | ${row.providerTerminalState ?? "-"} | ` +
        `${row.errorCount} | ${row.warningCount} | ${duration} |`
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
    const relative = path.relative(resultsDirectory, resultFile);
    const artifact = relative.split(path.sep)[0];
    const project = result.project;
    const provider = result.product ?? result.provider;
    const operatingSystem = normalizeOs(result.operatingSystem ?? result.os, artifact);
    actual.set(key(project, provider, operatingSystem), {
      project,
      provider,
      operatingSystem,
      status: result.status === "success" ? "success" : "failure",
      loadStatus: result.loadStatus ?? result.status ?? "unknown",
      providerImportStatus: result.providerImportStatus ?? "unknown",
      providerTerminalState: result.providerTerminalState ?? null,
      failureCategory: result.failureCategory ?? "",
      errorCount: Number(result.errorCount ?? 0),
      warningCount: Number(result.warningCount ?? 0),
      totalDurationMs:
        result.totalDurationMs === undefined
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
      loadStatus: "missing-result",
      providerImportStatus: "unknown",
      providerTerminalState: null,
      failureCategory: "missing-result-artifact",
      errorCount: 0,
      warningCount: 0,
      totalDurationMs: null,
      artifact: "",
      resultPath: "",
    };
  });
  const successCount = results.filter((row) => row.status === "success").length;
  const missingCount = results.filter(
    (row) => row.loadStatus === "missing-result",
  ).length;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    expectedCount: expected.length,
    resultCount: expected.length - missingCount,
    missingCount,
    successCount,
    failureCount: expected.length - successCount,
    loadStatusCounts: countBy(results, "loadStatus"),
    failureCategoryCounts: countBy(
      results.filter((row) => row.status !== "success"),
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
