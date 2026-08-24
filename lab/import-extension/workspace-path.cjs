const fs = require("fs");
const path = require("path");

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeForComparison(value, platform) {
  const normalized = pathApi(platform).normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function realpathWithMissingTail(filePath, options) {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const realpath = options.realpath ?? fs.realpathSync.native;
  let candidate = paths.resolve(filePath);
  const missing = [];

  while (true) {
    try {
      const resolved = realpath(candidate);
      return missing.length === 0
        ? resolved
        : paths.join(resolved, ...missing.reverse());
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) {
        throw error;
      }
      const parent = paths.dirname(candidate);
      if (parent === candidate) {
        return paths.resolve(filePath);
      }
      missing.push(paths.basename(candidate));
      candidate = parent;
    }
  }
}

function canonicalizeFilePath(filePath, options = {}) {
  if (!filePath) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  return pathApi(platform).normalize(
    realpathWithMissingTail(filePath, options),
  );
}

function isContainedPath(root, candidate, platform) {
  const paths = pathApi(platform);
  const relative = paths.relative(
    normalizeForComparison(root, platform),
    normalizeForComparison(candidate, platform),
  );
  return (
    relative === "" ||
    (!relative.startsWith(`..${paths.sep}`) &&
      relative !== ".." &&
      !paths.isAbsolute(relative))
  );
}

function createWorkspaceResolver(workspaceFolders, options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const candidates = workspaceFolders.map((folder) => ({
    uri: folder.uri,
    path: folder.path,
    canonicalPath: canonicalizeFilePath(folder.path, options),
  }));
  return (filePath) => {
    const canonicalPath = canonicalizeFilePath(filePath, options);
    const matched = candidates.find(
      (folder) =>
        folder.canonicalPath &&
        canonicalPath &&
        isContainedPath(folder.canonicalPath, canonicalPath, platform),
    );
    if (!matched) {
      return {
        included: false,
        originalPath: filePath,
        canonicalPath,
        workspaceFolderUri: null,
        canonicalWorkspacePath: null,
        relativePath: null,
        exclusionReason: "outside-canonical-workspace",
      };
    }
    return {
      included: true,
      originalPath: filePath,
      canonicalPath,
      workspaceFolderUri: matched.uri,
      canonicalWorkspacePath: matched.canonicalPath,
      relativePath: paths.relative(matched.canonicalPath, canonicalPath)
        .split(paths.sep)
        .join("/"),
      exclusionReason: null,
    };
  };
}

function resolveWorkspaceMembership(filePath, workspaceFolders, options = {}) {
  return createWorkspaceResolver(workspaceFolders, options)(filePath);
}

module.exports = {
  canonicalizeFilePath,
  createWorkspaceResolver,
  resolveWorkspaceMembership,
};
