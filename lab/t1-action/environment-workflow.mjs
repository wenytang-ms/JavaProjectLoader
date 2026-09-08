import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadProjects } from "./create-matrix.mjs";
import { writeJsonArtifact as writeJson } from "./artifact-writer.mjs";
import {
  applyEnvironmentPlan,
  discoverEnvironmentPlan,
  environmentGithubOutputs,
} from "./environment-plan.mjs";
import {
  discoverProjectEnvironment,
  findSdkManager,
  inspectJavaHome,
  provisionProjectEnvironment,
  runSdkManager,
} from "./project-environment.mjs";
import {
  assertEnvironmentIdentity,
  environmentResult,
  environmentStack,
  hashValue,
  readEnvironmentJson,
  resolveBuildRoot,
  snapshotPreparedInputs,
  verifyEnvironmentLock,
  verifyPreparedInputs,
} from "./environment-lock.mjs";
import {
  activateBuildJava,
  applyJavaPlatformPolicy,
  createMavenToolchainsXml,
  lockedSetupJavaVersion,
  setupJavaPackageVersion,
} from "./environment-toolchains.mjs";
import { resolveNativeCompilerRequirements, verifyNativeCompilerRequirements } from "./environment-qualification.mjs";
import { canonicalJavaPackageVersion, comparableJavaPackageVersion } from "./java-package-catalog.mjs";
import {
  CONFIGURED_SOURCE_MODE,
  discoverConfiguredEnvironmentPlan,
  isConfiguredSource,
} from "./configured-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const recipesPath = path.resolve(scriptDirectory, "..", "t1-environment-recipes.json");

function harnessRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(scriptDirectory, "..", ".."),
    encoding: "utf8",
  });
  const revision = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(revision ?? "")) {
    throw new Error("Cannot identify the harness revision for environment locking.");
  }
  return revision;
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function appendEnvironment(name, value) {
  if (/[\r\n]/.test(String(value))) throw new Error(`Multiline environment value: ${name}`);
  process.env[name] = String(value);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `t1_${createHash("sha256").update(`${name}:${value}`).digest("hex")}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function javaHomes(directory) {
  const file = path.join(directory, "java-homes.json");
  return fs.existsSync(file) ? readEnvironmentJson(file) : [];
}

function nativeCommand(command, args, { cwd, logFile, timeoutMs = 600_000 } = {}) {
  const environment = { ...process.env };
  activateBuildJava(environment);
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, text + (result.error ? `\n${result.error.stack}\n` : ""));
  }
  return {
    command: path.basename(command),
    args,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    logFile: logFile ? path.basename(logFile) : null,
    successful: result.status === 0 && !result.error,
  };
}

async function hydrateEnvironment(discovered) {
  const plan = applyJavaPlatformPolicy(discovered);
  if (plan.build.tool !== "maven" || plan.build.sha512) return plan;
  const version = plan.build.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported Maven version: ${version}`);
  const downloadUrl = `https://archive.apache.org/dist/maven/maven-3/${version}/binaries/apache-maven-${version}-bin.zip`;
  const response = await fetch(`${downloadUrl}.sha512`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Cannot resolve Maven ${version} checksum: HTTP ${response.status}`);
  const digest = (await response.text()).match(/\b[a-fA-F0-9]{128}\b/)?.[0]?.toLowerCase();
  if (!digest) throw new Error(`Invalid Maven ${version} checksum response.`);
  return { ...plan, build: { ...plan.build, downloadUrl, sha512: digest } };
}

export function plannedProject(project, plan) {
  const configured = applyEnvironmentPlan(project, plan);
  configured.environmentPlan = plan;
  configured.workspaceRoot = plan.buildRoot;
  if (plan.build.tool === "maven") {
    if (!/^[a-f0-9]{128}$/.test(plan.build.sha512 ?? "")) {
      throw new Error("The planned Maven archive has not been checksum-locked.");
    }
    configured.projectSetup.maven = {
      downloadUrl: plan.build.downloadUrl,
      sha512: plan.build.sha512,
    };
  } else {
    configured.projectSetup.gradleToolchains = {
      ...configured.projectSetup.gradleToolchains,
      restrictToConfiguredJdks: true,
    };
  }
  return configured;
}

function exportPlan(plan, lock = null, project = null) {
  const values = environmentGithubOutputs(plan);
  if (lock) {
    for (const role of ["project", "build", "runtime"]) {
      const installation = lock.javaInstallations.find((item) => item.role === role);
      if (!installation) throw new Error(`Locked Java role is missing: ${role}`);
      values[`${role}JavaVersion`] = lockedSetupJavaVersion(installation);
    }
    values.toolchainJavaVersions = lock.javaInstallations
      .filter((item) => item.role === "toolchain")
      .map(lockedSetupJavaVersion).join("\n");
    const sdk = lock.javaInstallations.find((item) => item.role === "sdk");
    values.sdkJavaVersion = sdk ? lockedSetupJavaVersion(sdk) : "17";
  }
  values.goVersion = project?.projectSetup?.goVersion ?? "";
  values.bootstrapGradleVersion = plan.build.tool === "gradle" && !plan.build.wrapperPath
    ? plan.build.version : "";
  for (const [name, value] of Object.entries(values)) output(name, String(value ?? ""));
  output("requiresAndroidSdk", Boolean(
    plan.android?.platforms?.length || plan.android?.buildTools?.length ||
    plan.android?.ndkVersions?.length || project?.projectSetup?.androidSdk,
  ));
}

async function recordJava(plan, directory, role) {
  const records = javaHomes(directory).filter((item) => item.role !== role);
  const requested = role === "toolchain"
    ? plan.java.toolchains.versions.map((version) => ({
        version,
        distribution: plan.java.toolchains.distributionsByOs?.[plan.operatingSystem] ??
          plan.java.toolchains.distribution,
      }))
    : [role === "sdk" ? { version: "17", distribution: "temurin" } : plan.java[role]];
  for (const item of requested) {
    const major = String(item.version).match(/^(?:1\.)?(\d+)/)?.[1];
    const home = role === "toolchain"
      ? process.env[`JAVA_HOME_${major}_${process.arch.toUpperCase()}`]
      : process.env.JAVA_HOME;
    const observed = inspectJavaHome(home, major, `${role} JDK ${major}`);
    const cachedVersion = setupJavaPackageVersion(home, process.env.RUNNER_TOOL_CACHE);
    const lockPath = path.join(directory, "environment-lock.json");
    const locked = fs.existsSync(lockPath) ? readEnvironmentJson(lockPath).javaInstallations.find((entry) =>
      entry.role === role && entry.expectedVersion === major && entry.distribution === item.distribution) : null;
    if (fs.existsSync(lockPath) && !locked) throw new Error(`No locked ${role} Java ${major} installation exists.`);
    const previous = records.find((entry) => entry.home === home && entry.setupJavaCacheVersion === cachedVersion &&
      entry.distribution === item.distribution && entry.exactVersion === observed.exactVersion);
    const packageVersion = locked ? lockedSetupJavaVersion(locked) : previous?.setupJavaVersion ??
      await canonicalJavaPackageVersion({ version: cachedVersion, distribution: item.distribution });
    if (comparableJavaPackageVersion(packageVersion) !== comparableJavaPackageVersion(cachedVersion)) {
      throw new Error(`Installed ${role} JDK package does not match its locked catalog identity.`);
    }
    records.push({
      ...observed, role, version: major, distribution: item.distribution,
      setupJavaVersion: packageVersion,
      setupJavaCacheVersion: cachedVersion,
    });
    if (role !== "toolchain") {
      const key = { project: "T1_PROJECT_JAVA_HOME", build: "T1_BUILD_JAVA_HOME", runtime: "T1_LANGUAGE_SERVER_JAVA_HOME", sdk: "T1_ANDROID_SDK_JAVA_HOME" }[role];
      appendEnvironment(key, home);
    }
    appendEnvironment(`JDK${major}`, home);
  }
  writeJson(path.join(directory, "java-homes.json"), records);
  appendEnvironment("T1_JAVA_HOMES_JSON", JSON.stringify(records));
  appendEnvironment("T1_TOOLCHAIN_JAVA_HOMES", [...new Set(records.map((item) => item.home))].join(";"));
}

function provisionPlannedAndroid(plan) {
  if (!plan.android?.platforms?.length && !plan.android?.buildTools?.length &&
      !plan.android?.ndkVersions?.length) return null;
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdkRoot) throw new Error("Android SDK root is not available.");
  const manager = findSdkManager(sdkRoot);
  const packages = [
    ...(plan.android.platforms ?? []).map((platform) => `platforms;${platform}`),
    ...(plan.android.buildTools ?? []).map((version) => `build-tools;${version}`),
    ...(plan.android.ndkVersions ?? []).map((version) => `ndk;${version}`),
  ];
  runSdkManager(manager, sdkRoot, packages, process.env.T1_ANDROID_SDK_JAVA_HOME);
  const paths = [
    ...(plan.android.platforms ?? []).map((platform) => path.join(sdkRoot, "platforms", platform, "android.jar")),
    ...(plan.android.buildTools ?? []).map((version) => path.join(sdkRoot, "build-tools", version)),
    ...(plan.android.ndkVersions ?? []).map((version) => path.join(sdkRoot, "ndk", version)),
  ];
  for (const file of paths) if (!fs.existsSync(file)) throw new Error(`Android package missing after provisioning: ${file}`);
  const evidenceFiles = [
    ...(plan.android.platforms ?? []).flatMap((platform) => [
      path.join(sdkRoot, "platforms", platform, "android.jar"),
      path.join(sdkRoot, "platforms", platform, "source.properties"),
    ]),
    ...(plan.android.buildTools ?? []).map((version) => path.join(sdkRoot, "build-tools", version, "source.properties")),
    ...(plan.android.ndkVersions ?? []).map((version) => path.join(sdkRoot, "ndk", version, "source.properties")),
  ];
  const artifacts = evidenceFiles.map((file) => ({
    path: path.relative(sdkRoot, file).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  }));
  return { sdkRoot, packages, verifiedPaths: paths, artifacts };
}

export function provisionPlannedProject(project, plan, directory) {
  const configured = plannedProject(project, plan);
  const host = provisionProjectEnvironment(configured, { provider: "jdtls" });
  host.plannedAndroid = provisionPlannedAndroid(plan);
  writeJson(path.join(directory, "host-environment.json"), host);
  appendEnvironment("T1_PROJECT_ENVIRONMENT_RESULT", path.join(directory, "host-environment.json"));
  if (host.maven) {
    appendEnvironment("T1_MAVEN_HOME", host.maven.home);
    appendEnvironment("MAVEN_HOME", host.maven.home);
    const toolchainsFile = process.env.GITHUB_ACTIONS === "true"
      ? path.join(os.homedir(), ".m2", "toolchains.xml")
      : path.join(directory, "toolchains.xml");
    fs.mkdirSync(path.dirname(toolchainsFile), { recursive: true });
    fs.writeFileSync(toolchainsFile, createMavenToolchainsXml(host.javaInstallations ?? []));
    appendEnvironment("T1_MAVEN_TOOLCHAINS_FILE", toolchainsFile);
  }
  return { configured, host };
}

export async function preparePlannedWorkspace(project, plan, checkout) {
  const runner = await import("./run-t1-autotest.mjs");
  const configured = plannedProject(project, plan);
  activateBuildJava();
  runner.applyWindowsJavaToolCopies(process.env.JAVA_HOME, configured.projectSetup?.windowsJavaToolCopies);
  const checkoutSetup = runner.cloneProject(configured, checkout);
  const toolchains = runner.configureGradleToolchainEnvironment(configured, process.env);
  runner.writeGradleToolchainProperties(checkout, toolchains);
  if (plan.build.tool === "gradle") {
    const root = resolveBuildRoot(checkout, plan.buildRoot);
    const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    if (isConfiguredSource(plan)) {
      if (!fs.existsSync(wrapper)) throw new Error(`Configured Gradle wrapper is missing: ${wrapper}`);
      if (process.platform !== "win32") fs.chmodSync(wrapper, fs.statSync(wrapper).mode | 0o100);
    }
    const home = process.env.T1_BUILD_JAVA_HOME.replaceAll("\\", "/");
    fs.appendFileSync(path.join(root, "gradle.properties"), `\norg.gradle.java.home=${home}\n`);
  }
  return { configured, checkoutSetup, toolchains };
}

async function prepareConfiguredWorkspace(project, plan, directory) {
  const checkout = path.join(directory, "prepared-checkout");
  const prepared = await preparePlannedWorkspace(project, plan, checkout);
  const discovery = discoverProjectEnvironment(
    prepared.configured, checkout, "jdtls", resolveBuildRoot(checkout, plan.buildRoot),
  );
  const probe = resolveBuildRoot(checkout, project.relativeFile);
  if (!fs.statSync(probe).isFile()) throw new Error(`Configured probe is not a file: ${probe}`);
  writeJson(path.join(directory, "checkout-setup.json"), prepared.checkoutSetup);
  writeJson(path.join(directory, "configured-preparation.json"), {
    project: project.id, commit: project.commit, operatingSystem: plan.operatingSystem,
    comparisonMode: CONFIGURED_SOURCE_MODE,
    prepared: true, nativeCompilationPerformed: false, discovery,
  });
  return { checkout, prepared };
}

function mavenExecutable() {
  if (!process.env.T1_MAVEN_HOME) throw new Error("Planned Maven is not provisioned.");
  return path.join(process.env.T1_MAVEN_HOME, "bin", process.platform === "win32" ? "mvn.cmd" : "mvn");
}

async function nativeModel(project, plan, directory, { validate = false } = {}) {
  const checkout = path.join(directory, "prepared-checkout");
  const prepared = await preparePlannedWorkspace(project, plan, checkout);
  const root = resolveBuildRoot(checkout, plan.buildRoot);
  let result;
  let models = [];
  let gradleModel = null;
  if (plan.build.tool === "maven") {
    const modelFile = path.join(directory, "effective-pom.xml");
    fs.rmSync(modelFile, { force: true });
    result = nativeCommand(mavenExecutable(), [
      "-B", "-ntp", "-f", path.join(root, "pom.xml"),
      "--toolchains", process.env.T1_MAVEN_TOOLCHAINS_FILE,
      "org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom",
      `-Doutput=${modelFile}`,
    ], { cwd: root, logFile: path.join(directory, "native-model.log") });
    if (result.successful && fs.existsSync(modelFile)) {
      models = [{ path: path.posix.join(plan.buildRoot, "pom.xml"), xml: fs.readFileSync(modelFile, "utf8") }];
    } else if (result.successful) {
      throw new Error("Maven reported success without writing its effective project model.");
    }
    if (result.successful && validate) {
      result = nativeCommand(mavenExecutable(), [
        "-B", "-ntp", "-f", path.join(root, "pom.xml"),
        "--toolchains", process.env.T1_MAVEN_TOOLCHAINS_FILE, "test-compile", "-DskipTests",
      ], {
        cwd: root,
        logFile: path.join(directory, "native-baseline.log"),
        timeoutMs: 1_200_000,
      });
    }
  } else {
    const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    if (!fs.existsSync(wrapper)) {
      return {
        prepared,
        result: { successful: false, error: "The actual build root has no Gradle wrapper.", exitCode: null },
        models,
        checkout,
      };
    }
    const modelFile = path.join(directory, "gradle-environment-model.json");
    fs.rmSync(modelFile, { force: true });
    const args = [
      "--init-script", path.join(scriptDirectory, "environment-preflight.init.gradle"),
      `-Dt1.environment.model=${modelFile}`,
      validate ? "t1EnvironmentValidate" : "t1EnvironmentDiscover",
    ];
    result = nativeCommand(wrapper, [...args, "--no-daemon", "--console=plain", "--stacktrace", "--max-workers=2"], {
      cwd: root,
      logFile: path.join(directory, validate ? "native-baseline.log" : "native-model.log"),
      timeoutMs: validate ? 1_200_000 : 600_000,
    });
    if (result.successful) {
      if (!fs.existsSync(modelFile)) {
        throw new Error("Gradle reported success without its compiler environment evidence.");
      }
      gradleModel = readEnvironmentJson(modelFile);
    }
  }
  writeJson(path.join(directory, "native-model-result.json"), result);
  writeJson(path.join(directory, "checkout-setup.json"), prepared.checkoutSetup);
  return { prepared, result, models, gradleModel, checkout };
}

async function discover(project, directory, operatingSystem, recipe) {
  const runner = await import("./run-t1-autotest.mjs");
  const source = path.join(directory, "source-checkout");
  runner.cloneRepository(project.repository, project.commit, source);
  const mode = process.env.T1_ENVIRONMENT_MODE ?? "prebuilt-workspace";
  if (!["prebuilt-workspace", CONFIGURED_SOURCE_MODE].includes(mode)) {
    throw new Error(`Unknown environment mode: ${mode}`);
  }
  const discovered = mode === CONFIGURED_SOURCE_MODE
    ? discoverConfiguredEnvironmentPlan(project, { checkoutPath: source, operatingSystem })
    : await discoverEnvironmentPlan(project, { checkoutPath: source, operatingSystem, recipe });
  const plan = discovered.state === "ENV_BLOCKED" ? discovered : await hydrateEnvironment(discovered);
  writeJson(path.join(directory, "environment-plan.json"), plan);
  if (plan.state === "ENV_BLOCKED") {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_BLOCKED"));
  }
  exportPlan(plan, null, project);
}

async function refine(project, plan, directory, recipe) {
  if (plan.state === "ENV_BLOCKED") return;
  if (isConfiguredSource(plan)) {
    output("reprovision", "false");
    output("modelReady", "true");
    return;
  }
  provisionPlannedProject(project, plan, directory);
  const observed = await nativeModel(project, plan, directory);
  if (!observed.result.successful) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(
      project, plan, "ENV_UNVERIFIED",
      { nativeModel: observed.result, reason: "The native project model could not be resolved; environment qualification is incomplete." },
    ));
    output("modelReady", "false");
    return;
  }
  const updated = await hydrateEnvironment(await discoverEnvironmentPlan(project, {
    checkoutPath: path.join(directory, "source-checkout"),
    operatingSystem: plan.operatingSystem,
    recipe,
    effectiveMavenModels: observed.models,
    effectiveGradleModel: observed.gradleModel,
  }));
  writeJson(path.join(directory, "environment-plan.json"), updated);
  output("reprovision", hashValue(environmentStack(plan)) !== hashValue(environmentStack(updated)));
  output("modelReady", "true");
}

async function qualify(project, plan, directory, recipe) {
  if (plan.state === "ENV_BLOCKED") {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_BLOCKED"));
    return;
  }
  const { host } = provisionPlannedProject(project, plan, directory);
  if (isConfiguredSource(plan)) {
    const observed = await prepareConfiguredWorkspace(project, plan, directory);
    completeQualification(project, plan, directory, host, observed);
    return;
  }
  const observed = await nativeModel(project, plan, directory, { validate: true });
  if (!observed.result.successful) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(
      project, plan, observed.result.error ? "ENV_UNVERIFIED" : "PROJECT_BASELINE_FAILED",
      { nativeModel: observed.result },
    ));
    return;
  }
  let resolved = await hydrateEnvironment(await discoverEnvironmentPlan(project, {
    checkoutPath: path.join(directory, "source-checkout"),
    operatingSystem: plan.operatingSystem,
    recipe,
    effectiveMavenModels: observed.models,
    effectiveGradleModel: observed.gradleModel,
  }));
  resolved = resolveNativeCompilerRequirements(resolved, {
    nativeResult: observed.result,
    nativeLog: fs.readFileSync(path.join(directory, "native-baseline.log"), "utf8"),
    javaInstallations: host.javaInstallations,
    effectiveMavenModels: observed.models,
  });
  if (resolved.state !== "PLANNED" || hashValue(environmentStack(resolved)) !== hashValue(environmentStack(plan))) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, resolved,
      resolved.state === "ENV_BLOCKED" ? "ENV_BLOCKED" : "ENV_UNVERIFIED",
      { reason: "Native model still has unresolved requirements or needs another environment change." }));
    return;
  }
  completeQualification(project, resolved, directory, host, observed);
}

function completeQualification(project, plan, directory, host, observed) {
  writeJson(path.join(directory, "environment-plan.json"), plan);
  const inputs = snapshotPreparedInputs(observed.checkout, observed.prepared.configured, javaHomes(directory));
  const lock = {
    schemaVersion: 1,
    project: project.id,
    commit: project.commit,
    operatingSystem: plan.operatingSystem,
    harnessCommit: harnessRevision(),
    planHash: hashValue(plan),
    javaInstallations: host.javaInstallations ?? [],
    maven: host.maven,
    android: host.plannedAndroid ?? host.androidSdk,
    preparedInputs: inputs,
    preparationHash: hashValue(inputs),
    qualification: isConfiguredSource(plan) ? CONFIGURED_SOURCE_MODE
      : plan.build.tool === "maven" ? "maven-test-compile" : "gradle-native-classes",
  };
  if (!lock.javaInstallations.length) throw new Error("No concrete JDK installation evidence was recorded.");
  const lockErrors = verifyEnvironmentLock(project, plan, lock, plan.operatingSystem, host.javaInstallations);
  if (lockErrors.length) throw new Error(`Incomplete environment lock: ${JSON.stringify(lockErrors)}`);
  writeJson(path.join(directory, "environment-lock.json"), lock);
  writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_READY", {
    lockHash: hashValue(lock),
    preparationHash: lock.preparationHash,
    ...(observed.result ? { nativeModel: observed.result } : {}),
    qualification: lock.qualification,
    comparisonMode: plan.comparisonMode ?? "prebuilt-workspace",
    caveat: isConfiguredSource(plan)
      ? "Confirms explicit tools and source-workspace preparation; no native compilation or provider success is asserted."
      : "Confirms planned tools and native compilation, not execution of all tests or complete application deployment.",
  }));
}

async function replay(project, plan, directory) {
  const qualification = readEnvironmentJson(path.join(directory, "environment-result.json"));
  if (qualification.state !== "ENV_READY") return;
  const lock = readEnvironmentJson(path.join(directory, "environment-lock.json"));
  const { host } = provisionPlannedProject(project, plan, directory);
  const mismatches = verifyEnvironmentLock(project, plan, lock, plan.operatingSystem, host.javaInstallations ?? []);
  if (lock.harnessCommit !== harnessRevision()) {
    mismatches.push({ reason: "harness-lock-mismatch" });
  }
  if (lock.maven && (lock.maven.version !== host.maven?.version || lock.maven.sha512 !== host.maven?.sha512)) {
    mismatches.push({ reason: "maven-lock-mismatch" });
  }
  if (lock.android?.artifacts &&
      hashValue(lock.android.artifacts) !== hashValue(host.plannedAndroid?.artifacts)) {
    mismatches.push({ reason: "android-lock-mismatch" });
  }
  if (mismatches.length) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_UNVERIFIED", {
      reason: "Installed tools differ from the independently qualified lock.", mismatches,
    }));
    return;
  }
  const configuredSource = isConfiguredSource(plan);
  const observed = configuredSource
    ? await prepareConfiguredWorkspace(project, plan, directory)
    : await nativeModel(project, plan, directory, { validate: true });
  if (!configuredSource && !observed.result.successful) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan,
      observed.result.error ? "ENV_UNVERIFIED" : "PROJECT_BASELINE_FAILED",
      { reason: "The neutral native baseline could not be reproduced.", nativeModel: observed.result }));
    return;
  }
  if (!configuredSource) {
    const compilerProof = verifyNativeCompilerRequirements(plan, {
      nativeResult: observed.result,
      nativeLog: fs.readFileSync(path.join(directory, "native-baseline.log"), "utf8"),
      javaInstallations: host.javaInstallations,
      effectiveMavenModels: observed.models,
    });
    if (!compilerProof.verified) {
      writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_UNVERIFIED", {
        reason: compilerProof.reason,
      }));
      return;
    }
  }
  const actual = snapshotPreparedInputs(observed.checkout, observed.prepared.configured, javaHomes(directory));
  const differences = verifyPreparedInputs(lock.preparedInputs, actual);
  if (differences.length) {
    writeJson(path.join(directory, "environment-result.json"), environmentResult(project, plan, "ENV_UNVERIFIED", {
      reason: "Prepared workspace differs from the qualified workspace.", differences,
    }));
    return;
  }
  writeJson(path.join(directory, "environment-replay.json"), {
    project: project.id, commit: project.commit, operatingSystem: plan.operatingSystem,
    state: "ENV_READY", planHash: hashValue(plan), lockHash: hashValue(lock),
    preparationHash: hashValue(actual), checkout: observed.checkout,
    buildRoot: resolveBuildRoot(observed.checkout, plan.buildRoot),
    comparisonMode: plan.comparisonMode ?? "prebuilt-workspace",
    ...(configuredSource ? { preparationVerified: true } : { nativeBaseline: observed.result }),
  });
  appendEnvironment("T1_PREPARED_CHECKOUT", observed.checkout);
}

async function main() {
  const projectId = argument("--project");
  const project = loadProjects().find((item) => item.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const phase = argument("--phase");
  const directory = path.resolve(argument("--directory"));
  fs.mkdirSync(directory, { recursive: true });
  const operatingSystem = argument("--os", process.env.T1_OPERATING_SYSTEM);
  const recipes = readEnvironmentJson(recipesPath);
  const recipe = recipes.projects[project.id];
  try {
    if (phase === "discover") {
      await discover(project, directory, operatingSystem, recipe);
      return;
    }
    const planFile = path.join(directory, "environment-plan.json");
    if (phase === "load" && !fs.existsSync(planFile)) {
      const resultFile = path.join(directory, "environment-result.json");
      if (!fs.existsSync(resultFile)) {
        writeJson(resultFile, {
          schemaVersion: 1, project: project.id, commit: project.commit, operatingSystem,
          state: "ENV_UNVERIFIED", reason: "The qualified environment artifact is missing.",
          comparisonMode: process.env.T1_ENVIRONMENT_MODE ?? "prebuilt-workspace",
        });
      }
      output("state", "ENV_BLOCKED");
      return;
    }
    const plan = readEnvironmentJson(planFile);
    assertEnvironmentIdentity(project, plan, operatingSystem);
    appendEnvironment("T1_ENVIRONMENT_DIRECTORY", directory);
    appendEnvironment("T1_REQUIRE_ENVIRONMENT_READY", "1");
    if (phase === "load") {
      const locked = argument("--locked") === "true";
      const resultFile = path.join(directory, "environment-result.json");
      if (locked && (!fs.existsSync(resultFile) || readEnvironmentJson(resultFile).state !== "ENV_READY")) {
        output("state", "ENV_BLOCKED");
        return;
      }
      const lock = locked ? readEnvironmentJson(path.join(directory, "environment-lock.json")) : null;
      if (lock) {
        const qualification = readEnvironmentJson(resultFile);
        assertEnvironmentIdentity(project, lock, operatingSystem);
        assertEnvironmentIdentity(project, qualification, operatingSystem);
        if (lock.planHash !== hashValue(plan) || qualification.planHash !== hashValue(plan) ||
            qualification.lockHash !== hashValue(lock)) {
          throw new Error("Downloaded environment plan, lock, and qualification do not match.");
        }
      }
      exportPlan(plan, lock, project);
    } else if (phase === "record-java") {
      await recordJava(plan, directory, argument("--role"));
    } else if (phase === "provision") {
      provisionPlannedProject(project, plan, directory);
    } else if (phase === "refine") {
      await refine(project, plan, directory, recipe);
    } else if (phase === "qualify") {
      await qualify(project, plan, directory, recipe);
    } else if (phase === "replay") {
      await replay(project, plan, directory);
    } else if (phase === "record-failure") {
      const resultFile = path.join(directory, "environment-result.json");
      if (!fs.existsSync(resultFile)) writeJson(resultFile, environmentResult(
        project, plan, "ENV_UNVERIFIED", { reason: "Environment provisioning or qualification did not complete." },
      ));
      const result = readEnvironmentJson(resultFile);
      console.log(`${project.id}: ${result.state}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const reason = String(result.reason ?? result.error ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
          `## Environment: ${project.id}`,
          "",
          `**State:** ${result.state}; **scope:** ${plan.scope}; **build root:** \`${plan.buildRoot}\`.`,
          "",
          `Project JDK ${plan.java?.project?.version ?? "unresolved"}; build JVM ${plan.java?.build?.version ?? "unresolved"}; server JVM ${plan.java?.runtime?.version ?? "unresolved"}.`,
          "",
          reason,
          "",
          isConfiguredSource(plan)
            ? "Configured-source mode checks explicit tools and workspace preparation; no native compilation gate."
            : "Only ENV_READY is eligible for provider scoring. Native compilation is performed before IDE timing.",
          "",
        ].join("\n"));
      }
    } else {
      throw new Error(`Unknown environment phase: ${phase}`);
    }
  } catch (error) {
    writeJson(path.join(directory, "environment-result.json"), {
      schemaVersion: 1,
      project: project.id,
      commit: project.commit,
      operatingSystem,
      state: "ENV_UNVERIFIED",
      comparisonMode: process.env.T1_ENVIRONMENT_MODE ?? "prebuilt-workspace",
      phase,
      error: error instanceof Error ? error.stack : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
