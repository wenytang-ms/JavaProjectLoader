import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createComparisonMatrix,
  selectComparisonProjects,
} from "../create-jdtls-oracle-matrix.mjs";
import { loadProjects } from "../create-matrix.mjs";
import {
  buildProviderComparisons,
  summarizeComparison,
} from "../summarize-jdtls-oracle.mjs";

function writeResult(root, artifact, result) {
  const directory = path.join(root, artifact);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "result.json"),
    JSON.stringify(result),
  );
}

test("default pilot selects ten smallest non-dismissed projects", () => {
  const selected = selectComparisonProjects(loadProjects(), "", 10);
  assert.deepEqual(
    selected.map((project) => project.id),
    [
      "tiled",
      "analysis-ik",
      "ip2region",
      "nativescript",
      "javacv",
      "hikaricp",
      "transmittable-thread-local",
      "kryo",
      "the-complete-faang-preparation",
      "xxl-job",
    ],
  );
});

test("comparison matrix pairs JDT LS and Oracle with matching project JDKs", () => {
  const result = createComparisonMatrix({
    projects: loadProjects(),
    projectCount: 10,
    operatingSystem: "windows-latest",
  });
  assert.equal(result.matrixEntries.length, 20);
  for (const project of result.selectedProjects) {
    const entries = result.matrixEntries.filter(
      (entry) => entry.project.id === project.id,
    );
    assert.deepEqual(
      entries.map((entry) => entry.provider).sort(),
      ["jdtls", "oracle"],
    );
    assert.equal(
      entries[0].environment.projectJavaVersion,
      entries[1].environment.projectJavaVersion,
    );
    const oracle = entries.find((entry) => entry.provider === "oracle");
    assert.equal(oracle.environment.runtimeJavaSource, "setup-java");
    assert.equal(oracle.environment.runtimeJavaVersion, "21");
  }
});

test("pairwise comparison distinguishes provider-specific success", () => {
  const comparisons = buildProviderComparisons([
    {
      project: "demo",
      provider: "jdtls",
      operatingSystem: "windows-latest",
      verdict: "PASS",
      diagnosticState: "clean",
      errorCount: 0,
      totalDurationMs: 1000,
    },
    {
      project: "demo",
      provider: "oracle",
      operatingSystem: "windows-latest",
      verdict: "FAIL",
      diagnosticState: "errors",
      errorCount: 2,
      totalDurationMs: 1500,
    },
  ]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].outcome, "jdtls-only-pass");
  assert.equal(comparisons[0].errorDelta, 2);
  assert.equal(comparisons[0].durationDeltaMs, 500);
});

test("comparison summary writes paired JSON CSV and Markdown", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "provider-pair-"));
  const input = path.join(fixture, "input");
  const output = path.join(fixture, "output");
  try {
    for (const provider of ["jdtls", "oracle"]) {
      writeResult(input, `demo-${provider}`, {
        project: "demo",
        product: provider,
        operatingSystem: "windows-latest",
        status: "success",
        verdict: "PASS",
        providerState: "ready",
        projectHealth: "clean",
        semanticState: "ready",
        diagnosticState: "clean",
        errorCount: 0,
        warningCount: 0,
        totalDurationMs: provider === "jdtls" ? 1000 : 1200,
      });
    }
    const result = summarizeComparison({
      resultsDirectory: input,
      matrix: {
        include: ["jdtls", "oracle"].map((provider) => ({
          project: { id: "demo" },
          provider,
          os: "windows-latest",
        })),
      },
      outputDirectory: output,
    });
    assert.equal(result.comparisons[0].outcome, "both-pass");
    assert.ok(fs.existsSync(path.join(output, "jdtls-oracle-comparison.json")));
    assert.ok(fs.existsSync(path.join(output, "jdtls-oracle-comparison.csv")));
    assert.ok(fs.existsSync(path.join(output, "jdtls-oracle-comparison.md")));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("comparison workflow runs the dedicated matrix and summarizer", () => {
  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../.github/workflows/t1-jdtls-oracle.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /default: "10"/);
  assert.match(workflow, /create-jdtls-oracle-matrix\.mjs/);
  assert.match(workflow, /summarize-jdtls-oracle\.mjs/);
  assert.match(workflow, /jdtls-oracle-comparison/);
});
