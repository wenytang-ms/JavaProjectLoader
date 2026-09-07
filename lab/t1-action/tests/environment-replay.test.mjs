import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";
import { discoverEnvironmentPlan } from "../environment-plan.mjs";
import {
  environmentResult,
  hashValue,
  snapshotPreparedInputs,
} from "../environment-lock.mjs";
import { loadProviderEnvironment } from "../environment-replay.mjs";
import { plannedProject } from "../environment-workflow.mjs";

const operatingSystem = "windows-latest";
const harnessCommit = "b".repeat(40);
const template = loadProjects().find((project) => project.id === "hikaricp");

function writeJson(file, document) {
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
}

function fixture(t, { buildRoot = "." } = {}) {
  const root = path.join(import.meta.dirname, "fixtures", `environment-replay-${randomUUID()}`);
  const checkout = path.join(root, "prepared-checkout");
  const directory = path.join(root, "proof");
  const actualBuildRoot = path.resolve(checkout, buildRoot);
  fs.mkdirSync(path.join(actualBuildRoot, "src"), { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(actualBuildRoot, "src", "Main.java");
  const descriptor = path.join(actualBuildRoot, "pom.xml");
  fs.writeFileSync(source, "class Main {}\n");
  fs.writeFileSync(descriptor, [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    "<modelVersion>4.0.0</modelVersion><groupId>example</groupId>",
    "<artifactId>replay-fixture</artifactId><version>1</version>",
    "<properties><maven.compiler.release>17</maven.compiler.release></properties>",
    "</project>",
  ].join("\n"));
  const project = structuredClone(template);
  project.relativeFile = path.relative(checkout, source);
  project.sourceSymbol = "Main";
  project.javaVersion = "17";
  project.workspaceRoot = buildRoot;
  project.projectSetup.buildTool = "maven";
  project.projectSetup.buildToolVersion = "3.9.11";
  project.projectSetup.checkout = {};
  project.projectSetup.evidenceFiles = [path.relative(checkout, descriptor)];
  project.projectSetup.maven = {
    downloadUrl: "https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.zip",
    sha512: "c".repeat(128),
  };
  const plan = discoverEnvironmentPlan(project, {
    checkoutPath: checkout,
    operatingSystem,
    recipe: {
      commit: project.commit,
      scope: buildRoot === "." ? "native" : "java-subproject",
      buildRoot,
      constraints: {},
      evidence: [{ path: path.relative(checkout, descriptor).replaceAll("\\", "/") }],
    },
  });
  assert.equal(plan.state, "PLANNED", JSON.stringify(plan.blockers));
  plan.build.sha512 = "c".repeat(128);
  const configured = plannedProject(project, plan);
  const recorded = ["project", "build", "runtime"].map((role) => ({
    role,
    home: path.join(root, "injected-jdks", role),
    version: plan.java[role].version,
    distribution: plan.java[role].distribution,
  }));
  const installations = recorded.map((item) => ({
    role: item.role,
    home: item.home,
    distribution: item.distribution,
    expectedVersion: item.version,
    exactVersion: `${item.version}.0.2`,
    releaseSha256: hashValue(`release:${item.role}`),
    executableSha256: hashValue(`java:${item.role}`),
    compilerSha256: hashValue(`javac:${item.role}`),
  }));
  const preparedInputs = snapshotPreparedInputs(checkout, configured, recorded);
  const lock = {
    schemaVersion: 1,
    project: project.id,
    commit: project.commit,
    operatingSystem,
    harnessCommit,
    planHash: hashValue(plan),
    javaInstallations: structuredClone(installations),
    preparedInputs,
  };
  const nativeBaseline = { successful: true, command: "mvn", args: ["test-compile"] };
  const qualification = environmentResult(project, plan, "ENV_READY", {
    lockHash: hashValue(lock),
    comparisonMode: "prebuilt-workspace",
    nativeBaseline,
  });
  const replay = {
    schemaVersion: 1,
    project: project.id,
    commit: project.commit,
    operatingSystem,
    state: "ENV_READY",
    checkout,
    buildRoot: actualBuildRoot,
    planHash: hashValue(plan),
    lockHash: hashValue(lock),
    preparationHash: hashValue(preparedInputs),
    comparisonMode: "prebuilt-workspace",
    nativeBaseline,
  };
  const documents = {
    "environment-result.json": qualification,
    "environment-plan.json": plan,
    "environment-lock.json": lock,
    "environment-replay.json": replay,
  };
  for (const [file, document] of Object.entries(documents)) {
    writeJson(path.join(directory, file), document);
  }
  const calls = [];
  const environment = {
    T1_PREPARED_CHECKOUT: checkout,
    T1_JAVA_HOMES_JSON: JSON.stringify(recorded),
    T1_PROJECT_JAVA_HOME: recorded.find((item) => item.role === "project").home,
    T1_BUILD_JAVA_HOME: recorded.find((item) => item.role === "build").home,
    T1_LANGUAGE_SERVER_JAVA_HOME: recorded.find((item) => item.role === "runtime").home,
    T1_TOOLCHAIN_JAVA_HOMES: [...new Set(recorded.map((item) => item.home))].join(";"),
    ...Object.fromEntries(recorded.map((item) => [`JDK${item.version}`, item.home])),
  };
  const options = {
    project, operatingSystem, harnessCommit, directory, environment,
    inspect(home, version, label) {
      calls.push({ home, version, label });
      const installation = installations.find((item) => item.home === home);
      assert.ok(installation, `Unexpected JDK inspection: ${home}`);
      assert.equal(version, installation.expectedVersion);
      return structuredClone(installation);
    },
  };
  return {
    root, checkout, directory, actualBuildRoot, source, descriptor,
    project, plan, lock, replay, qualification, configured, recorded,
    installations, calls, environment, options,
    save(file, value = documents[file]) {
      writeJson(path.join(directory, file), value);
    },
    load(overrides = {}) {
      return loadProviderEnvironment({ ...options, ...overrides });
    },
  };
}

function assertUnverified(result, reason) {
  assert.equal(result.qualified, false);
  assert.equal(result.environment.state, "ENV_UNVERIFIED");
  assert.match(result.environment.reason, reason);
  assert.equal(result.checkout, undefined);
  assert.equal(result.buildRoot, undefined);
}

test("missing qualification is blocked before JDK inspection", (t) => {
  const input = fixture(t);
  assertUnverified(input.load({ directory: undefined }), /No qualified environment directory/);
  fs.unlinkSync(path.join(input.directory, "environment-result.json"));
  assertUnverified(input.load(), /Independent environment qualification is missing/);
  assert.equal(input.calls.length, 0);
});

for (const selector of ["T1_PROJECT_JAVA_HOME", "T1_BUILD_JAVA_HOME", "T1_LANGUAGE_SERVER_JAVA_HOME", "T1_TOOLCHAIN_JAVA_HOMES"]) {
  test(`an unverified ${selector} cannot bypass a genuine lock and replay`, (t) => {
    const input = fixture(t);
    input.environment[selector] = path.join(input.root, "unverified-jdk");
    assertUnverified(input.load(), /Selected JDKs or compiler paths differ/);
    delete input.environment[selector];
    assertUnverified(input.load(), /Selected JDKs or compiler paths differ/);
  });
}

test("compiler aliases cannot select an unverified Java installation", (t) => {
  const input = fixture(t);
  input.environment[`JDK${input.recorded[0].version}`] = path.join(input.root, "unverified-jdk");
  assertUnverified(input.load(), /Selected JDKs or compiler paths differ/);
});

for (const file of [
  "environment-result.json", "environment-plan.json",
  "environment-lock.json", "environment-replay.json",
]) {
  for (const [field, value] of [
    ["project", "different-project"],
    ["commit", "d".repeat(40)],
    ["operatingSystem", "macos-latest"],
  ]) {
    test(`${file} rejects a different ${field}`, (t) => {
      const input = fixture(t);
      const document = JSON.parse(fs.readFileSync(path.join(input.directory, file), "utf8"));
      input.save(file, { ...document, [field]: value });
      const result = input.load();
      assertUnverified(result, /could not be verified/);
      assert.match(result.environment.error, /does not match the project, commit, or OS/);
      assert.equal(input.calls.length, 0);
    });
  }
}

for (const state of ["ENV_BLOCKED", "ENV_UNVERIFIED", "PROJECT_BASELINE_FAILED"]) {
  test(`non-ready ${state} proof stays blocked without requiring replay or inspecting JDKs`, (t) => {
    const input = fixture(t);
    input.qualification.state = state;
    input.qualification.blockers = [{ code: "NATIVE_BUILD_UNAVAILABLE" }];
    input.save("environment-result.json");
    fs.unlinkSync(path.join(input.directory, "environment-replay.json"));
    const result = input.load();
    assert.equal(result.qualified, false);
    assert.deepEqual(result.environment, input.qualification);
    assert.equal(input.calls.length, 0);
  });
}

for (const file of ["environment-plan.json", "environment-lock.json", "environment-replay.json"]) {
  test(`ready qualification without ${file} remains unverified`, (t) => {
    const input = fixture(t);
    fs.unlinkSync(path.join(input.directory, file));
    assertUnverified(input.load(), new RegExp(`proof is incomplete: ${file.replaceAll(".", "\\.")}`));
    assert.equal(input.calls.length, 0);
  });
}

for (const file of ["environment-plan.json", "environment-lock.json"]) {
  test(`tampered ${file} is rejected before inspecting the actual JDKs`, (t) => {
    const input = fixture(t);
    const document = file === "environment-plan.json" ? input.plan : input.lock;
    input.save(file, { ...document, tampered: true });
    assertUnverified(input.load(), /provenance does not match/);
    assert.equal(input.calls.length, 0);
  });
}

test("a different harness revision cannot use a previously qualified lock", (t) => {
  const input = fixture(t);
  assertUnverified(input.load({ harnessCommit: "e".repeat(40) }), /harness provenance does not match/);
  assert.equal(input.calls.length, 0);
});

for (const field of ["releaseSha256", "executableSha256", "compilerSha256", "exactVersion"]) {
  test(`actual JDK ${field} must match the locked installation`, (t) => {
    const input = fixture(t);
    input.installations[1][field] = "different-actual-installation";
    const result = input.load();
    assertUnverified(result, /Provider JDKs do not match/);
    assert.deepEqual(result.environment.mismatches, [{
      role: "build",
      version: input.recorded[1].version,
      reason: "jdk-lock-mismatch",
    }]);
    assert.equal(input.calls.length, 3);
  });
}

test("changed prepared descriptor inputs invalidate an otherwise matching native replay", (t) => {
  const input = fixture(t);
  fs.appendFileSync(input.descriptor, "\n<!-- modified after qualification -->\n");
  const result = input.load();
  assertUnverified(result, /lost or changed prepared inputs/);
  assert.deepEqual(result.environment.differences.map((item) => item.path), ["pom.xml"]);
  assert.equal(input.calls.length, 3);
});

test("new untracked build inputs and deleted probe inputs cannot silently replay", (t) => {
  const input = fixture(t);
  const added = path.join(input.checkout, "settings.gradle");
  fs.writeFileSync(added, "include ':unqualified-sibling'\n");
  const changed = input.load();
  assertUnverified(changed, /lost or changed prepared inputs/);
  assert.ok(changed.environment.differences.some((item) =>
    item.path === "settings.gradle" && item.expected === null));
  fs.unlinkSync(added);
  fs.unlinkSync(input.source);
  const missing = input.load();
  assertUnverified(missing, /could not be verified/);
  assert.match(missing.environment.error, /missing required input/);
});

test("native replay must prove successful baseline compilation", (t) => {
  const input = fixture(t);
  input.replay.nativeBaseline = { successful: false, command: "mvn", args: ["test-compile"] };
  input.save("environment-replay.json");
  assertUnverified(input.load(), /native replay.*does not match/);
  assert.equal(input.calls.length, 0);
});

test("prepared checkout and selected build root must be the paths actually replayed", (t) => {
  const input = fixture(t, { buildRoot: "server" });
  assertUnverified(input.load({ environment: {
    ...input.environment, T1_PREPARED_CHECKOUT: undefined,
  } }), /compiled prepared checkout is not available/);
  assertUnverified(input.load({ environment: {
    ...input.environment, T1_PREPARED_CHECKOUT: input.directory,
  } }), /compiled prepared checkout is not available/);
  assert.equal(input.calls.length, 0);
  input.replay.buildRoot = input.checkout;
  input.save("environment-replay.json");
  assertUnverified(input.load(), /different build root/);
  assert.equal(input.calls.length, 3);
});

for (const buildRoot of [".", "server"]) {
  test(`matching native replay preserves the real checkout and ${buildRoot} build root`, (t) => {
    const input = fixture(t, { buildRoot });
    const original = structuredClone(input.project);
    const result = input.load();
    assert.equal(result.qualified, true, JSON.stringify(result.environment));
    assert.equal(result.checkout, input.checkout);
    assert.equal(result.buildRoot, input.actualBuildRoot);
    assert.equal(result.project.workspaceRoot, buildRoot);
    assert.equal(result.project.relativeFile, input.project.relativeFile);
    assert.deepEqual(result.project.environmentPlan, input.plan);
    assert.deepEqual(result.plan, input.plan);
    assert.deepEqual(result.lock, input.lock);
    assert.deepEqual(result.replay, input.replay);
    assert.equal(result.environment.state, "ENV_READY");
    assert.equal(result.environment.replayVerified, true);
    assert.equal(result.environment.comparisonMode, "prebuilt-workspace");
    assert.equal(result.environment.planHash, hashValue(input.plan));
    assert.equal(result.environment.lockHash, hashValue(input.lock));
    assert.deepEqual(result.environment.javaInstallations, input.installations);
    assert.deepEqual(input.calls, input.recorded.map((item) => ({
      home: item.home, version: item.version, label: `Provider ${item.role} JDK`,
    })));
    assert.deepEqual(input.project, original);
    assert.equal(fs.existsSync(input.source), true);
    assert.equal(fs.existsSync(input.descriptor), true);
  });
}
