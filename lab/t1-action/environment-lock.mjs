import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ENVIRONMENT_SCHEMA_VERSION = 1;

export function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readEnvironmentJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

export function assertEnvironmentIdentity(project, plan, operatingSystem) {
  if (
    plan.project !== project.id ||
    plan.commit !== project.commit ||
    plan.operatingSystem !== operatingSystem
  ) {
    throw new Error("Environment evidence does not match the project, commit, or OS.");
  }
}

export function resolveBuildRoot(checkout, buildRoot = ".") {
  const resolved = path.resolve(checkout, buildRoot);
  const relative = path.relative(path.resolve(checkout), resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build root escapes checkout: ${buildRoot}`);
  }
  return resolved;
}

export function environmentStack(plan) {
  return { java: plan.java, build: plan.build, android: plan.android ?? null };
}

export function snapshotPreparedInputs(checkout, project, javaHomes = []) {
  const skip = new Set([".git", ".gradle", ".develocity", "node_modules", "target", "build", "out", ".idea"]);
  const required = new Set([
    project.relativeFile,
    ...(project.projectSetup?.evidenceFiles ?? []),
    ...(project.projectSetup?.checkout?.windowsTextReplacements ?? []).map((item) => item.file),
    project.projectSetup?.checkout?.windowsGradleExecutableExtensions?.file,
  ].filter(Boolean).map((file) => file.replaceAll("\\", "/")));
  const pending = [checkout];
  const files = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(checkout, fullPath).replaceAll("\\", "/");
      const buildInput = /(?:^|\/)(?:pom\.xml|gradlew(?:\.bat)?|gradle\.properties|gradle-wrapper\.(?:jar|properties)|\.gitmodules|local\.properties|verification-metadata\.xml)$/.test(relativePath) ||
        /(?:^|\/)\.mvn\//.test(relativePath) ||
        /\.(?:gradle|gradle\.kts|versions\.toml|lockfile|java|kt|groovy|scala)$/.test(relativePath);
      if (!buildInput && !required.has(relativePath)) continue;
      let bytes = fs.readFileSync(fullPath);
      if (!relativePath.endsWith(".jar")) {
        let content = bytes.toString("utf8").replaceAll("\r\n", "\n");
        for (const item of [...javaHomes].sort((a, b) => b.home.length - a.home.length)) {
          const marker = `<JDK:${item.distribution}:${item.version}>`;
          content = content.replaceAll(item.home, marker)
            .replaceAll(item.home.replaceAll("\\", "/"), marker);
        }
        bytes = Buffer.from(content);
      }
      files.push({
        path: relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const found = new Set(files.map((file) => file.path));
  for (const file of required) {
    if (!found.has(file)) throw new Error(`Prepared workspace is missing required input: ${file}`);
  }
  return files;
}

export function verifyPreparedInputs(expected, actual) {
  const left = new Map(expected.map((item) => [item.path, item.sha256]));
  const right = new Map(actual.map((item) => [item.path, item.sha256]));
  const differences = [];
  for (const [file, hash] of left) {
    if (right.get(file) !== hash) differences.push({ path: file, expected: hash, actual: right.get(file) ?? null });
  }
  for (const [file, hash] of right) {
    if (!left.has(file)) differences.push({ path: file, expected: null, actual: hash });
  }
  return differences;
}

export function verifyEnvironmentLock(project, plan, lock, operatingSystem, installations) {
  assertEnvironmentIdentity(project, plan, operatingSystem);
  assertEnvironmentIdentity(project, lock, operatingSystem);
  if (lock.planHash !== hashValue(plan)) throw new Error("Environment plan differs from its qualified lock.");
  const errors = [];
  for (const role of ["project", "build", "runtime"]) {
    if (plan.java?.[role] && !lock.javaInstallations?.some((item) => item.role === role)) {
      errors.push({ role, reason: "missing-jdk-role-evidence" });
    }
    for (const version of plan.java?.toolchains?.versions ?? []) {
      if (!lock.javaInstallations?.some((item) => item.role === "toolchain" && item.expectedVersion === version)) {
        errors.push({ role: "toolchain", version, reason: "missing-jdk-role-evidence" });
      }
    }
    const seen = new Set();
    for (const actual of installations) {
      const key = `${actual.role}:${actual.distribution}:${actual.expectedVersion}`;
      if (seen.has(key) || !lock.javaInstallations?.some((wanted) =>
        wanted.role === actual.role && wanted.distribution === actual.distribution &&
        wanted.expectedVersion === actual.expectedVersion)) {
        errors.push({ role: actual.role, version: actual.expectedVersion, reason: "unexpected-jdk-installation" });
      }
      seen.add(key);
    }
  }
  for (const wanted of lock.javaInstallations ?? []) {
    const actual = installations.find((item) =>
      item.role === wanted.role && item.distribution === wanted.distribution &&
      item.expectedVersion === wanted.expectedVersion);
    if (!actual || actual.exactVersion !== wanted.exactVersion ||
        actual.releaseSha256 !== wanted.releaseSha256 ||
        actual.executableSha256 !== wanted.executableSha256 ||
        actual.compilerSha256 !== wanted.compilerSha256) {
      errors.push({ role: wanted.role, version: wanted.expectedVersion, reason: "jdk-lock-mismatch" });
    }
  }
  if (!lock.javaInstallations?.length) errors.push({ reason: "missing-jdk-lock-evidence" });
  return errors;
}

export function environmentResult(project, plan, state, details = {}) {
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    project: project.id,
    commit: project.commit,
    operatingSystem: plan.operatingSystem,
    state,
    ...(plan.comparisonMode ? { comparisonMode: plan.comparisonMode } : {}),
    scope: plan.scope,
    buildRoot: plan.buildRoot,
    planHash: hashValue(plan),
    blockers: plan.blockers ?? [],
    unresolved: plan.unresolved ?? [],
    measuredAt: new Date().toISOString(),
    ...details,
  };
}
