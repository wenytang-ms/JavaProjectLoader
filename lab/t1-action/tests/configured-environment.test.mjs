import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";
import { discoverConfiguredEnvironmentPlan } from "../configured-environment.mjs";
import { applyEnvironmentPlan, environmentGithubOutputs } from "../environment-plan.mjs";
import { hashValue } from "../environment-lock.mjs";

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
