import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEnvironmentIdentity,
  environmentResult,
  hashValue,
  resolveBuildRoot,
  snapshotPreparedInputs,
  verifyEnvironmentLock,
  verifyPreparedInputs,
} from "../environment-lock.mjs";
import { createProjectSettings } from "../project-environment.mjs";
import { activateBuildJava, createMavenToolchainsXml } from "../environment-toolchains.mjs";

const project = { id: "demo", commit: "a".repeat(40) };
const plan = {
  project: project.id,
  commit: project.commit,
  operatingSystem: "windows-latest",
  scope: "native",
  buildRoot: ".",
  state: "PLANNED",
};

test("Maven toolchains preserve Java 8 aliases and escape filesystem paths", () => {
  const installation = { expectedVersion: "8", home: "C:\\jdk&tools", distribution: "temurin" };
  const document = createMavenToolchainsXml([installation, installation]);
  assert.equal((document.match(/<toolchain>/g) ?? []).length, 2);
  assert.match(document, /<version>8<\/version>/);
  assert.match(document, /<version>1\.8<\/version>/);
  assert.match(document, /C:\\jdk&amp;tools/);
  assert.throws(() => createMavenToolchainsXml([]), /No verified/);
});

test("build JVM activation aligns JAVA_HOME and PATH without duplicate Windows keys", () => {
  const environment = {
    T1_BUILD_JAVA_HOME: "C:\\jdk11",
    T1_PROJECT_JAVA_HOME: "C:\\jdk25",
    JAVA_HOME: "C:\\jdk17",
    Path: "C:\\jdk17\\bin;C:\\jdk11\\bin;C:\\tools",
  };
  activateBuildJava(environment, "win32");
  activateBuildJava(environment, "win32");
  assert.equal(environment.JAVA_HOME, "C:\\jdk11");
  assert.equal(environment.Path, "C:\\jdk11\\bin;C:\\jdk17\\bin;C:\\tools");
  assert.equal(environment.PATH, undefined);
  assert.throws(() => activateBuildJava({}, "win32"), /not been provisioned/);
});

test("environment identity is bound to project, revision and OS", () => {
  assert.doesNotThrow(() => assertEnvironmentIdentity(project, plan, "windows-latest"));
  assert.throws(() => assertEnvironmentIdentity(project, plan, "macos-latest"), /does not match/);
  assert.throws(() => assertEnvironmentIdentity({ ...project, commit: "b".repeat(40) }, plan, "windows-latest"));
  assert.throws(() => assertEnvironmentIdentity({ ...project, id: "other" }, plan, "windows-latest"));
});

test("build root cannot escape the prepared checkout", () => {
  const root = path.resolve("checkout");
  assert.equal(resolveBuildRoot(root, "app/server"), path.join(root, "app", "server"));
  assert.throws(() => resolveBuildRoot(root, "../elsewhere"), /escapes checkout/);
});

test("lock checks concrete binaries as well as requested Java versions", () => {
  const installed = [{
    role: "project", distribution: "temurin", expectedVersion: "25",
    exactVersion: "25.0.2", releaseSha256: "release", executableSha256: "binary",
  }];
  const lock = { ...plan, planHash: hashValue(plan), javaInstallations: installed };
  assert.deepEqual(verifyEnvironmentLock(project, plan, lock, "windows-latest", installed), []);
  assert.equal(verifyEnvironmentLock(project, plan, lock, "windows-latest", [
    { ...installed[0], executableSha256: "different" },
  ]).length, 1);
  assert.throws(() => verifyEnvironmentLock(project, { ...plan, buildRoot: "other" }, lock, "windows-latest", installed), /differs/);
  assert.ok(verifyEnvironmentLock(project, plan, { ...lock, javaInstallations: [] }, "windows-latest", installed)
    .some((error) => error.reason === "missing-jdk-lock-evidence"));
});

