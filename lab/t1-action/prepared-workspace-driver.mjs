import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { VscodeDriver } from "@vscjava/vscode-autotest";
import { writeJsonArtifact as writeJson } from "./artifact-writer.mjs";

const require = createRequire(import.meta.url);
export const PREPARED_WORKSPACE_ADAPTER_VERSION = "prepared-workspace-v1";
export const PREPARED_WORKSPACE_SDK_VERSION = "0.7.24";

export function assertPreparedWorkspaceSdkContract() {
  const manifest = require("@vscjava/vscode-autotest/package.json");
  const prototype = VscodeDriver.prototype;
  // These runtime-private hooks are intentionally pinned, not a supported SDK API.
  const contracts = {
    launch: "5230cf0428235fe6d7b79fac8159ce3140052f11dee1b685a4b63ddc57198a6f",
    createWorktree: "9edfeafd6d14b71cda2d7f1434a4be8d9671612123b14123298eb5c5a2bdb1a9",
    getWorkspacePath: "1c3e7cbc7e88799fd2709bb355601f41b5972b939543a5d6273ca38415aab2ab",
    close: "ce2dfa2e8a63d94ab89f15251f1cdd6d790747f2a6ae87a47c1f90de42057453",
  };
  if (
    manifest.version !== PREPARED_WORKSPACE_SDK_VERSION ||
    Object.entries(contracts).some(([name, contract]) =>
      typeof prototype[name] !== "function" ||
      createHash("sha256")
        .update(Function.prototype.toString.call(prototype[name]).replaceAll("\r\n", "\n"))
        .digest("hex") !== contract,
    )
  ) {
    throw new Error(
      "Prepared-workspace adapter requires the audited vscode-autotest " +
      `${PREPARED_WORKSPACE_SDK_VERSION} lifecycle; re-audit before upgrading.`,
    );
  }
}

