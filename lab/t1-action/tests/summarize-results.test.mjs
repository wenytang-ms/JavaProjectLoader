import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeResults } from "../summarize-results.mjs";

function writeResult(root, artifact, result) {
  const directory = path.join(root, artifact);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "result.json"),
    JSON.stringify(result),
  );
}

test("aggregate conclusion includes classifications and missing results", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t1-summary-"));
  const resultsDirectory = path.join(fixture, "input");
  const outputDirectory = path.join(fixture, "output");
  const summaryPath = path.join(fixture, "step-summary.md");
  try {
    writeResult(resultsDirectory, "t1-demo-jdtls-Linux", {
      project: "demo",
      product: "jdtls",
      operatingSystem: "ubuntu-latest",
      status: "failure",
      loadStatus: "loaded-with-project-errors",
      providerImportStatus: "loaded-with-project-errors",
      providerTerminalState: "warning",
      failureCategory: "provider-project-errors",
      errorCount: 1,
      warningCount: 0,
      totalDurationMs: 12000,
    });
    writeResult(resultsDirectory, "t1-demo-intellij-Windows", {
      project: "demo",
      product: "intellij",
      operatingSystem: "windows-latest",
      status: "success",
      loadStatus: "success",
      providerImportStatus: "ready",
      providerTerminalState: "ready",
      errorCount: 0,
      warningCount: 2,
      totalDurationMs: 8000,
    });
    const matrix = {
      include: [
        { project: { id: "demo" }, provider: "jdtls", os: "ubuntu-latest" },
        { project: { id: "demo" }, provider: "intellij", os: "windows-latest" },
        { project: { id: "demo" }, provider: "jdtls", os: "macos-latest" },
      ],
    };

    const summary = summarizeResults({
      resultsDirectory,
      matrix,
      outputDirectory,
      summaryPath,
    });

    assert.equal(summary.expectedCount, 3);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.failureCount, 2);
    assert.equal(summary.missingCount, 1);
    assert.equal(summary.loadStatusCounts["loaded-with-project-errors"], 1);
    assert.equal(summary.loadStatusCounts["missing-result"], 1);
    assert.match(
      fs.readFileSync(summaryPath, "utf8"),
      /T1 aggregate conclusion/,
    );
    assert.ok(fs.existsSync(path.join(outputDirectory, "aggregate-results.csv")));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("workflow always publishes an aggregate conclusion artifact", () => {
  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../.github/workflows/t1-java-providers.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /name: Aggregate T1 conclusion/);
  assert.match(workflow, /node lab\/t1-action\/summarize-results\.mjs/);
  assert.match(workflow, /name: t1-aggregate-conclusion/);
});