test("a strict plan cannot lock only a subset of its Java roles", () => {
  const fullPlan = {
    ...plan,
    java: { project: { version: "25" }, build: { version: "25" }, runtime: { version: "25" } },
  };
  const onlyProject = [{ role: "project", distribution: "temurin", expectedVersion: "25" }];
  const errors = verifyEnvironmentLock(project, fullPlan, {
    ...fullPlan, planHash: hashValue(fullPlan), javaInstallations: onlyProject,
  }, "windows-latest", onlyProject);
  assert.deepEqual(errors.map((error) => error.role).sort(), ["build", "runtime"]);
});

test("unlocked or duplicate JDK records cannot extend the qualified compiler environment", () => {
  const installation = {
    role: "project", distribution: "temurin", expectedVersion: "17",
    exactVersion: "17.0.2", releaseSha256: "release", executableSha256: "java",
  };
  const lock = { ...plan, planHash: hashValue(plan), javaInstallations: [installation] };
  for (const extra of [installation, { ...installation, role: "toolchain", expectedVersion: "8" }]) {
    const errors = verifyEnvironmentLock(project, plan, lock, "windows-latest", [installation, extra]);
    assert.ok(errors.some((error) => error.reason === "unexpected-jdk-installation"));
  }
});

test("prepared evidence includes untracked siblings and wrapper inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-prepared-inputs-"));
  try {
    fs.mkdirSync(path.join(root, ".t1-dependencies", "sibling"), { recursive: true });
    fs.mkdirSync(path.join(root, "gradle", "wrapper"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "Probe.java"), "class Probe {}\n");
    fs.writeFileSync(path.join(root, "settings.gradle"), "include ':sibling'\n");
    fs.writeFileSync(path.join(root, ".t1-dependencies", "sibling", "build.gradle"), "plugins { id 'java' }\n");
    fs.writeFileSync(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=locked\n");
    fs.writeFileSync(path.join(root, ".git", "config"), "git metadata remains outside the evidence hash");
    const fixture = { ...project, relativeFile: "Probe.java" };
    const initial = snapshotPreparedInputs(root, fixture);
    assert.ok(initial.some((file) => file.path === ".t1-dependencies/sibling/build.gradle"));
    assert.ok(initial.some((file) => file.path === "gradle/wrapper/gradle-wrapper.properties"));
    assert.ok(!initial.some((file) => file.path.startsWith(".git/")));
    fs.writeFileSync(path.join(root, "settings.gradle"), "rootProject.name = 'lost-preparation'\n");
    assert.equal(verifyPreparedInputs(initial, snapshotPreparedInputs(root, fixture)).length, 1);
    fs.unlinkSync(path.join(root, "Probe.java"));
    assert.throws(() => snapshotPreparedInputs(root, fixture), /missing required input/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared hash normalizes host-specific JDK installation paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-jdk-inputs-"));
  try {
    fs.writeFileSync(path.join(root, "Probe.java"), "class Probe {}\n");
    const file = path.join(root, "gradle.properties");
    fs.writeFileSync(file, "org.gradle.java.home=C:/host/jdk25\r\n");
    const first = snapshotPreparedInputs(root, { ...project, relativeFile: "Probe.java" }, [
      { home: "C:\\host\\jdk25", version: "25", distribution: "temurin" },
    ]);
    fs.writeFileSync(file, "org.gradle.java.home=D:/tools/jdk25\n");
    const second = snapshotPreparedInputs(root, { ...project, relativeFile: "Probe.java" }, [
      { home: "D:\\tools\\jdk25", version: "25", distribution: "temurin" },
    ]);
    assert.deepEqual(first, second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared evidence detects Maven configuration, dependency locks and build logic changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-build-inputs-"));
  try {
    const inputs = [
      "pom.xml", "Probe.java", ".mvn/maven.config", ".mvn/jvm.config", ".mvn/extensions.xml",
      "gradle.lockfile", "gradle/dependency-locks/compileClasspath.lockfile",
      "gradle/verification-metadata.xml", "buildSrc/src/main/java/BuildPlugin.java",
      "conventions/src/main/kotlin/BuildPlugin.kt", "plugins/src/main/groovy/BuildPlugin.groovy",
    ];
    for (const input of inputs) {
      fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
      fs.writeFileSync(path.join(root, input), "original\n");
    }
    const fixture = { ...project, relativeFile: "Probe.java" };
    const initial = snapshotPreparedInputs(root, fixture);
    assert.deepEqual(initial.map((file) => file.path).sort(), [...inputs].sort());
    for (const input of inputs) {
      fs.writeFileSync(path.join(root, input), "changed\n");
      assert.deepEqual(
        verifyPreparedInputs(initial, snapshotPreparedInputs(root, fixture)).map((file) => file.path),
        [input],
      );
      fs.writeFileSync(path.join(root, input), "original\n");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-qualified environment remains explicitly non-qualified", () => {
  const result = environmentResult(project, plan, "ENV_UNVERIFIED", { reason: "native model unavailable" });
  assert.equal(result.state, "ENV_UNVERIFIED");
  assert.equal(result.planHash, hashValue(plan));
  assert.equal(result.reason, "native model unavailable");
});

test("generated Develocity workspace IDs are not reproducible build inputs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-develocity-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".mvn", ".develocity"), { recursive: true });
  fs.writeFileSync(path.join(root, "Probe.java"), "class Probe {}\n");
  fs.writeFileSync(path.join(root, ".mvn", "extensions.xml"), "<extensions/>\n");
  const workspaceId = path.join(root, ".mvn", ".develocity", "develocity-workspace-id");
  fs.writeFileSync(workspaceId, "first-workspace");
  const first = snapshotPreparedInputs(root, { ...project, relativeFile: "Probe.java" });
  fs.writeFileSync(workspaceId, "second-workspace");
  assert.deepEqual(snapshotPreparedInputs(root, { ...project, relativeFile: "Probe.java" }), first);
  assert.ok(first.some((entry) => entry.path === ".mvn/extensions.xml"));
});

test("environment failures retain the configured-source experiment identity", () => {
  const result = environmentResult(project, { ...plan, comparisonMode: "configured-source" },
    "ENV_UNVERIFIED", { reason: "A required tool is unavailable." });
  assert.equal(result.comparisonMode, "configured-source");
  assert.equal(result.state, "ENV_UNVERIFIED");
});

test("JDT maps project, build, runtime and compiler JDKs separately", () => {
  const configured = {
    ...project,
    projectSetup: {
      buildTool: "gradle",
      providers: {
        jdtls: {
          projectJava: { version: "25", distribution: "temurin" },
          buildJava: { version: "11", distribution: "temurin" },
          runtimeJava: { version: "25", distribution: "temurin", source: "setup-java" },
          vscodeSettings: {},
        },
      },
    },
  };
  const settings = createProjectSettings(configured, "jdtls", {}, {
    T1_PROJECT_JAVA_HOME: "C:\\jdk25-project",
    T1_BUILD_JAVA_HOME: "C:\\jdk11-build",
    T1_LANGUAGE_SERVER_JAVA_HOME: "C:\\jdk25-server",
    T1_JAVA_HOMES_JSON: JSON.stringify([{ version: "8", home: "C:\\jdk8-toolchain" }]),
    T1_REQUIRE_ENVIRONMENT_READY: "1",
  });
  assert.equal(settings["java.import.gradle.java.home"], "C:\\jdk11-build");
  assert.equal(settings["java.jdt.ls.java.home"], "C:\\jdk25-server");
  assert.equal(settings["java.configuration.detectJdksAtStart"], false);
  assert.deepEqual(settings["java.configuration.runtimes"], [
    { name: "JavaSE-25", path: "C:\\jdk25-project", default: true },
    { name: "JavaSE-11", path: "C:\\jdk11-build" },
    { name: "JavaSE-1.8", path: "C:\\jdk8-toolchain" },
  ]);
});
