import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { VscodeDriver } from "@vscjava/vscode-autotest";
import {
  PreparedWorkspaceDriver,
  assertPreparedWorkspaceSdkContract,
  rebaseRepositoryFile,
  resolvePreparedWorkspace,
  snapshotPreparedWorkspace,
  verifyActualWorkspace,
} from "../prepared-workspace-driver.mjs";
import {
  cloneProject,
  cloneRepository,
  createSyntheticMavenWorkspace,
  materializeWorkspace,
} from "../run-t1-autotest.mjs";

function fixture(t) {
  const root = path.join(import.meta.dirname, `.prepared-workspace-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, content) {
  const target = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function init(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
}

function commit(root) {
  git(root, "add", ".");
  git(root, "-c", "user.name=T1 fixture", "-c", "user.email=t1@example.invalid", "commit", "--quiet", "-m", "fixture");
}

test("pinned SDK private lifecycle contract fails closed on method drift", (t) => {
  assert.doesNotThrow(assertPreparedWorkspaceSdkContract);
  t.mock.method(VscodeDriver.prototype, "createWorktree", async () => null);
  assert.throws(assertPreparedWorkspaceSdkContract, /re-audit before upgrading/);
});

test("opens prepared tracked, untracked, sibling, wrapper and submodule files without owning cleanup", async (t) => {
  const root = fixture(t);
  const checkout = path.join(root, "checkout");
  const shared = path.join(root, "shared");
  init(shared);
  write(shared, "build.gradle", "// SharedModules\n");
  write(shared, "src/Shared.java", "class Shared {}\n");
  commit(shared);
  init(checkout);
  write(checkout, "settings.gradle", "rootProject.name = 'fixture'\n");
  write(checkout, "common.gradle", "file('bin/javac')\n");
  write(checkout, "src/Main.java", "class Main {}\n");
  git(checkout, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", shared, "SharedModules");
  commit(checkout);
  write(checkout, "common.gradle", "file('bin/javac.exe')\n");
  write(checkout, "settings.gradle", "include ':plugin'\nproject(':plugin').projectDir = file('.t1-dependencies/plugin')\n");
  write(checkout, ".t1-dependencies/plugin/build.gradle", "// sibling dependency\n");
  write(checkout, "gradlew.bat", "@echo prepared wrapper\n");
  write(checkout, "gradle/wrapper/gradle-wrapper.jar", "prepared wrapper binary");
  write(checkout, "gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip\n");
  const prepared = materializeWorkspace(checkout, path.join(root, "materialized"));
  const project = { relativeFile: "src/Main.java" };
  const snapshot = snapshotPreparedWorkspace(project, prepared);
  const unrelated = path.join(root, "autotest-worktree-other");
  write(unrelated, "sentinel", "another session");
  const driver = new PreparedWorkspaceDriver({ workspacePath: prepared });
  t.mock.method(VscodeDriver.prototype, "createWorktree", async () => {
    throw new Error("SDK worktree creation/cleanup must never run");
  });
  assert.equal(await driver.createWorktree(prepared), prepared);
  assert.equal(driver.getWorkspacePath(), prepared);
  assert.equal(driver.getWorkspaceRoot(), prepared);
  assert.equal(driver.resolveWorkspacePlaceholders("${workspaceFolder}"), prepared);
  assert.equal(driver.worktreeRoot, null);
  assert.equal(driver.tempWorkspaceDir, null);
  await assert.rejects(driver.createWorktree(root), /different prepared workspace/);
  const evidence = verifyActualWorkspace(driver, snapshot, root);
  assert.equal(evidence.preserved, true);
  for (const expected of [
    "src/Main.java", "common.gradle", "settings.gradle",
    ".t1-dependencies/plugin/build.gradle", "SharedModules/build.gradle",
    "SharedModules/.git", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
  ]) {
    assert.ok(evidence.inputs.some((item) => item.path === expected && item.matches), expected);
  }
  assert.match(git(prepared, "status", "--porcelain"), /common.gradle/);
  assert.match(git(path.join(prepared, "SharedModules"), "show", "HEAD:src/Shared.java"), /class Shared/);
  assert.deepEqual(
    fs.readFileSync(path.join(prepared, "SharedModules", "src", "Shared.java")),
    fs.readFileSync(path.join(checkout, "SharedModules", "src", "Shared.java")),
  );
  await driver.close();
  assert.equal(fs.readFileSync(path.join(unrelated, "sentinel"), "utf8"), "another session");
  assert.equal(fs.readFileSync(path.join(prepared, "common.gradle"), "utf8"), "file('bin/javac.exe')\n");
  assert.equal(fs.existsSync(path.join(prepared, ".git")), true);
  assert.equal(verifyActualWorkspace(driver, snapshot, root).preserved, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "actual-workspace-evidence.json"))).preserved, true);
});

test("opens native nested build root and rebases repository-relative probes", async (t) => {
  const root = fixture(t);
  init(root);
  write(root, "native/pom.xml", "<project />");
  write(root, "native/src/Main.java", "class Main {}");
  write(root, "other/Probe.java", "class Probe {}");
  const project = { relativeFile: "native/src/Main.java", environmentPlan: { buildRoot: "native" } };
  const layout = resolvePreparedWorkspace(project, root);
  assert.equal(layout.workspacePath, path.join(root, "native"));
  assert.equal(layout.runtimeRelativeFile, "src/Main.java");
  assert.equal(rebaseRepositoryFile(root, layout.workspacePath, "native\\src\\Main.java"), "src/Main.java");
  assert.throws(() => rebaseRepositoryFile(root, layout.workspacePath, "other/Probe.java"), /escapes its root/);
  const driver = new PreparedWorkspaceDriver({ workspacePath: layout.workspacePath });
  assert.equal(await driver.createWorktree(layout.workspacePath), layout.workspacePath);
  assert.equal(verifyActualWorkspace(driver, snapshotPreparedWorkspace(project, root, layout), root).preserved, true);
  assert.equal(resolvePreparedWorkspace({ ...project, workspaceRoot: "." }, root).workspacePath, root);
  assert.equal(resolvePreparedWorkspace({ relativeFile: "native/src/Main.java" }, root).runtimeRelativeFile, "native/src/Main.java");
  for (const buildRoot of ["..", "..\\outside", "C:\\outside", "/outside"]) {
    assert.throws(() => resolvePreparedWorkspace({ ...project, workspaceRoot: buildRoot }, root));
  }
  assert.throws(() => resolvePreparedWorkspace({ relativeFile: "../escape.java" }, root), /escapes/);
  assert.throws(
    () => snapshotPreparedWorkspace(project, root, { ...layout, runtimeRelativeFile: "other/Probe.java" }),
    /Runtime probe does not match/,
  );
  await driver.close();
  assert.equal(fs.existsSync(path.join(root, ".git")), true);
});

test("prebuilt-workspace mode retains compiled main/test outputs and warm project caches in place", async (t) => {
  const root = fixture(t);
  init(root);
  write(root, "src/Main.java", "class Main {}");
  const generatedFiles = [
    "build/classes/java/main/Main.class",
    "build/classes/java/test/MainTest.class",
    "target/classes/Main.class",
    "target/test-classes/MainTest.class",
    ".gradle/buildOutputCleanup/cache.properties",
  ];
  for (const file of generatedFiles) {
    write(root, file, `prebuilt:${file}`);
  }
  const driver = new PreparedWorkspaceDriver({ workspacePath: root });
  const snapshot = snapshotPreparedWorkspace({ relativeFile: "src/Main.java" }, root);
  assert.equal(await driver.createWorktree(root), root);
  assert.equal(driver.getWorkspaceRoot(), root);
  assert.equal(verifyActualWorkspace(driver, snapshot, root).preserved, true);
  for (const file of generatedFiles) {
    assert.equal(
      fs.readFileSync(path.join(driver.getWorkspaceRoot(), ...file.split("/")), "utf8"),
      `prebuilt:${file}`,
    );
  }
  await driver.close();
  for (const file of generatedFiles) {
    assert.equal(fs.readFileSync(path.join(root, ...file.split("/")), "utf8"), `prebuilt:${file}`);
  }
});

test("native build roots cannot escape through directory links", (t) => {
  const root = fixture(t);
  const repository = path.join(root, "repository");
  const external = path.join(root, "external");
  init(repository);
  write(external, "Main.java", "class Main {}");
  fs.symlinkSync(external, path.join(repository, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => resolvePreparedWorkspace({ relativeFile: "linked/Main.java", workspaceRoot: "linked" }, repository),
    /resolves outside its root/,
  );
});

test("runtime evidence fails on wrong root, lost git metadata, changed probe and missing prepared inputs", (t) => {
  const root = fixture(t);
  const repository = path.join(root, "repository");
  init(repository);
  write(repository, "Main.java", "class Main {}");
  write(repository, "gradlew.bat", "wrapper");
  const snapshot = snapshotPreparedWorkspace({ relativeFile: "Main.java" }, repository);
  assert.throws(() => verifyActualWorkspace({ getWorkspaceRoot: () => root }, snapshot, root), /differs/);
  const driver = new PreparedWorkspaceDriver({ workspacePath: repository });
  write(repository, "Main.java", "class Changed {}");
  fs.rmSync(path.join(repository, "gradlew.bat"));
  fs.rmSync(path.join(repository, ".git"), { recursive: true });
  assert.throws(() => verifyActualWorkspace(driver, snapshot, root), /differs/);
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "actual-workspace-evidence.json")));
  assert.equal(evidence.preserved, false);
  for (const expected of [".git", "Main.java", "gradlew.bat"]) {
    assert.ok(evidence.differences.some((item) => item.path === expected), expected);
  }
  assert.throws(() => snapshotPreparedWorkspace({ relativeFile: "Main.java" }, repository), /retain .git/);
});

test("legacy synthetic workspace opens directly without SDK fallback copying", async (t) => {
  const root = fixture(t);
  const checkout = path.join(root, "checkout");
  write(checkout, "samples/Main.java", "class Main {}");
  const workspace = path.join(root, "synthetic");
  const project = {
    id: "fixture",
    javaVersion: "21",
    relativeFile: "samples/Main.java",
    syntheticMavenTargetFile: "src/main/java/Main.java",
  };
  assert.equal(typeof cloneProject, "function");
  assert.equal(typeof cloneRepository, "function");
  createSyntheticMavenWorkspace(project, checkout, workspace);
  const driver = new PreparedWorkspaceDriver({ workspacePath: workspace });
  assert.equal(await driver.createWorktree(workspace), workspace);
  assert.equal(verifyActualWorkspace(driver, snapshotPreparedWorkspace(project, workspace), root).preserved, true);
  await driver.close();
  assert.equal(fs.existsSync(path.join(workspace, "pom.xml")), true);
});
