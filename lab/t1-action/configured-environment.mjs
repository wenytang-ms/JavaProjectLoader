import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashValue, resolveBuildRoot } from "./environment-lock.mjs";
import { discoverProjectEnvironment, getProviderSetup } from "./project-environment.mjs";

export const CONFIGURED_SOURCE_MODE = "configured-source";

export function discoverConfiguredEnvironmentPlan(project, { checkoutPath, operatingSystem }) {
  let setup = project.projectSetup;
  if (setup?.configuredSource !== true) {
    throw new Error(`${project.id} has not been reviewed for configured-source execution.`);
  }
  if (project.syntheticMavenTargetFile) {
    // Legacy fixture descriptors do not describe files in the original checkout.
    setup = {
      ...setup,
      buildDescriptorRoot: "repository",
      buildDescriptors: { maven: [], gradle: [] },
    };
    project = { ...project, projectSetup: setup, comparisonMode: CONFIGURED_SOURCE_MODE };
  }
  if (!["windows-latest", "macos-latest"].includes(operatingSystem)) {
    throw new Error(`Unsupported configured-source OS: ${operatingSystem}`);
  }
  const buildRoot = project.workspaceRoot ?? ".";
  const root = resolveBuildRoot(checkoutPath, buildRoot);
  discoverProjectEnvironment(project, checkoutPath, "jdtls", root);
  const provider = getProviderSetup(project, "jdtls");
  const java = {};
  for (const role of ["project", "build", "runtime"]) {
    const configured = provider[`${role}Java`];
    if (!/^\d+$/.test(configured?.version ?? "") ||
        typeof configured?.distribution !== "string" || !configured.distribution) {
      throw new Error(`${project.id} requires an explicit ${role} JVM version and distribution.`);
    }
    java[role] = { version: configured.version, distribution: configured.distribution };
  }
  if (provider.runtimeJava.source !== "setup-java" || Number(java.runtime.version) < 21) {
    throw new Error(`${project.id} requires an installed Java 21+ language-server runtime.`);
  }
  java.toolchains = structuredClone(setup.toolchainJava ?? { versions: [], distribution: "temurin" });
  if (java.toolchains.versions.some((version) => !/^\d+$/.test(version))) {
    throw new Error(`${project.id} compiler toolchains require explicit Java major versions.`);
  }
  const build = {
    tool: setup.buildTool,
    version: setup.buildToolVersion,
    ...(setup.buildTool === "maven" ? setup.maven : {
      wrapperPath: setup.gradleWrapper?.path ?? null,
    }),
  };
  if (build.tool === "maven" && (!/^[a-f0-9]{128}$/.test(build.sha512 ?? "") ||
      !build.downloadUrl?.includes(`/apache-maven-${build.version}-bin.zip`))) {
    throw new Error(`${project.id} requires a checksum-pinned Maven archive matching its configured version.`);
  }
  const inputs = new Set([
    ...setup.evidenceFiles,
    ...Object.values(setup.buildDescriptors).flat(),
    setup.gradleWrapper?.path,
    project.relativeFile,
  ].filter(Boolean).map((file) => file.replaceAll("\\", "/")));
  const inputHashes = [...inputs].sort().map((file) => ({
    path: file,
    sha256: createHash("sha256").update(fs.readFileSync(resolveBuildRoot(checkoutPath, file))).digest("hex"),
  }));
  inputHashes.push({ path: "#configured-source", sha256: hashValue(setup) });
  return {
    schemaVersion: 1,
    project: project.id,
    commit: project.commit,
    operatingSystem,
    comparisonMode: CONFIGURED_SOURCE_MODE,
    scope: buildRoot === "." ? "native" : "java-subproject",
    buildRoot,
    state: "PLANNED",
    java,
    build,
    android: setup.androidSdk ? {
      platforms: [setup.androidSdk.platform],
      buildTools: [setup.androidSdk.effectiveBuildToolsVersion],
      ndkVersions: [],
    } : null,
    blockers: [],
    unresolved: [],
    requirements: [{
      name: "configuredSource",
      value: { java, build },
      evidence: [{ path: "lab/t1-project-environments.json", reason: setup.selectionReason }],
    }],
    inputHashes,
  };
}

export function isConfiguredSource(plan) {
  return plan?.comparisonMode === CONFIGURED_SOURCE_MODE;
}