function containedPath(root, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes(":")
  ) {
    throw new Error(`${label} must be repository-relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, ...relativePath.split(/[\\/]/));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  if (fs.existsSync(resolved)) {
    const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(resolved));
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`${label} resolves outside its root: ${relativePath}`);
    }
  }
  return resolved;
}

export function resolvePreparedWorkspace(project, repositoryPath) {
  const root = path.resolve(repositoryPath);
  const buildRoot = project.syntheticMavenTargetFile
    ? "."
    : project.workspaceRoot ?? project.environmentPlan?.buildRoot ?? ".";
  const workspacePath = containedPath(root, buildRoot, "Build root");
  if (!fs.statSync(workspacePath).isDirectory()) {
    throw new Error(`Build root is not a directory: ${workspacePath}`);
  }
  const probe = project.syntheticMavenTargetFile ?? project.relativeFile;
  const selectedFile = containedPath(root, probe, "Probe file");
  const runtimeRelativeFile = rebaseRepositoryFile(root, workspacePath, probe);
  if (!fs.statSync(selectedFile).isFile()) {
    throw new Error(`Pinned T1 source file is not a file: ${selectedFile}`);
  }
  return { repositoryPath: root, workspacePath, runtimeRelativeFile };
}

export function rebaseRepositoryFile(repositoryPath, workspacePath, relativeFile) {
  const root = path.resolve(repositoryPath);
  const file = containedPath(root, relativeFile, "Probe file");
  const relative = path.relative(workspacePath, file);
  containedPath(workspacePath, relative, "Workspace probe file");
  return relative.split(path.sep).join("/");
}

export class PreparedWorkspaceDriver extends VscodeDriver {
  constructor(options) {
    assertPreparedWorkspaceSdkContract();
    if (!options?.workspacePath || !fs.statSync(options.workspacePath).isDirectory()) {
      throw new Error("PreparedWorkspaceDriver requires an existing workspace directory.");
    }
    super({ ...options, workspacePath: path.resolve(options.workspacePath) });
    this.preparedWorkspacePath = this.options.workspacePath;
    this.preparedWorkspaceRealPath = fs.realpathSync(this.preparedWorkspacePath);
    this.assertPreparedWorkspaceOwnership();
  }

  assertPreparedWorkspaceOwnership() {
    if (
      this.worktreeRoot !== null ||
      this.tempWorkspaceDir !== null ||
      this.options.workspacePath !== this.preparedWorkspacePath ||
      fs.realpathSync(this.preparedWorkspacePath) !== this.preparedWorkspaceRealPath
    ) {
      throw new Error("Prepared workspace ownership or path changed.");
    }
  }

  async createWorktree(workspacePath) {
    this.assertPreparedWorkspaceOwnership();
    if (path.resolve(workspacePath) !== this.preparedWorkspacePath) {
      throw new Error("SDK requested a different prepared workspace.");
    }
    // A non-null result bypasses BOTH SDK copy/worktree creation and broad cleanup.
    // Do not set worktreeRoot or tempWorkspaceDir: close() must not own these files.
    return this.preparedWorkspacePath;
  }

  getWorkspacePath() {
    this.assertPreparedWorkspaceOwnership();
    return this.preparedWorkspacePath;
  }

  getWorkspaceRoot() {
    return this.getWorkspacePath();
  }
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function snapshotPreparedWorkspace(
  project,
  repositoryPath,
  { workspacePath, runtimeRelativeFile } = resolvePreparedWorkspace(project, repositoryPath),
  preparedInputPaths = [],
) {
  const root = path.resolve(repositoryPath);
  const selectedRepositoryFile = project.syntheticMavenTargetFile ?? project.relativeFile;
  if (rebaseRepositoryFile(root, workspacePath, selectedRepositoryFile) !== runtimeRelativeFile) {
    throw new Error("Runtime probe does not match the prepared repository-relative file.");
  }
  const required = new Set([
    selectedRepositoryFile,
    ...(!project.syntheticMavenTargetFile ? [
      ...(project.projectSetup?.evidenceFiles ?? []),
      ...Object.values(project.projectSetup?.buildDescriptors ?? {}).flat(),
      ...(project.projectSetup?.checkout?.windowsTextReplacements ?? []).map((item) => item.file),
      project.projectSetup?.checkout?.windowsGradleExecutableExtensions?.file,
    ] : []),
    ...preparedInputPaths,
  ].filter(Boolean).map((file) => file.replaceAll("\\", "/")));
  const gitMetadata = [];
  const skippedDirectories = new Set([".gradle", "node_modules", "target", "build", "out", ".idea"]);
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.name === ".git") {
        gitMetadata.push({ path: relative, kind: entry.isDirectory() ? "directory" : "file" });
        required.add(entry.isDirectory() ? `${relative}/HEAD` : relative);
      } else if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
        pending.push(fullPath);
      } else if (
        entry.isFile() &&
        /(?:^|\/)(?:pom\.xml|gradlew(?:\.bat)?|gradle\.properties|gradle-wrapper\.(?:jar|properties)|\.gitmodules|local\.properties|settings\.xml|maven\.config|jvm\.config)$|\.(?:gradle|gradle\.kts|versions\.toml)$/.test(relative)
      ) {
        required.add(relative);
      }
    }
  }
  if (!project.syntheticMavenTargetFile && !gitMetadata.some((entry) => entry.path === ".git")) {
    throw new Error("Prepared native repository must retain .git metadata.");
  }
  return {
    schemaVersion: 1,
    adapterVersion: PREPARED_WORKSPACE_ADAPTER_VERSION,
    sdkVersion: PREPARED_WORKSPACE_SDK_VERSION,
    capturedAt: new Date().toISOString(),
    repositoryPath: root,
    workspacePath: path.resolve(workspacePath),
    workspaceRealPath: fs.realpathSync(workspacePath),
    runtimeRelativeFile,
    selectedFileSha256: hashFile(containedPath(workspacePath, runtimeRelativeFile, "Selected file")),
    gitMetadata,
    inputs: [...required].sort().map((relative) => ({
      path: relative,
      sha256: hashFile(containedPath(root, relative, "Prepared input")),
    })),
  };
}

export function verifyActualWorkspace(driver, snapshot, outputDirectory) {
  const evidence = {
    ...snapshot,
    measuredAt: new Date().toISOString(),
    actualWorkspacePath: null,
    actualWorkspaceRealPath: null,
    preserved: false,
    differences: [],
  };
  try {
    evidence.actualWorkspacePath = driver.getWorkspaceRoot();
    evidence.actualWorkspaceRealPath = fs.realpathSync(evidence.actualWorkspacePath);
    if (evidence.actualWorkspaceRealPath !== snapshot.workspaceRealPath) {
      evidence.differences.push({ path: ".", reason: "different-actual-workspace" });
    }
    evidence.actualSelectedFile = containedPath(
      evidence.actualWorkspacePath, snapshot.runtimeRelativeFile, "Actual selected file",
    );
    evidence.actualSelectedFileSha256 = fs.existsSync(evidence.actualSelectedFile)
      ? hashFile(evidence.actualSelectedFile)
      : null;
    if (evidence.actualSelectedFileSha256 !== snapshot.selectedFileSha256) {
      evidence.differences.push({
        path: snapshot.runtimeRelativeFile,
        reason: "selected-content-changed",
        expected: snapshot.selectedFileSha256,
        actual: evidence.actualSelectedFileSha256,
      });
    }
    const actualRepositoryPath = path.resolve(
      evidence.actualWorkspacePath,
      path.relative(snapshot.workspacePath, snapshot.repositoryPath),
    );
    for (const entry of snapshot.gitMetadata) {
      const file = path.join(actualRepositoryPath, ...entry.path.split("/"));
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      if (!stat || (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
        evidence.differences.push({ path: entry.path, reason: "git-metadata-missing-or-changed" });
      }
    }
    evidence.inputs = snapshot.inputs.map((input) => {
      const file = containedPath(actualRepositoryPath, input.path, "Actual prepared input");
      const actualSha256 = fs.existsSync(file) ? hashFile(file) : null;
      if (actualSha256 !== input.sha256) {
        evidence.differences.push({ path: input.path, reason: "prepared-content-changed", expected: input.sha256, actual: actualSha256 });
      }
      return { ...input, actualSha256, matches: actualSha256 === input.sha256 };
    });
    evidence.preserved = evidence.differences.length === 0;
  } catch (error) {
    evidence.differences.push({ reason: "workspace-verification-error", error: String(error) });
  }
  writeJson(path.join(outputDirectory, "actual-workspace-evidence.json"), evidence);
  if (!evidence.preserved) {
    throw new Error("Actual VS Code workspace differs from prepared inputs; see actual-workspace-evidence.json.");
  }
  return evidence;
}
