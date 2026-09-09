import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { loadProjects } from "../create-matrix.mjs";
import { createComparisonMatrix } from "../create-jdtls-oracle-matrix.mjs";
import { discoverConfiguredEnvironmentPlan } from "../configured-environment.mjs";
import { applyEnvironmentPlan, environmentGithubOutputs } from "../environment-plan.mjs";
import { hashValue } from "../environment-lock.mjs";
import { plannedProject, preparePlannedWorkspace } from "../environment-workflow.mjs";
import { discoverProjectEnvironment, provisionProjectEnvironment } from "../project-environment.mjs";
import { resolvePreparedWorkspace } from "../prepared-workspace-driver.mjs";

test("all hundred cases have explicit environments and the ten-case pilot still selects forty observations", () => {
  const projects = loadProjects();
  const expected = [
    "guava", "arthas", "jjwt", "javalin", "mybatis-3",
    "mockito", "jadx", "btrace", "junit-framework", "metrics",
  ];
  const reviewed = projects.filter((project) => project.projectSetup?.configuredSource === true);
  assert.equal(reviewed.length, 100);
  assert.deepEqual(reviewed.map((project) => project.id).sort(), projects.map((project) => project.id).sort());
  for (const project of reviewed) {
    assert.ok(project.projectSetup.providers.jdtls.buildJava?.version, project.id);
  }
  const matrix = createComparisonMatrix({
    projects, requestedProjects: expected.join(","), operatingSystem: "all",
  });
  assert.equal(matrix.matrixEntries.length, 40);
  for (const operatingSystem of ["windows-latest", "macos-latest"]) {
    assert.equal(matrix.matrixEntries.filter((entry) => entry.os === operatingSystem).length, 20);
  }
});

test("BTrace retains its existing Windows adaptation without changing JVM roles", () => {
  const setup = loadProjects().find((project) => project.id === "btrace").projectSetup;
  assert.deepEqual(setup.checkout.windowsGradleExecutableExtensions, {
    file: "common.gradle",
    tools: ["javac", "javadoc"],
  });
  const provider = setup.providers.jdtls;
  assert.equal(provider.projectJava.version, "24");
  assert.equal(provider.buildJava.version, "21");
  assert.equal(provider.runtimeJava.version, "24");
});

test("all eight legacy synthetic cases use original source without generating a Maven project", (t) => {
  const projects = loadProjects().filter((project) => project.syntheticMavenTargetFile);
  assert.equal(projects.length, 8);
  for (const project of projects) {
    const original = JSON.stringify(project);
    const checkoutPath = fs.mkdtempSync(path.join(os.tmpdir(), "t1-original-source-"));
    t.after(() => fs.rmSync(checkoutPath, { recursive: true, force: true }));
    const source = path.join(checkoutPath, project.relativeFile);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "class Probe {}\n");
    for (const operatingSystem of ["windows-latest", "macos-latest"]) {
      const plan = discoverConfiguredEnvironmentPlan(project, { checkoutPath, operatingSystem });
      assert.equal(plan.state, "PLANNED", project.id);
      assert.equal(plan.build.tool, project.projectSetup.buildTool);
      assert.equal(plan.build.version, project.projectSetup.buildToolVersion);
      assert.equal(plan.inputHashes.some((input) => input.path === "pom.xml"), false);
      const configured = plannedProject(project, plan);
      assert.equal(configured.syntheticMavenTargetFile, undefined);
      assert.equal(configured.relativeFile, project.relativeFile);
      const resolved = resolvePreparedWorkspace(configured, checkoutPath);
      assert.equal(resolved.workspacePath, checkoutPath);
      assert.equal(resolved.runtimeRelativeFile, project.relativeFile);
      for (const provider of ["jdtls", "oracle"]) {
        assert.equal(provisionProjectEnvironment(configured, { provider, dryRun: true }).status, "planned");
        const discovery = discoverProjectEnvironment(configured, checkoutPath, provider);
        assert.deepEqual(discovery.detection.availableBuildTools, []);
      }
    }
    assert.equal(JSON.stringify(project), original);
    assert.equal(fs.readFileSync(source, "utf8"), "class Probe {}\n");
    assert.equal(fs.existsSync(path.join(checkoutPath, "pom.xml")), false);
    assert.equal(fs.existsSync(path.join(checkoutPath, project.syntheticMavenTargetFile)), false);
  }
});

