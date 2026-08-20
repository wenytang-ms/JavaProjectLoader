import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";
import {
  createProjectSettings,
  discoverProjectEnvironment,
  provisionProjectEnvironment,
} from "../project-environment.mjs";
import {
  applyWindowsGradleExecutableExtensions,
  configureGradleToolchainEnvironment,
  gradleSiblingProjectSettings,
  materializeWorkspace,
  writeGradleToolchainProperties,
} from "../run-t1-autotest.mjs";

function writeFixture(root, relativePath, content = "fixture\n") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("workflow limits each twenty-five-project batch to twenty parallel jobs", () => {
  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../.github/workflows/t1-java-providers.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /max-parallel: 20/);
  assert.match(workflow, /--batch "\$\{\{ inputs\.batch \}\}"/);
  assert.match(workflow, /t1-aggregate-conclusion-batch-/);
  assert.match(workflow, /overwrite-settings: false/);
  assert.match(
    workflow,
    /JDK\$\{\{ matrix\.environment\.projectJavaVersion \}\}=\$env:JAVA_HOME/,
  );
});

test("every project exposes complete provider host requirements", () => {
  for (const project of loadProjects()) {
    for (const provider of ["jdtls", "intellij"]) {
      const plan = provisionProjectEnvironment(project, {
        provider,
        dryRun: true,
      });
      assert.equal(plan.status, "planned");
      assert.equal(plan.requirements.projectJava.version, project.javaVersion);
      assert.match(plan.requirements.buildTool, /^(gradle|maven)$/);
    }
  }
});

test("Gradle discovery verifies the pinned wrapper and JDT LS settings", () => {
  const project = loadProjects().find((entry) => entry.id === "rxjava");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t1-rxjava-environment-"));
  try {
    for (const relativePath of project.projectSetup.evidenceFiles) {
      writeFixture(fixture, relativePath);
    }
    for (const files of Object.values(project.projectSetup.buildDescriptors)) {
      for (const relativePath of files) {
        writeFixture(fixture, relativePath);
      }
    }
    writeFixture(
      fixture,
      project.projectSetup.gradleWrapper.path,
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${project.projectSetup.buildToolVersion}-bin.zip\n`,
    );

    const discovery = discoverProjectEnvironment(project, fixture, "jdtls");
    assert.deepEqual(discovery.detection.availableBuildTools, ["gradle"]);
    assert.equal(
      discovery.detection.gradleWrapperVersion,
      project.projectSetup.buildToolVersion,
    );

    const settings = createProjectSettings(project, "jdtls", discovery, {
      T1_LANGUAGE_SERVER_JAVA_HOME: "C:\\jdks\\21",
      T1_PROJECT_JAVA_HOME: "C:\\jdks\\26",
    });
    assert.equal(settings["java.jdt.ls.java.home"], "C:\\jdks\\21");
    assert.equal(settings["java.import.gradle.enabled"], true);
    assert.equal(settings["java.import.maven.enabled"], false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("an unmanaged case validates its generated Maven descriptor", () => {
  const project = loadProjects().find(
    (entry) => entry.syntheticMavenTargetFile,
  );
  assert.ok(project);
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-unmanaged-source-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "t1-unmanaged-workspace-"));
  try {
    for (const relativePath of project.projectSetup.evidenceFiles) {
      writeFixture(checkout, relativePath, `class ${project.sourceSymbol} {}\n`);
    }
    writeFixture(workspace, "pom.xml", "<project />\n");

    const discovery = discoverProjectEnvironment(
      project,
      checkout,
      "jdtls",
      workspace,
    );
    assert.equal(discovery.detection.buildDescriptorRoot, "workspace");
    assert.deepEqual(discovery.detection.availableBuildTools, ["maven"]);
    assert.equal(discovery.detection.descriptors.maven[0].path, "pom.xml");
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Gradle sibling project settings support Groovy and Kotlin DSL", () => {
  assert.equal(
    gradleSiblingProjectSettings(
      "supertokens-plugin-interface",
      "../plugin-interface",
    ),
    "\ninclude ':supertokens-plugin-interface'\n" +
      "project(':supertokens-plugin-interface').projectDir = " +
      "file('../plugin-interface')\n",
  );
  assert.equal(
    gradleSiblingProjectSettings("dependency", "../dependency", true),
    "\ninclude(\":dependency\")\n" +
      "project(\":dependency\").projectDir = file(\"../dependency\")\n",
  );
});

test("Windows Gradle executable paths receive the required extension", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-gradle-exe-"));
  try {
    fs.writeFileSync(
      path.join(checkout, "common.gradle"),
      [
        'file("bin/javac")',
        "file('bin/javadoc')",
      ].join("\n"),
    );
    const applied = applyWindowsGradleExecutableExtensions(
      checkout,
      {
        file: "common.gradle",
        tools: ["javac", "javadoc"],
      },
      "win32",
    );
    assert.deepEqual(applied, {
      file: "common.gradle",
      tools: ["javac", "javadoc"],
    });
    assert.equal(
      fs.readFileSync(path.join(checkout, "common.gradle"), "utf8"),
      [
        'file("bin/javac.exe")',
        "file('bin/javadoc.exe')",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("materialized workspaces preserve setup files without Git metadata", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "t1-materialize-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "t1-materialize-target-"));
  try {
    writeFixture(source, ".git/config", "git metadata");
    writeFixture(source, "SharedModules/core_settings.gradle", "configured");
    materializeWorkspace(source, target);
    assert.equal(fs.existsSync(path.join(target, ".git")), false);
    assert.equal(
      fs.readFileSync(
        path.join(target, "SharedModules", "core_settings.gradle"),
        "utf8",
      ),
      "configured",
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("Gradle toolchains can be restricted to configured JDK homes", () => {
  const project = loadProjects().find((entry) => entry.id === "okhttp");
  const environment = {
    T1_PROJECT_JAVA_HOME: "C:\\jdks\\graalvm-25",
    T1_TOOLCHAIN_JAVA_HOMES: "C:\\jdks\\8;C:\\jdks\\11",
  };
  const result = configureGradleToolchainEnvironment(project, environment);
  assert.deepEqual(result.homes, [
    "C:\\jdks\\graalvm-25",
    "C:\\jdks\\8",
    "C:\\jdks\\11",
  ]);
  assert.match(
    environment.GRADLE_OPTS,
    /org\.gradle\.java\.installations\.auto-download=false/,
  );

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-toolchains-"));
  try {
    const propertiesPath = writeGradleToolchainProperties(checkout, result);
    const properties = fs.readFileSync(propertiesPath, "utf8");
    assert.match(
      properties,
      /org\.gradle\.java\.installations\.paths=C:\/jdks\/graalvm-25/,
    );
    assert.match(
      properties,
      /org\.gradle\.java\.installations\.auto-detect=false/,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
