import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VscodeDriver } from "@vscjava/vscode-autotest";

function canonicalPath(value) {
  const resolved = path.resolve(value);
  const canonical = fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved)
    : resolved;
  return process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
}

function configuredIntellijProjectPaths(settings) {
  const projects = Array.isArray(settings["intellij.projects"])
    ? settings["intellij.projects"]
    : [];
  return projects
    .map((project) => project?.path)
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => fileURLToPath(value));
}

class InPlaceIntellijDriver extends VscodeDriver {
  constructor(options) {
    super(options);
    if (!options.workspacePath) {
      throw new Error("IntelliJ T1 requires a workspace path");
    }
    this.t1WorkspacePath = path.resolve(options.workspacePath);
  }

  async createWorktree(workspacePath) {
    if (
      canonicalPath(workspacePath) !== canonicalPath(this.t1WorkspacePath)
    ) {
      throw new Error(
        `Unexpected IntelliJ workspace path: ${workspacePath}`,
      );
    }
    return this.t1WorkspacePath;
  }

  getWorkspacePath() {
    return this.t1WorkspacePath;
  }
}

export function createT1Driver(provider, options) {
  if (provider !== "intellij") {
    return new VscodeDriver(options);
  }
  if (typeof VscodeDriver.prototype.createWorktree !== "function") {
    throw new Error(
      "Installed vscode-autotest no longer exposes workspace isolation",
    );
  }
  // T1 already uses a disposable checkout. Opening it in place keeps
  // IntelliJ's absolute project URI aligned with the VS Code workspace.
  return new InPlaceIntellijDriver(options);
}

export function createIntellijWorkspacePathEvidence({
  requestedWorkspacePath,
  openedWorkspacePath,
  settings,
}) {
  const configuredProjectPaths = configuredIntellijProjectPaths(settings);
  const canonicalRequestedPath = canonicalPath(requestedWorkspacePath);
  const canonicalOpenedPath = openedWorkspacePath
    ? canonicalPath(openedWorkspacePath)
    : null;
  const canonicalConfiguredProjectPaths =
    configuredProjectPaths.map(canonicalPath);
  const matches =
    canonicalOpenedPath !== null &&
    canonicalOpenedPath === canonicalRequestedPath &&
    canonicalConfiguredProjectPaths.length > 0 &&
    canonicalConfiguredProjectPaths.every(
      (configuredPath) => configuredPath === canonicalOpenedPath,
    );

  return {
    schemaVersion: 1,
    requestedWorkspacePath,
    openedWorkspacePath,
    configuredProjectPaths,
    canonicalRequestedPath,
    canonicalOpenedPath,
    canonicalConfiguredProjectPaths,
    matches,
  };
}

export function assertIntellijWorkspacePathEvidence(evidence) {
  if (!evidence.matches) {
    throw new Error(
      "IntelliJ project path does not match the opened VS Code workspace: " +
        JSON.stringify(evidence),
    );
  }
}