function fixture(t, buildTool = "maven") {
  const checkoutPath = fs.mkdtempSync(path.join(os.tmpdir(), "t1-configured-source-"));
  t.after(() => fs.rmSync(checkoutPath, { recursive: true, force: true }));
  const project = structuredClone(loadProjects().find((entry) => entry.id === "hikaricp"));
  project.workspaceRoot = ".";
  project.relativeFile = "Probe.java";
  const setup = project.projectSetup;
  setup.configuredSource = true;
  setup.buildTool = buildTool;
  setup.buildToolVersion = buildTool === "maven" ? "3.9.11" : "8.14.3";
  setup.buildDescriptors = buildTool === "maven" ? { maven: ["pom.xml"] } : { gradle: ["build.gradle"] };
  setup.evidenceFiles = buildTool === "maven" ? ["pom.xml"] : ["build.gradle", "settings.gradle"];
  setup.maven = {
    downloadUrl: "https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.zip",
    sha512: "a".repeat(128),
  };
  setup.providers.jdtls.projectJava = { version: "17", distribution: "temurin" };
  setup.providers.jdtls.buildJava = { version: "21", distribution: "temurin" };
  setup.providers.jdtls.runtimeJava = { source: "setup-java", version: "25", distribution: "temurin" };
  delete setup.toolchainJava;
  delete setup.gradleWrapper;
  fs.writeFileSync(path.join(checkoutPath, "Probe.java"), "class Probe {}\n");
  if (buildTool === "maven") {
    fs.writeFileSync(path.join(checkoutPath, "pom.xml"),
      "<project><properties><maven.compiler.release>8</maven.compiler.release></properties></project>\n");
  } else {
    fs.writeFileSync(path.join(checkoutPath, "build.gradle"), "kotlinOptions { languageVersion = '2.2' }\n");
    fs.writeFileSync(path.join(checkoutPath, "settings.gradle"),
      "if (false) { includeBuild('../optional') }\n");
    const wrapper = "gradle/wrapper/gradle-wrapper.properties";
    fs.mkdirSync(path.dirname(path.join(checkoutPath, wrapper)), { recursive: true });
    fs.writeFileSync(path.join(checkoutPath, wrapper),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n");
    setup.gradleWrapper = { path: wrapper, enabled: true };
  }
  return {
    project, checkoutPath,
    plan(operatingSystem = "windows-latest") {
      return discoverConfiguredEnvironmentPlan(project, { checkoutPath, operatingSystem });
    },
  };
}

test("explicit project, build and server roles do not depend on a POM source target", (t) => {
  const input = fixture(t);
  const plan = input.plan();
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.comparisonMode, "configured-source");
  assert.equal(plan.java.project.version, "17");
  assert.equal(plan.java.build.version, "21");
  assert.equal(plan.java.runtime.version, "25");
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.nativeBaseline, undefined);
  const configured = applyEnvironmentPlan(input.project, plan);
  assert.deepEqual(configured.projectSetup.providers.oracle.projectJava, plan.java.project);
  assert.equal(configured.projectSetup.providers.oracle.buildJava.version, "21");
  assert.equal(configured.projectSetup.providers.oracle.runtimeJava.version, "25");
});

test("explicit Gradle configuration does not infer Java requirements from optional DSL", (t) => {
  const input = fixture(t, "gradle");
  const plan = input.plan();
  assert.equal(plan.state, "PLANNED");
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.build.version, "8.14.3");
  assert.ok(plan.inputHashes.some((entry) => entry.path === "gradle/wrapper/gradle-wrapper.properties"));
  input.project.projectSetup.buildToolVersion = "8.14.2";
  assert.throws(() => input.plan(), /Gradle wrapper changed/);
});

test("unreviewed cases and missing role requirements do not silently use defaults", (t) => {
  const input = fixture(t);
  delete input.project.projectSetup.configuredSource;
  assert.throws(() => input.plan(), /has not been reviewed/);
  input.project.projectSetup.configuredSource = true;
  delete input.project.projectSetup.providers.jdtls.buildJava;
  assert.throws(() => input.plan(), /explicit build JVM/);
});

test("explicit environments retain OS-specific compiler vendors and configuration identity", (t) => {
  const input = fixture(t);
  input.project.projectSetup.toolchainJava = {
    versions: ["8", "11"], distribution: "temurin",
    distributionsByOs: { "macos-latest": "zulu" },
  };
  assert.equal(environmentGithubOutputs(input.plan("macos-latest")).toolchainJavaDistribution, "zulu");
  const first = input.plan();
  input.project.projectSetup.providers.jdtls.buildJava.version = "25";
  assert.notEqual(hashValue(first), hashValue(input.plan()));
  assert.throws(() => input.plan("unknown-os"), /Unsupported configured-source OS/);
});

