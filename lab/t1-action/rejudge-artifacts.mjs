import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceSufficiency,
  evaluateT1,
  normalizedEvidenceFromArtifacts,
  T1_RULE_VERSION,
} from "./t1-evaluator.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function argumentsFor(name) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1]
      ? [process.argv[index + 1]]
      : [],
  );
}

function listResultFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.name === "result.json") {
        files.push(target);
      }
    }
  }
  return files;
}

function readJsonIfPresent(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : null;
}

function resultKey(result) {
  return [
    result.project,
    result.product ?? result.provider,
    result.operatingSystem ?? result.os,
  ].join("|");
}

function completedAt(result) {
  const timestamp = Date.parse(result.completedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function markdown(summary) {
  return [
    "# T1 v4 artifact rejudgment",
    "",
    `Rule: \`${summary.ruleVersion}\``,
    "",
    `Results: ${summary.passCount} PASS, ${summary.failCount} FAIL, ` +
      `${summary.insufficientCount} requiring rerun.`,
    "",
    "| Project | Provider | OS | Verdict | Provider | Project | Semantic | Diagnostics | Reasons | Evidence |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.results.map((row) =>
      `| ${row.project} | ${row.provider} | ${row.operatingSystem} | ` +
      `${row.verdict} | ${row.providerState} | ${row.projectHealth} | ` +
      `${row.semanticState} | ${row.diagnosticState} | ` +
      `${row.reasonCodes.join(", ") || "-"} | ` +
      `${row.evidenceSufficient ? "sufficient" : "rerun required"} |`,
    ),
    "",
  ].join("\n");
}

export function rejudgeArtifacts({
  artifactRoots,
  outputDirectory,
  projects = [],
  ruleVersion = T1_RULE_VERSION,
}) {
  const latest = new Map();
  for (const root of artifactRoots) {
    for (const resultPath of listResultFiles(root)) {
      const result = readJsonIfPresent(resultPath);
      if (projects.length > 0 && !projects.includes(result.project)) {
        continue;
      }
      const key = resultKey(result);
      const existing = latest.get(key);
      if (!existing || completedAt(result) > completedAt(existing.result)) {
        latest.set(key, { result, resultPath });
      }
    }
  }

  const results = [...latest.values()].map(({ result, resultPath }) => {
    const artifactDirectory = path.dirname(resultPath);
    const evidence = normalizedEvidenceFromArtifacts({
      normalizedEvidence: readJsonIfPresent(
        path.join(artifactDirectory, "normalized-evidence.json"),
      ),
      result,
      ruleEvidence: readJsonIfPresent(
        path.join(artifactDirectory, "rule-evidence.json"),
      ),
      diagnostics: readJsonIfPresent(
        path.join(artifactDirectory, "diagnostics-result.json"),
      ),
      runMetadata: readJsonIfPresent(
        path.join(artifactDirectory, "run-metadata.json"),
      ),
    });
    const judgment = evaluateT1(evidence, ruleVersion);
    const sufficiency = evidenceSufficiency(evidence, judgment);
    return {
      project: evidence.project,
      provider: evidence.provider,
      operatingSystem: evidence.operatingSystem,
      verdict: judgment.verdict,
      providerState: evidence.providerEvidence.state,
      projectHealth: evidence.projectEvidence.health,
      semanticState: evidence.semanticEvidence.state,
      diagnosticState: evidence.diagnosticEvidence.state,
      failedPhase: judgment.failedPhase,
      reasonCodes: judgment.reasonCodes,
      evidenceSufficient: sufficiency.sufficient,
      evidenceSufficiencyReason: sufficiency.reason,
      sourceArtifact: artifactDirectory,
      completedAt: result.completedAt ?? null,
      evidence,
      judgment,
    };
  }).sort((left, right) =>
    [
      left.project,
      left.provider,
      left.operatingSystem,
    ].join("|").localeCompare([
      right.project,
      right.provider,
      right.operatingSystem,
    ].join("|")),
  );
  const summary = {
    schemaVersion: 1,
    ruleVersion,
    generatedAt: new Date().toISOString(),
    resultCount: results.length,
    passCount: results.filter((row) => row.verdict === "PASS").length,
    failCount: results.filter((row) => row.verdict === "FAIL").length,
    insufficientCount: results.filter(
      (row) => !row.evidenceSufficient,
    ).length,
    results,
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, "rejudged-results.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outputDirectory, "rejudged-results.md"),
    `${markdown(summary)}\n`,
  );
  return summary;
}

function main() {
  const artifactRoots = argumentsFor("--artifacts").map((value) =>
    path.resolve(value),
  );
  if (artifactRoots.length === 0) {
    throw new Error("At least one --artifacts directory is required.");
  }
  const outputDirectory = path.resolve(
    argument(
      "--output",
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "rejudged-output",
      ),
    ),
  );
  const projects = String(argument("--projects", ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const summary = rejudgeArtifacts({
    artifactRoots,
    outputDirectory,
    projects,
    ruleVersion: argument("--rule", T1_RULE_VERSION),
  });
  console.log(
    `Rejudged ${summary.resultCount} case(s): ${summary.passCount} PASS, ` +
      `${summary.failCount} FAIL, ${summary.insufficientCount} requiring rerun.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
