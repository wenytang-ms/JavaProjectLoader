import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatrixEntries,
  loadProjectEnvironments,
  loadProjects,
} from "../create-matrix.mjs";

test("contains every requested repository exactly once", () => {
  const projects = loadProjects();
  assert.equal(projects.length, 20);
  assert.equal(new Set(projects.map((project) => project.repository)).size, 20);
});

test("eligible probes use normalized Java paths", () => {
  const projects = loadProjects();
  for (const project of projects.filter((entry) => entry.t1Eligible)) {
    assert.match(project.relativeFile, /\.java$/);
    assert.doesNotMatch(project.relativeFile, /\\/);
    assert.match(project.sourceSymbol, /^[A-Za-z_$][\w$]*$/);
  }
});

test("public action repository contains only runnable T1 cases", () => {
  const projects = loadProjects();
  assert.equal(projects.every((project) => project.t1Eligible), true);
  assert.equal(projects.every((project) => project.projectSetup), true);
});

test("provider-aware matrix carries distinct Algorithms and RxJava JDK roles", () => {
  const selected = loadProjects().filter((project) =>
    ["the-algorithms-java", "rxjava"].includes(project.id),
  );
  const entries = createMatrixEntries(
    selected,
    ["jdtls", "intellij"],
    ["windows-latest"],
  );
  assert.equal(entries.length, 4);

  const rxJdtls = entries.find(
    (entry) => entry.project.id === "rxjava" && entry.provider === "jdtls",
  );
  assert.deepEqual(rxJdtls.environment, {
    configured: true,
    projectJavaVersion: "26",
    projectJavaDistribution: "zulu",
    runtimeJavaSource: "setup-java",
    runtimeJavaVersion: "21",
    runtimeJavaDistribution: "temurin",
  });

  const algorithmsIntellij = entries.find(
    (entry) =>
      entry.project.id === "the-algorithms-java" &&
      entry.provider === "intellij",
  );
  assert.equal(algorithmsIntellij.environment.projectJavaVersion, "21");
  assert.equal(algorithmsIntellij.environment.runtimeJavaSource, "bundled");
});

test("CSV-derived configured case set expands to eighty jobs", () => {
  const expectedIds = [
    "caffeine",
    "commons-codec",
    "commons-lang",
    "elasticsearch",
    "guava",
    "interviews",
    "java-design-patterns",
    "kotlinx-datetime",
    "mall",
    "micronaut-starter",
    "mockito",
    "mpandroidchart",
    "mybatis-3",
    "quarkus-quickstarts",
    "retrofit",
    "rxjava",
    "spark",
    "spring-boot",
    "spring-petclinic",
    "the-algorithms-java",
  ];
  const environments = loadProjectEnvironments();
  assert.equal(environments.size, 20);
  assert.deepEqual([...environments.keys()].sort(), expectedIds);
  for (const environment of environments.values()) {
    assert.equal(typeof environment.csvBaseline.projectType, "string");
    assert.equal(typeof environment.csvBaseline.dismissed, "boolean");
  }
  assert.equal(
    environments.get("mpandroidchart").csvBaseline.selectionException,
    "Retained as the existing experimental Android importer boundary case.",
  );

  const configuredProjects = loadProjects().filter(
    (project) => project.t1Eligible && project.projectSetup,
  );
  const entries = createMatrixEntries(
    configuredProjects,
    ["jdtls", "intellij"],
    ["windows-latest", "macos-latest"],
  );
  assert.equal(entries.length, 80);
});

test("Spring Boot declares stable diagnostic probe files", () => {
  const project = loadProjects().find((entry) => entry.id === "spring-boot");
  assert.equal(project.timeoutSeconds, 1800);
  assert.equal(project.diagnosticProbeFiles.length, 4);
  assert.equal(new Set(project.diagnosticProbeFiles).size, 4);
  for (const relativeFile of project.diagnosticProbeFiles) {
    assert.match(relativeFile, /\.java$/);
    assert.doesNotMatch(relativeFile, /\\/);
  }
});