test("configured preparation requires the real probe, descriptors and pinned Maven archive", (t) => {
  const input = fixture(t);
  input.project.projectSetup.maven.sha512 = "";
  assert.throws(() => input.plan(), /maven\.sha512 is invalid/);
  input.project.projectSetup.maven.sha512 = "a".repeat(128);
  input.project.projectSetup.maven.downloadUrl = input.project.projectSetup.maven.downloadUrl.replaceAll("3.9.11", "3.9.10");
  assert.throws(() => input.plan(), /checksum-pinned Maven/);
  input.project.projectSetup.maven.downloadUrl = input.project.projectSetup.maven.downloadUrl.replaceAll("3.9.10", "3.9.11");
  fs.unlinkSync(path.join(input.checkoutPath, "Probe.java"));
  assert.throws(() => input.plan(), /ENOENT/);
});

for (const nested of [false, true]) {
  test(`source preparation proceeds without wrapper launchers or native-image copies (${nested ? "nested" : "root"} wrapper)`, async (t) => {
    const input = fixture(t, "gradle");
    if (nested) {
      const previous = input.project.projectSetup.gradleWrapper.path;
      input.project.projectSetup.gradleWrapper.path = `nested/${previous}`;
      const target = path.join(input.checkoutPath, input.project.projectSetup.gradleWrapper.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(input.checkoutPath, previous), target);
    }
    const git = (...args) => {
      const result = spawnSync("git", ["-C", input.checkoutPath, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=T1 fixture", "-c", "user.email=t1@example.invalid",
      "commit", "--quiet", "-m", "fixture");
    input.project.repository = pathToFileURL(input.checkoutPath).href;
    input.project.commit = git("rev-parse", "HEAD");
    input.project.projectSetup.windowsJavaToolCopies = [
      { source: "missing-native-image.exe", target: "bin/native-image.exe" },
    ];
    const plan = input.plan();
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "t1-original-prepared-"));
    t.after(() => fs.rmSync(output, { recursive: true, force: true }));
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const keys = [pathKey, "JAVA_HOME", "T1_PROJECT_JAVA_HOME", "T1_BUILD_JAVA_HOME",
      "T1_TOOLCHAIN_JAVA_HOMES", "GRADLE_OPTS"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    process.env.T1_PROJECT_JAVA_HOME = path.join(output, "jdk");
    process.env.T1_BUILD_JAVA_HOME = process.env.T1_PROJECT_JAVA_HOME;
    process.env.T1_TOOLCHAIN_JAVA_HOMES = "";
    process.env.GRADLE_OPTS = "";
    const checkout = path.join(output, "checkout");
    await preparePlannedWorkspace(input.project, plan, checkout);
    assert.equal(fs.readFileSync(path.join(checkout, "Probe.java"), "utf8").replaceAll("\r\n", "\n"), "class Probe {}\n");
    assert.equal(fs.existsSync(path.join(checkout, "gradlew")), false);
    assert.equal(fs.existsSync(path.join(checkout, "gradlew.bat")), false);
    assert.equal(fs.existsSync(path.join(output, "jdk", "bin", "native-image.exe")), false);
    assert.equal(discoverProjectEnvironment(plannedProject(input.project, plan), checkout, "jdtls").status, "configured");
  });
}

test("configured refinement advances without Java installation or a native model command", (t) => {
  const input = fixture(t);
  const plan = input.plan();
  const directory = path.join(input.checkoutPath, "environment");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "environment-plan.json"), JSON.stringify(plan));
  const outputFile = path.join(directory, "outputs");
  const result = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, "../environment-workflow.mjs"),
    "--phase", "refine", "--project", input.project.id,
    "--os", "windows-latest", "--directory", directory,
  ], {
    env: {
      ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_ENV: "",
      T1_PROJECT_JAVA_HOME: "", T1_BUILD_JAVA_HOME: "", T1_LANGUAGE_SERVER_JAVA_HOME: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = fs.readFileSync(outputFile, "utf8");
  assert.match(output, /modelReady<<[^\n]+\ntrue\n/);
  assert.match(output, /reprovision<<[^\n]+\nfalse\n/);
  assert.equal(fs.existsSync(path.join(directory, "native-model.log")), false);
  assert.equal(fs.existsSync(path.join(directory, "prepared-checkout")), false);
});
