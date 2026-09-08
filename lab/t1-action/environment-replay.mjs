import fs from "node:fs";
import path from "node:path";
import {
  assertEnvironmentIdentity,
  hashValue,
  readEnvironmentJson,
  resolveBuildRoot,
  snapshotPreparedInputs,
  verifyEnvironmentLock,
  verifyPreparedInputs,
} from "./environment-lock.mjs";
import { inspectJavaHome } from "./project-environment.mjs";
import { plannedProject } from "./environment-workflow.mjs";
import { verifyJavaHomeSelectors } from "./environment-toolchains.mjs";
import { CONFIGURED_SOURCE_MODE, isConfiguredSource } from "./configured-environment.mjs";

export function copyEnvironmentEvidence(directory, outputDirectory) {
  if (!directory || !fs.existsSync(directory)) return [];
  const copied = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.(?:json|log|xml)$/.test(entry.name)) continue;
    fs.copyFileSync(path.join(directory, entry.name), path.join(outputDirectory, entry.name));
    copied.push(entry.name);
  }
  return copied;
}

export function loadProviderEnvironment({
  project,
  operatingSystem,
  harnessCommit,
  directory,
  environment = process.env,
  inspect = inspectJavaHome,
}) {
  const unavailable = (reason, details = {}) => ({
    qualified: false,
    environment: {
      schemaVersion: 1,
      project: project.id,
      commit: project.commit,
      operatingSystem,
      state: "ENV_UNVERIFIED",
      comparisonMode: environment.T1_ENVIRONMENT_MODE ?? "prebuilt-workspace",
      reason,
      ...details,
    },
  });
  if (!directory) return unavailable("No qualified environment directory was supplied.");
  const resultPath = path.join(directory, "environment-result.json");
  if (!fs.existsSync(resultPath)) return unavailable("Independent environment qualification is missing.");
  try {
    const qualification = readEnvironmentJson(resultPath);
    assertEnvironmentIdentity(project, qualification, operatingSystem);
    if (qualification.state !== "ENV_READY") {
      return { qualified: false, environment: qualification };
    }
    for (const file of ["environment-plan.json", "environment-lock.json", "environment-replay.json"]) {
      if (!fs.existsSync(path.join(directory, file))) {
        return unavailable(`Environment proof is incomplete: ${file}`);
      }
    }
    const plan = readEnvironmentJson(path.join(directory, "environment-plan.json"));
    const lock = readEnvironmentJson(path.join(directory, "environment-lock.json"));
    const replay = readEnvironmentJson(path.join(directory, "environment-replay.json"));
    for (const record of [plan, lock, replay]) assertEnvironmentIdentity(project, record, operatingSystem);
    if (plan.state !== "PLANNED" || !["native", "java-subproject"].includes(plan.scope)) {
      return unavailable("This plan does not qualify a native Java project or declared Java subproject.");
    }
    const configuredSource = isConfiguredSource(plan);
    const preparationVerified = configuredSource
      ? project.projectSetup?.configuredSource === true &&
        qualification.qualification === CONFIGURED_SOURCE_MODE &&
        qualification.comparisonMode === CONFIGURED_SOURCE_MODE &&
        lock.qualification === CONFIGURED_SOURCE_MODE &&
        replay.comparisonMode === CONFIGURED_SOURCE_MODE &&
        replay.preparationVerified === true
      : replay.nativeBaseline?.successful === true;
    if (lock.harnessCommit !== harnessCommit ||
        qualification.planHash !== hashValue(plan) ||
        qualification.lockHash !== hashValue(lock) ||
        replay.planHash !== hashValue(plan) ||
        replay.lockHash !== hashValue(lock) ||
        replay.state !== "ENV_READY" ||
        !preparationVerified) {
      return unavailable("Qualification, native replay, or harness provenance does not match.");
    }
    const checkout = environment.T1_PREPARED_CHECKOUT;
    if (!checkout || path.resolve(checkout) !== path.resolve(replay.checkout) ||
        !fs.existsSync(checkout)) {
      return unavailable("The compiled prepared checkout is not available in this provider job.");
    }
    const recorded = JSON.parse(environment.T1_JAVA_HOMES_JSON ?? "[]");
    if (!Array.isArray(recorded)) return unavailable("Provisioned JDK records are malformed.");
    const actual = recorded.map((item) => ({
      ...inspect(item.home, item.version, `Provider ${item.role} JDK`),
      role: item.role,
      distribution: item.distribution,
    }));
    const mismatches = verifyEnvironmentLock(project, plan, lock, operatingSystem, actual);
    if (mismatches.length) return unavailable("Provider JDKs do not match the qualified lock.", { mismatches });
    const selectorMismatches = verifyJavaHomeSelectors(recorded, environment);
    if (selectorMismatches.length) {
      return unavailable("Selected JDKs or compiler paths differ from the verified installations.", {
        mismatches: selectorMismatches,
      });
    }
    const configured = plannedProject(project, plan);
    const inputs = snapshotPreparedInputs(checkout, configured, recorded);
    const differences = verifyPreparedInputs(lock.preparedInputs, inputs);
    if (differences.length || replay.preparationHash !== hashValue(inputs)) {
      return unavailable("The actual workspace lost or changed prepared inputs.", { differences });
    }
    const buildRoot = resolveBuildRoot(checkout, plan.buildRoot);
    if (path.resolve(buildRoot) !== path.resolve(replay.buildRoot)) {
      return unavailable("The provider would open a different build root from the qualified replay.");
    }
    return {
      qualified: true,
      project: configured,
      plan,
      lock,
      replay,
      checkout,
      buildRoot,
      environment: {
        ...qualification,
        replayVerified: true,
        comparisonMode: plan.comparisonMode ?? "prebuilt-workspace",
        javaInstallations: actual,
      },
    };
  } catch (error) {
    return unavailable("Environment evidence could not be verified.", {
      error: error instanceof Error ? error.stack : String(error),
    });
  }
}
