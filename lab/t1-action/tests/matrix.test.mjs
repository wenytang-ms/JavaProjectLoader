import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatrixEntries,
  excludeMatrixEntries,
  loadProjectEnvironments,
  loadProjects,
} from "../create-matrix.mjs";

test("contains one hundred unique pinned repositories", () => {
  const projects = loadProjects();
  assert.equal(projects.length, 100);
  assert.equal(new Set(projects.map((project) => project.repository)).size, 100);
  assert.equal(new Set(projects.map((project) => project.commit)).size, 100);
});

test("eligible probes use normalized Java paths", () => {
  const projects = loadProjects();
  for (const project of projects) {
    assert.equal(project.t1Eligible, true);
    assert.match(project.relativeFile, /\.java$/);
    assert.doesNotMatch(project.relativeFile, /\\/);
    assert.match(project.sourceSymbol, /^[A-Za-z_$][\w$]*$/);
    assert.equal(Boolean(project.projectSetup), true);
  }
});

test("four batches contain twenty-five projects each", () => {
  const projects = loadProjects();
  for (const batch of [1, 2, 3, 4]) {
    const selected = projects.filter((project) => project.batch === batch);
    assert.equal(selected.length, 25);
    const entries = createMatrixEntries(
      selected,
      ["jdtls", "intellij"],
      ["windows-latest", "macos-latest"],
    );
    assert.equal(entries.length, 100);
  }
});

test("the complete corpus represents four hundred provider cases", () => {
  const entries = createMatrixEntries(
    loadProjects(),
    ["jdtls", "intellij"],
    ["windows-latest", "macos-latest"],
  );
  assert.equal(entries.length, 400);
});

test("case exclusions support the forty-eight-case IntelliJ rerun", () => {
  const projects = loadProjects().filter((project) => project.batch === 1);
  const entries = createMatrixEntries(
    projects,
    ["intellij"],
    ["windows-latest", "macos-latest"],
  );
  const filtered = excludeMatrixEntries(
    entries,
    "zxing:intellij:macos-latest,dbeaver:intellij:macos-latest",
  );
  assert.equal(entries.length, 50);
  assert.equal(filtered.length, 48);
  assert.equal(
    filtered.some(
      (entry) =>
        entry.project.id === "zxing" &&
        entry.os === "macos-latest",
    ),
    false,
  );
});

test("case exclusions reject typos instead of silently changing coverage", () => {
  const entries = createMatrixEntries(
    loadProjects().filter((project) => project.batch === 1),
    ["intellij"],
    ["windows-latest"],
  );
  assert.throws(
    () => excludeMatrixEntries(entries, "missing:intellij:windows-latest"),
    /Unknown excluded case/,
  );
});

test("provider-aware matrix preserves project and runtime JDK roles", () => {
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
  assert.equal(rxJdtls.environment.projectJavaVersion, "26");
  assert.equal(rxJdtls.environment.runtimeJavaVersion, "21");

  const algorithmsIntellij = entries.find(
    (entry) =>
      entry.project.id === "the-algorithms-java" &&
      entry.provider === "intellij",
  );
  assert.equal(algorithmsIntellij.environment.projectJavaVersion, "21");
  assert.equal(algorithmsIntellij.environment.runtimeJavaSource, "bundled");
});

test("environment selection records the reproducible corpus policy", () => {
  const environments = loadProjectEnvironments();
  assert.equal(environments.size, 100);
  for (const environment of environments.values()) {
    assert.equal(typeof environment.csvBaseline.projectType, "string");
    assert.equal(typeof environment.csvBaseline.dismissed, "boolean");
    assert.match(environment.commit, /^[a-f0-9]{40}$/);
  }
});

test("Spring Boot remains in the first canary batch with JDK 25", () => {
  const project = loadProjects().find((entry) => entry.id === "spring-boot");
  assert.equal(project.batch, 1);
  assert.equal(project.javaVersion, "25");
  assert.equal(project.timeoutSeconds, 1800);
});

test("import repair contracts expose required JDKs and toolchains", () => {
  const projects = loadProjects();
  const entries = createMatrixEntries(
    projects.filter((project) =>
      ["btrace", "junit-framework", "micronaut-core", "okhttp"].includes(
        project.id,
      ),
    ),
    ["intellij"],
    ["windows-latest"],
  );
  const byProject = new Map(entries.map((entry) => [entry.project.id, entry]));

  assert.equal(
    byProject.get("btrace").environment.toolchainJavaVersions,
    "8\n11\n17",
  );
  assert.equal(byProject.get("btrace").environment.projectJavaVersion, "24");
  assert.equal(
    byProject.get("junit-framework").environment.projectJavaVersion,
    "25",
  );
  assert.equal(
    byProject.get("micronaut-core").environment.projectJavaVersion,
    "25",
  );
  assert.equal(
    byProject.get("okhttp").environment.projectJavaDistribution,
    "graalvm",
  );
  assert.equal(byProject.get("okhttp").environment.buildTool, "gradle");
});
