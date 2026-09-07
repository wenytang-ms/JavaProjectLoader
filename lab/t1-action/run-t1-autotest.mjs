import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PreparedWorkspaceDriver,
  rebaseRepositoryFile,
  resolvePreparedWorkspace,
  snapshotPreparedWorkspace,
  verifyActualWorkspace,
} from "./prepared-workspace-driver.mjs";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { writeJsonArtifact as writeJson } from "./artifact-writer.mjs";
import { loadProjects } from "./create-matrix.mjs";
import { copyEnvironmentEvidence, loadProviderEnvironment } from "./environment-replay.mjs";
import { createEnvironmentBlockedResult } from "./environment-result.mjs";
import { activateBuildJava } from "./environment-toolchains.mjs";
import {
  createProjectSettings,
  discoverProjectEnvironment,
  getProviderSetup,
} from "./project-environment.mjs";
import {
  buildProviderLoadResult,
  detectProviderTerminalState,
  isProviderBusy,
} from "./result-classification.mjs";
import {
  analyzeBuildOutput,
  analyzeProviderLog,
  analyzeProviderStatus,
  analyzeStatusProblemCounts,
  combinedFatalEvidence,
  providerEvidenceVersions,
} from "./provider-evidence.mjs";
import {
  createNormalizedEvidence,
  evaluateT1,
  T1_COLLECTOR_VERSION,
  T1_ENVIRONMENT_COLLECTOR_VERSION,
  T1_ENVIRONMENT_RULE_VERSION,
  T1_RULE_VERSION,
} from "./t1-evaluator.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const importExtensionPath = path.join(repositoryRoot, "lab", "import-extension");
const providerExtensions = {
  jdtls: "vscjava.vscode-java-pack",
  intellij: "JetBrains.intellij-server",
  oracle: "Oracle.oracle-java",
};
const providerExtensionSources = {
  jdtls: ["vscjava.vscode-java-pack@0.31.1"],
  intellij: ["JetBrains.intellij-server"],
  oracle: ["Oracle.oracle-java@26.0.2"],
};
const redhatJavaExtension = {
  inventory: "redhat.java@1.56.2026073109",
  url:
    "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/" +
    "redhat/vsextensions/java/1.56.2026073109/vspackage",
};
const providerRefreshExtensions = {
  jdtls: [
    "vscjava.vscode-java-pack",
    "vscjava.vscode-java-test",
    "vscjava.vscode-java-debug",
    "vscjava.vscode-java-dependency",
    "vscjava.vscode-maven",
    "vscjava.vscode-gradle",
    "redhat.java",
  ],
  intellij: ["JetBrains.intellij-server"],
  oracle: ["Oracle.oracle-java"],
};
const approvedIntellijOnboarding = {
  region: "middle_east",
  dataSharing: "none",
  eulaVersion: "1.0",
  eulaEffectiveDate: "July 31, 2026",
  eulaSha256: "ca5e72e6658dd12b6149ddf81411d0029d7d63aaea0c74e2282e0e386832e371",
};
let activeOutputDirectory = null;
let activeEnvironmentRun = null;
let activeProviderLoad = null;
const scriptStartedAt = Date.now();
const minimumTimeoutSeconds = Number(
  process.env.T1_MIN_TIMEOUT_SECONDS || 1_800,
);
const functionalFallbackQuietMs = 60_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}` +
      (result.stderr ? `: ${result.stderr.trim()}` : ""),
    );
  }
  return result.stdout ?? "";
}

function readHarnessCommit({ required = false } = {}) {
  try {
    return run("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      capture: true,
    }).trim();
  } catch (error) {
    if (required) {
      throw error;
    }
    return null;
  }
}

async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length === 0) {
    throw new Error(`Downloaded file is empty: ${url}.`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function cloneRepository(repository, commit, targetPath, { submodules = false } = {}) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: targetPath });
  if (process.platform === "win32") {
    run("git", ["config", "core.longpaths", "true"], { cwd: targetPath });
  }
  run("git", ["remote", "add", "origin", repository], { cwd: targetPath });
  run(
    "git",
    ["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", commit],
    { cwd: targetPath },
  );
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: targetPath });
  if (submodules) {
    run(
      "git",
      ["submodule", "update", "--init", "--recursive", "--depth=1"],
      { cwd: targetPath },
    );
  }
}

export function gradleSiblingProjectSettings(
  name,
  relativePath,
  kotlinDsl = false,
) {
  const normalizedPath = relativePath.split(path.sep).join("/");
  return kotlinDsl
    ? `\ninclude(":${name}")\n` +
      `project(":${name}").projectDir = file("${normalizedPath}")\n`
    : `\ninclude ':${name}'\n` +
      `project(':${name}').projectDir = file('${normalizedPath}')\n`;
}

export function applyWindowsGradleExecutableExtensions(
  checkoutPath,
  configuration,
  platform = process.platform,
) {
  if (!configuration || platform !== "win32") {
    return null;
  }
  const filePath = path.join(checkoutPath, configuration.file);
  let source = fs.readFileSync(filePath, "utf8");
  for (const tool of configuration.tools) {
    const before = source;
    for (const quote of ['"', "'"]) {
      source = source.replaceAll(
        `file(${quote}bin/${tool}${quote})`,
        `file(${quote}bin/${tool}.exe${quote})`,
      );
    }
    if (source === before) {
      throw new Error(
        `Could not add the Windows executable extension for ${tool} in ` +
        configuration.file,
      );
    }
  }
  fs.writeFileSync(filePath, source);
  return {
    file: configuration.file,
    tools: configuration.tools,
  };
}

export function applyWindowsTextReplacements(
  checkoutPath,
  replacements,
  platform = process.platform,
) {
  if (!replacements?.length || platform !== "win32") {
    return [];
  }
  return replacements.map((replacement) => {
    const filePath = path.join(checkoutPath, replacement.file);
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Could not find the configured Windows replacement in ` +
        replacement.file,
      );
    }
    fs.writeFileSync(
      filePath,
      source.replaceAll(replacement.from, replacement.to),
    );
    return replacement.file;
  });
}

export function applyWindowsJavaToolCopies(
  javaHome,
  copies,
  platform = process.platform,
) {
  if (!copies?.length || platform !== "win32") {
    return [];
  }
  return copies.map((copy) => {
    const source = path.join(javaHome, ...copy.source.split("/"));
    const target = path.join(javaHome, ...copy.target.split("/"));
    if (!fs.existsSync(source)) {
      throw new Error(`Required Java tool does not exist: ${source}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return {
      source: copy.source,
      target: copy.target,
    };
  });
}

export function cloneProject(project, checkoutPath) {
  const checkout = project.projectSetup?.checkout ?? {};
  cloneRepository(project.repository, project.commit, checkoutPath, {
    submodules: checkout.submodules === true,
  });
  const windowsGradleExecutableExtensions =
    applyWindowsGradleExecutableExtensions(
      checkoutPath,
      checkout.windowsGradleExecutableExtensions,
    );
  const windowsTextReplacements = applyWindowsTextReplacements(
    checkoutPath,
    checkout.windowsTextReplacements,
  );

  const siblingProjects = [];
  for (const dependency of checkout.gradleSiblingProjects ?? []) {
    const dependencyDirectory = path.join(".t1-dependencies", dependency.name);
    const dependencyPath = path.join(
      checkoutPath,
      dependencyDirectory,
    );
    cloneRepository(dependency.repository, dependency.commit, dependencyPath);
    siblingProjects.push({
      name: dependency.name,
      repository: dependency.repository,
      commit: dependency.commit,
      relativePath: path.relative(checkoutPath, dependencyPath),
    });
  }

  if (siblingProjects.length > 0) {
    const groovySettings = path.join(checkoutPath, "settings.gradle");
    const kotlinSettings = path.join(checkoutPath, "settings.gradle.kts");
    const settingsPath = fs.existsSync(kotlinSettings)
      ? kotlinSettings
      : groovySettings;
    if (!fs.existsSync(settingsPath)) {
      throw new Error(
        `Gradle sibling projects require settings.gradle or settings.gradle.kts: ` +
        checkoutPath,
      );
    }
    const kotlinDsl = settingsPath.endsWith(".kts");
    for (const dependency of siblingProjects) {
      fs.appendFileSync(
        settingsPath,
        gradleSiblingProjectSettings(
          dependency.name,
          dependency.relativePath,
          kotlinDsl,
        ),
      );
    }
  }

  if (project.projectSetup?.bootstrapGradleVersion) {
    run(
      "gradle",
      [
        "wrapper",
        "--gradle-version",
        project.projectSetup.bootstrapGradleVersion,
        "--distribution-type",
        "bin",
        "--no-daemon",
      ],
      { cwd: checkoutPath },
    );
  }

  return {
    submodules: checkout.submodules === true,
    siblingProjects,
    windowsGradleExecutableExtensions,
    windowsTextReplacements,
    requiresMaterializedWorkspace:
      checkout.submodules === true ||
      siblingProjects.length > 0 ||
      windowsGradleExecutableExtensions !== null ||
      windowsTextReplacements.length > 0,
  };
}

export function materializeWorkspace(sourcePath, targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
  });
  return targetPath;
}

export function configureGradleToolchainEnvironment(
  project,
  environment = process.env,
) {
  if (
    project.projectSetup?.buildTool !== "gradle" ||
    project.projectSetup?.gradleToolchains?.restrictToConfiguredJdks !== true
  ) {
    return null;
  }
  const projectJavaHome = environment.T1_PROJECT_JAVA_HOME;
  if (!projectJavaHome) {
    throw new Error(
      `${project.id} requires T1_PROJECT_JAVA_HOME for Gradle toolchains.`,
    );
  }
  const configuredHomes = [
    projectJavaHome,
    ...(environment.T1_TOOLCHAIN_JAVA_HOMES ?? "")
      .split(";")
      .filter(Boolean),
  ];
  const properties = [
    `-Dorg.gradle.java.installations.paths=${configuredHomes.join(",")}`,
    "-Dorg.gradle.java.installations.auto-detect=false",
    "-Dorg.gradle.java.installations.auto-download=false",
  ];
  environment.GRADLE_OPTS = [
    environment.GRADLE_OPTS,
    ...properties,
  ].filter(Boolean).join(" ");
  return {
    homes: configuredHomes,
    gradleOpts: environment.GRADLE_OPTS,
  };
}

export function writeGradleToolchainProperties(
  checkoutPath,
  toolchainEnvironment,
) {
  if (!toolchainEnvironment) {
    return null;
  }
  const propertiesPath = path.join(checkoutPath, "gradle.properties");
  const normalizedHomes = toolchainEnvironment.homes.map((home) =>
    home.split(path.sep).join("/"),
  );
  const content = [
    "",
    `org.gradle.java.installations.paths=${normalizedHomes.join(",")}`,
    "org.gradle.java.installations.auto-detect=false",
    "org.gradle.java.installations.auto-download=false",
    "",
  ].join("\n");
  fs.appendFileSync(propertiesPath, content);
  return propertiesPath;
}

export function createSyntheticMavenWorkspace(project, checkoutPath, workspacePath) {
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const sourcePath = path.join(checkoutPath, ...project.relativeFile.split("/"));
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Pinned T1 source file does not exist: ${sourcePath}`);
  }
  const targetPath = path.join(
    workspacePath,
    ...project.syntheticMavenTargetFile.split("/"),
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.writeFileSync(
    path.join(workspacePath, "pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>t1.fixture</groupId>
  <artifactId>${project.id}</artifactId>
  <version>1.0-SNAPSHOT</version>
  <properties>
    <maven.compiler.release>${project.javaVersion}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
`,
  );
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findLicenseFrame(driver, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const page = driver.getPage();
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && (await frame.title()) === "License Setup") {
        return frame;
      }
    }
    await wait(500);
  }
  throw new Error(`License Setup webview did not appear within ${timeoutMs}ms`);
}

async function saveScreenshot(driver, outputDirectory, name) {
  try {
    await driver.screenshot(path.join(outputDirectory, `${name}.png`));
    return true;
  } catch (error) {
    const record = {
      name,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack : String(error),
    };
    fs.appendFileSync(
      path.join(outputDirectory, "screenshot-errors.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    console.warn(`Screenshot ${name} failed: ${record.error}`);
    return false;
  }
}

async function captureLicensePage(driver, outputDirectory, name) {
  const frame = await findLicenseFrame(driver, 10_000);
  await saveScreenshot(driver, outputDirectory, name);
  const evidence = await frame.evaluate(() => ({
    title: document.title,
    bodyText: document.body?.innerText ?? "",
    html: document.documentElement.outerHTML,
  }));
  writeJson(path.join(outputDirectory, `${name}.json`), evidence);
}

export function isTransientWebviewError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Frame was detached|Execution context was destroyed|Target page.*closed|locator\.(?:waitFor|evaluate): Timeout/i
    .test(message);
}

export async function clickWebviewElement(locator) {
  try {
    await locator.waitFor({ state: "attached", timeout: 15_000 });
    await locator.evaluate((element) => element.click());
    return true;
  } catch (error) {
    if (isTransientWebviewError(error)) {
      return false;
    }
    throw error;
  }
}

async function clickUntilTransition(
  driver,
  initialFrame,
  sourceSelector,
  targetSelector,
) {
  const startedAt = Date.now();
  let frame = initialFrame;
  while (Date.now() - startedAt < 60_000) {
    if (await frame.locator(targetSelector).isVisible().catch(() => false)) {
      return frame;
    }
    const source = frame.locator(sourceSelector);
    if (await source.isVisible().catch(() => false)) {
      await clickWebviewElement(source);
    }
    frame = await findLicenseFrame(driver, 5_000).catch(() => frame);
    await wait(1_000);
  }
  throw new Error(
    `License Setup did not transition from ${sourceSelector} to ${targetSelector}`,
  );
}

async function completeIntellijOnboarding(driver, outputDirectory) {
  const startedAt = Date.now();
  let frame;
  try {
    frame = await findLicenseFrame(driver, 10_000);
  } catch {
    await driver.executeVSCodeCommand("jetbrains.showLicenseSetup");
    try {
      frame = await findLicenseFrame(driver);
    } catch (error) {
      if (process.env.T1_ALLOW_EXISTING_INTELLIJ_ONBOARDING === "1") {
        return {
          status: "already-complete",
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    }
  }
  let middleEast = frame.locator("label.region-row", { hasText: "Middle East" });
  if (!(await clickWebviewElement(middleEast))) {
    frame = await findLicenseFrame(driver, 15_000);
    middleEast = frame.locator("label.region-row", { hasText: "Middle East" });
    if (!(await clickWebviewElement(middleEast))) {
      throw new Error("Middle East region could not be selected");
    }
  }
  await wait(500);
  if (!(await middleEast.locator('input[name="region"]').isChecked())) {
    throw new Error("Middle East region was not selected");
  }
  await captureLicensePage(driver, outputDirectory, "02-region-middle-east");
  frame = await clickUntilTransition(
    driver,
    frame,
    ".region-next",
    ".eula-wizard",
  );
  const eulaText = (await frame.locator(".eula-wizard").innerText())
    .replace(/\r\n/g, "\n")
    .trim();
  const actualEulaHash = createHash("sha256").update(eulaText).digest("hex");
  const approval = {
    ...approvedIntellijOnboarding,
    actualEulaSha256: actualEulaHash,
    matches: actualEulaHash === approvedIntellijOnboarding.eulaSha256,
  };
  writeJson(path.join(outputDirectory, "eula-approval.json"), approval);
  if (!approval.matches) {
    throw new Error(
      `EULA hash changed: expected ${approvedIntellijOnboarding.eulaSha256}, ` +
      `got ${actualEulaHash}`,
    );
  }
  await captureLicensePage(driver, outputDirectory, "03-approved-eula");
  frame = await clickUntilTransition(
    driver,
    frame,
    ".eula-accept",
    'button.data-sharing-action[value="none"]',
  );

  frame = await findLicenseFrame(driver, 15_000);
  const noSharing = frame.locator('button.data-sharing-action[value="none"]');
  await noSharing.waitFor({ state: "visible", timeout: 15_000 });
  await captureLicensePage(driver, outputDirectory, "04-data-sharing-none");
  const dataSharingStartedAt = Date.now();
  while (
    await noSharing.isVisible().catch(() => false) &&
    Date.now() - dataSharingStartedAt < 30_000
  ) {
    if (!(await clickWebviewElement(noSharing))) {
      break;
    }
    await wait(1_000);
  }
  if (await noSharing.isVisible().catch(() => false)) {
    throw new Error("Data-sharing selection did not close the onboarding page");
  }
  await saveScreenshot(driver, outputDirectory, "05-onboarding-complete");

  const completedAt = Date.now();
  const result = {
    ...approvedIntellijOnboarding,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
  };
  writeJson(path.join(outputDirectory, "onboarding.json"), result);
  return result;
}

async function waitForT1Result(driver, resultPath, deadline, outputDirectory) {
  const startedAt = Date.now();
  let screenshotIndex = 0;
  while (!fs.existsSync(resultPath) && Date.now() < deadline) {
    await wait(1_000);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1_000);
    if (elapsedSeconds >= (screenshotIndex + 1) * 60) {
      screenshotIndex += 1;
      await saveScreenshot(
        driver,
        outputDirectory,
        `06-waiting-t1-${screenshotIndex}m`,
      );
    }
  }
  if (!fs.existsSync(resultPath)) {
    throw new Error("T1 result was not written before the load deadline");
  }
  return JSON.parse(fs.readFileSync(resultPath, "utf8"));
}

function findProviderLog(userDataDirectory, provider) {
  const files = listFiles(userDataDirectory);
  return files.find((file) => {
    const normalized = file.path.replaceAll("\\", "/");
    if (provider === "jdtls") {
      return normalized.endsWith("/redhat.java/jdt_ws/.metadata/.log");
    }
    if (provider === "intellij") {
      return normalized.endsWith(
        "/JetBrains.intellij-server/system/log/intellij-server.log",
      );
    }
    return provider === "oracle" &&
      normalized.includes("/logs/") &&
      normalized.includes("/output_logging_") &&
      /(?:^|\/)(?:\d+-)?Oracle Java SE Language Server\.log$/i.test(normalized);
  })?.path ?? null;
}

function findOracleProjectLog(userDataDirectory) {
  return listFiles(userDataDirectory).find((file) => {
    const normalized = file.path.replaceAll("\\", "/");
    return normalized.includes("/Oracle.oracle-java/userdir/var/log/") &&
      normalized.endsWith("/messages.log");
  })?.path ?? null;
}

export function findBuildOutputLogs(userDataDirectory, provider) {
  return listFiles(userDataDirectory)
    .filter((file) => {
      const normalized = file.path.replaceAll("\\", "/");
      if (!normalized.includes("/logs/") || !normalized.includes("/output_logging_")) {
        return false;
      }
      const name = path.basename(file.path);
      if (provider === "intellij") {
        return /Java and Kotlin by IntelliJ IDEA.*Build\.log$/i.test(name);
      }
      return /^(?:\d+-)?(?:Gradle for Java|Maven for Java|Build Server for Gradle \(Build\))\.log$/i
        .test(name);
    })
    .map((file) => file.path)
    .sort();
}

export function readBuildOutputEvidence(userDataDirectory, provider) {
  const buildOutputPaths = findBuildOutputLogs(userDataDirectory, provider);
  const content = buildOutputPaths
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  return {
    buildOutputPaths,
    content,
    fatalBuildOutputMatches: analyzeBuildOutput(content),
  };
}

function enrichProviderEvidence({
  provider,
  providerLogContent,
  statusBarText,
  buildOutput,
}) {
  const evidence = {
    ...analyzeProviderLog(provider, providerLogContent),
    buildOutputPaths: buildOutput.buildOutputPaths,
    fatalBuildOutputMatches: buildOutput.fatalBuildOutputMatches,
    fatalStatusMatches: analyzeProviderStatus(provider, statusBarText),
    statusProblemCounts: analyzeStatusProblemCounts(statusBarText),
  };
  return {
    ...evidence,
    fatalEvidenceMatches: combinedFatalEvidence(evidence),
  };
}

async function readStatusBarText(driver, timeoutMs = 10_000) {
  const page = driver.getPage();
  const read = async () => {
    const items = page.locator("footer a, footer [role='button']");
    const values = [];
    for (let index = 0; index < await items.count(); index += 1) {
      const value = (await items.nth(index).textContent().catch(() => ""))?.trim();
      if (value) {
        values.push(value);
      }
    }
    return values.join(" | ");
  };
  let timer;
  try {
    return await Promise.race([
      read(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForProviderLogMilestone(
  driver,
  profile,
  provider,
  timeoutMs,
  outputDirectory,
) {
  const startedAt = Date.now();
  let logPath = null;
  let projectLogPath = null;
  let lastContent = "";
  let lastBuildOutputContent = "";
  let lastEvidenceChangeAt = startedAt;
  let evidence = enrichProviderEvidence({
    provider,
    providerLogContent: "",
    statusBarText: "",
    buildOutput: {
      buildOutputPaths: [],
      content: "",
      fatalBuildOutputMatches: [],
    },
  });
  let lastStatusBarText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const statusBarText = (await readStatusBarText(driver).catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    lastStatusBarText = statusBarText;
    const busy = isProviderBusy(provider, statusBarText);
    const terminalState = detectProviderTerminalState(
      provider,
      statusBarText,
      busy,
    );
    logPath ??= findProviderLog(profile.userDataDirectory, provider);
    if (provider === "oracle") {
      projectLogPath ??= findOracleProjectLog(profile.userDataDirectory);
    }
    let providerLogContent = lastContent;
    if (logPath && fs.existsSync(logPath)) {
      const outputContent = fs.readFileSync(logPath, "utf8");
      const projectContent =
        projectLogPath && fs.existsSync(projectLogPath)
          ? fs.readFileSync(projectLogPath, "utf8")
          : "";
      const content = projectContent
        ? `${outputContent}\n--- Oracle NetBeans project log ---\n${projectContent}`
        : outputContent;
      if (content !== lastContent) {
        lastContent = content;
        lastEvidenceChangeAt = Date.now();
      }
      providerLogContent = content;
    }
    const buildOutput = readBuildOutputEvidence(
      profile.userDataDirectory,
      provider,
    );
    if (buildOutput.content !== lastBuildOutputContent) {
      lastBuildOutputContent = buildOutput.content;
      lastEvidenceChangeAt = Date.now();
    }
    evidence = enrichProviderEvidence({
      provider,
      providerLogContent,
      statusBarText,
      buildOutput,
    });
    const hardStatusMatches = evidence.fatalStatusMatches.filter(
      (match) => !["java-warning", "java-error"].includes(match),
    );
    if (
      evidence.fatalLogMatches.length > 0 ||
      evidence.fatalBuildOutputMatches.length > 0 ||
      hardStatusMatches.length > 0
    ) {
      const result = {
        loaded: false,
        failed: true,
        failureCategory: "provider-import-failed",
        logPath,
        durationMs: Date.now() - startedAt,
        statusBarText,
        ...evidence,
        lastObservation: evidence.fatalEvidenceMatches[0],
      };
      writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
      return result;
    }
    if (logPath && fs.existsSync(logPath)) {
      if (evidence.nativeCompleted) {
        const result = {
          loaded: true,
          failed: false,
          logPath,
          projectLogPath,
          durationMs: Date.now() - startedAt,
          statusBarText,
          completionEvidence: "native-log",
          ...evidence,
        };
        writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
        return result;
      }
      const logQuiet =
        Date.now() - lastEvidenceChangeAt >= functionalFallbackQuietMs;
      if (
        provider === "intellij" &&
        evidence.functionalCandidate &&
        terminalState === "ready" &&
        logQuiet
      ) {
        const result = {
          loaded: true,
          failed: false,
          logPath,
          projectLogPath,
          durationMs: Date.now() - startedAt,
          statusBarText,
          completionEvidence: "functional-fallback-candidate",
          ...evidence,
          lastObservation: "functional-fallback-candidate",
        };
        writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
        return result;
      }
    }
    if (
      provider === "jdtls" &&
      (terminalState === "warning" || terminalState === "error")
    ) {
      const result = {
        loaded: true,
        failed: false,
        logPath,
        durationMs: Date.now() - startedAt,
        statusBarText,
        completionEvidence: "terminal-status",
        ...evidence,
        lastObservation: `java-${terminalState}`,
      };
      writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
      return result;
    }
    if (
      provider === "jdtls" &&
      terminalState === "ready" &&
      Date.now() - lastEvidenceChangeAt >= functionalFallbackQuietMs
    ) {
      const result = {
        loaded: true,
        failed: false,
        logPath,
        durationMs: Date.now() - startedAt,
        statusBarText,
        completionEvidence: "functional-fallback-candidate",
        ...evidence,
        lastObservation: "functional-fallback-candidate",
      };
      writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
      return result;
    }
    await wait(2000);
  }

  const result = {
    loaded: false,
    failed: false,
    failureCategory: "provider-log-timeout",
    logPath,
    durationMs: Date.now() - startedAt,
    statusBarText: lastStatusBarText,
    ...evidence,
  };
  writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
  return result;
}

export async function waitForProviderIdle(
  driver,
  provider,
  profile,
  timeoutMs,
  outputDirectory,
  stableMs = 30_000,
  { now = Date.now, sleep = wait } = {},
) {
  const startedAt = now();
  let stableStartedAt = null;
  let stableTerminalState = null;
  let lastTerminalState = null;
  let lastText = null;
  let lastBuildOutputContent = "";
  const fatalBuildOutputMatches = new Set();
  const buildOutputPaths = new Set();
  const transitions = [];

  do {
    const text = (await readStatusBarText(driver)).replace(/\s+/g, " ").trim();
    if (text !== lastText) {
      transitions.push({
        at: new Date().toISOString(),
        text: text.slice(0, 1000),
      });
      lastText = text;
    }
    const busy = isProviderBusy(provider, text);
    const buildOutput = readBuildOutputEvidence(
      profile.userDataDirectory,
      provider,
    );
    const buildOutputChanged =
      buildOutput.content !== lastBuildOutputContent;
    for (const match of buildOutput.fatalBuildOutputMatches) {
      fatalBuildOutputMatches.add(match);
    }
    for (const file of buildOutput.buildOutputPaths) {
      buildOutputPaths.add(file);
    }
    if (buildOutputChanged) {
      lastBuildOutputContent = buildOutput.content;
    }
    const terminalState =
      fatalBuildOutputMatches.size > 0
        ? "error"
        : detectProviderTerminalState(provider, text, busy);
    lastTerminalState = terminalState;
    if (terminalState) {
      if (buildOutputChanged) {
        stableStartedAt = now();
      }
      if (stableTerminalState !== terminalState) {
        stableTerminalState = terminalState;
        stableStartedAt = now();
      }
      if (now() - stableStartedAt >= stableMs) {
        const result = {
          idle: true,
          settled: true,
          terminalState,
          durationMs: now() - startedAt,
          stableMs,
          finalStatusBarText: text,
          buildOutputPaths: [...buildOutputPaths],
          fatalBuildOutputMatches: [...fatalBuildOutputMatches],
          transitions,
        };
        writeJson(path.join(outputDirectory, "provider-ui-readiness.json"), result);
        return result;
      }
    } else {
      stableStartedAt = null;
      stableTerminalState = null;
    }
    if (now() - startedAt >= timeoutMs) {
      break;
    }
    await sleep(Math.min(1000, timeoutMs - (now() - startedAt)));
  } while (now() - startedAt < timeoutMs);

  const result = {
    idle: false,
    settled: false,
    terminalState: lastTerminalState,
    durationMs: now() - startedAt,
    stableMs,
    finalStatusBarText: lastText ?? "",
    buildOutputPaths: [...buildOutputPaths],
    fatalBuildOutputMatches: [...fatalBuildOutputMatches],
    transitions,
  };
  writeJson(path.join(outputDirectory, "provider-ui-readiness.json"), result);
  return result;
}

async function waitForProviderIdleAfterLog(
  driver,
  provider,
  profile,
  deadline,
  outputDirectory,
  log,
) {
  if (!log.loaded) {
    return buildProviderLoadResult(log, null);
  }
  const ui = await waitForProviderIdle(
    driver,
    provider,
    profile,
    Math.max(0, deadline - Date.now()),
    outputDirectory,
  );
  return buildProviderLoadResult({
    ...log,
    fatalBuildOutputMatches: [...new Set([
      ...(log.fatalBuildOutputMatches ?? []),
      ...(ui.fatalBuildOutputMatches ?? []),
    ])],
  }, ui);
}

export async function refreshProviderLoadEvidence(
  driver,
  providerLoad,
  provider,
  profile,
) {
  const logPath = providerLoad.log?.logPath;
  const providerLogContent = [logPath, providerLoad.log?.projectLogPath]
    .filter((file) => file && fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const statusBarText = (await readStatusBarText(driver)).replace(/\s+/g, " ").trim();
  const buildOutput = readBuildOutputEvidence(
    profile.userDataDirectory,
    provider,
  );
  const evidence = enrichProviderEvidence({
    provider,
    providerLogContent,
    statusBarText,
    buildOutput,
  });
  // Live UI replaces old status text; actual log/build failures are never cleared.
  evidence.fatalLogMatches = [...new Set([
    ...(providerLoad.log?.fatalLogMatches ?? []),
    ...evidence.fatalLogMatches,
  ])];
  evidence.fatalBuildOutputMatches = [...new Set([
    ...(providerLoad.log?.fatalBuildOutputMatches ?? []),
    ...(providerLoad.ui?.fatalBuildOutputMatches ?? []),
    ...evidence.fatalBuildOutputMatches,
  ])];
  evidence.fatalEvidenceMatches = combinedFatalEvidence(evidence);
  const log = {
    ...providerLoad.log,
    ...evidence,
    nativeCompleted: providerLoad.log?.nativeCompleted === true || evidence.nativeCompleted,
    nativeCompletionMatches: [...new Set([
      ...(providerLoad.log?.nativeCompletionMatches ?? []),
      ...evidence.nativeCompletionMatches,
    ])],
    statusBarText,
  };
  const terminalState = evidence.fatalBuildOutputMatches.length > 0
    ? "error"
    : detectProviderTerminalState(provider, statusBarText, isProviderBusy(provider, statusBarText));
  const settled = providerLoad.ui?.settled === true &&
    providerLoad.ui.terminalState === terminalState;
  const ui = {
    ...providerLoad.ui,
    idle: settled,
    settled,
    terminalState,
    finalStatusBarText: statusBarText,
    observedAt: new Date().toISOString(),
    buildOutputPaths: evidence.buildOutputPaths,
    fatalBuildOutputMatches: evidence.fatalBuildOutputMatches,
  };
  const refreshed = buildProviderLoadResult(log, ui);
  if (evidence.fatalEvidenceMatches.length === 0) {
    return refreshed;
  }
  const warningOnly = evidence.fatalEvidenceMatches.every(
    (match) => match === "java-warning",
  );
  if (warningOnly) {
    return {
      ...refreshed,
      loaded: true,
      importCompleted: true,
      importStatus: "loaded-with-project-errors",
      terminalState: "warning",
      failureCategory: "provider-project-errors",
      completionEvidence: "fatal-status",
      log,
    };
  }
  return {
    ...refreshed,
    loaded: false,
    importCompleted: true,
    importStatus: "import-failed",
    terminalState: "error",
    failureCategory: "provider-import-failed",
    completionEvidence: "fatal-log",
    log,
  };
}

export async function observeFinalProviderLoad(
  driver,
  provider,
  profile,
  deadline,
  outputDirectory,
  log,
  { now = Date.now, sleep = wait } = {},
) {
  do {
    const ui = await waitForProviderIdle(
      driver, provider, profile, Math.max(0, deadline - now()), outputDirectory,
      30_000, { now, sleep },
    );
    const refreshed = await refreshProviderLoadEvidence(
      driver, buildProviderLoadResult(log, ui), provider, profile,
    );
    if (
      !log.loaded ||
      !ui.settled ||
      refreshed.ui?.settled ||
      refreshed.log.fatalLogMatches.length > 0 ||
      refreshed.log.fatalBuildOutputMatches.length > 0 ||
      now() >= deadline
    ) {
      return refreshed;
    }
    log = refreshed.log;
  } while (true);
}

export async function collectSourceResultIfReady(
  driver, resultPath, deadline, outputDirectory, providerLoad, project, provider,
) {
  if (fs.existsSync(resultPath)) {
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  }
  if (providerLoad.importStatus === "ready" && Date.now() < deadline) {
    return waitForT1Result(driver, resultPath, deadline, outputDirectory);
  }
  return {
    schemaVersion: 1,
    project: project.id,
    product: provider,
    status: "failure",
    sourceReadyAt: null,
    documentSymbolReady: false,
    hoverReady: false,
    sourceAttempts: 0,
    failureCategory: providerLoad.failureCategory || "source-readiness-not-run",
    error: null,
  };
}

export async function captureStableDiagnostics(
  driver,
  relativeFiles,
  outputDirectory,
  scope = "workspace",
) {
  const resultPath = path.join(outputDirectory, "diagnostics-result.json");
  fs.rmSync(resultPath, { force: true });
  const stableMs = 15_000;
  const timeoutMs = 60_000;
  let commandError = null;
  const command = driver.executeVSCodeCommand(
    "javaImportBenchmark.captureDiagnostics",
    {
      scope,
      relativeFiles,
      resultPath,
      stableMs,
      timeoutMs,
    },
  ).catch((error) => {
    commandError = error;
  });
  const resultWritten = (async () => {
    const deadline = Date.now() + timeoutMs + stableMs + 15_000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) {
      await wait(500);
    }
  })();
  await Promise.race([command, resultWritten]);
  if (commandError && !fs.existsSync(resultPath)) {
    return {
      stable: false,
      scope,
      counts: { error: 0, warning: 0, information: 0, hint: 0 },
      diagnosticsCaptured: false,
      error:
        commandError instanceof Error
          ? commandError.stack
          : String(commandError),
    };
  }

  const waitStartedAt = Date.now();
  const waitTimeoutMs =
    scope === "workspace"
      ? timeoutMs + stableMs + 60_000
      : relativeFiles.length * (timeoutMs + stableMs) + 60_000;
  while (!fs.existsSync(resultPath) && Date.now() - waitStartedAt < waitTimeoutMs) {
    await wait(1000);
  }
  if (!fs.existsSync(resultPath)) {
    return {
      stable: false,
      scope,
      counts: { error: 0, warning: 0, information: 0, hint: 0 },
      diagnosticsCaptured: false,
      error: `Diagnostic result was not written within ${waitTimeoutMs}ms`,
    };
  }
  return {
    ...JSON.parse(fs.readFileSync(resultPath, "utf8")),
    diagnosticsCaptured: true,
  };
}

function appendGithubSummary(result) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const durationSeconds = (Number(result.totalDurationMs || 0) / 1000).toFixed(1);
  const project = result.project ?? "unknown-project";
  const provider = result.product ?? result.provider ?? "unknown-provider";
  fs.appendFileSync(
    summaryPath,
    [
      `### ${project} / ${provider}`,
      "",
      "| Result | Load successful | Errors | Warnings | Duration |",
      "|---|---:|---:|---:|---:|",
      `| ${result.loadStatus ?? result.status} | ` +
        `${result.loadSuccessful ? "yes" : "no"} | ` +
        `${result.errorCount} | ${result.warningCount} | ${durationSeconds}s |`,
      "",
      `Provider import: \`${result.providerImportStatus ?? "unknown"}\`; ` +
        `terminal state: \`${result.providerTerminalState ?? "none"}\`.`,
      "",
    ].join("\n"),
  );
}

export function environmentResultFields(evidence, judgment) {
  const fields = {
    ruleVersion: evidence.ruleVersion,
    collectorVersion: evidence.collectorVersion,
  };
  if (!evidence.environmentEvidence.required) return fields;
  return {
    ...fields,
    environmentRequired: true,
    environmentState: evidence.environmentEvidence.state,
    environmentEligible: evidence.environmentEvidence.eligible,
    evaluationEligible: judgment.verdict !== "NOT_EVALUATED",
    eligibility: judgment.eligibility ?? "eligible",
    environmentEvidence: evidence.environmentEvidence,
    comparisonMode: "prebuilt-workspace",
  };
}

export function writeOuterRunnerFailure(outputDirectory, caught, context = activeEnvironmentRun) {
  const existingResultPath = path.join(outputDirectory, "result.json");
  let existingResult = null;
  let existingResultError = null;
  if (fs.existsSync(existingResultPath)) {
    try {
      existingResult = JSON.parse(
        fs.readFileSync(existingResultPath, "utf8"),
      );
    } catch (error) {
      existingResultError =
        error instanceof Error ? error.stack : String(error);
    }
    if (existingResult?.verdict === "NOT_EVALUATED" && existingResult.environmentEligible === false) {
      return existingResult;
    }
  }
  const project =
    argument("--project", process.env.T1_PROJECT) ??
    existingResult?.project ??
    null;
  const provider =
    argument("--provider", process.env.T1_PROVIDER) ??
    existingResult?.product ??
    existingResult?.provider ??
    null;
  const harnessCommit =
    readHarnessCommit() ?? existingResult?.harnessCommit ?? null;
  const harnessError = [
    caught instanceof Error ? caught.stack : String(caught),
    existingResultError
      ? `Unable to read existing result.json:\n${existingResultError}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const operatingSystem =
    process.env.T1_OPERATING_SYSTEM ??
    existingResult?.operatingSystem ??
    process.platform;
  const adapterVersion =
    providerEvidenceVersions[provider] ??
    existingResult?.adapterVersion ??
    "unknown";
  const failedAt = new Date();
  const environmentRequired = context?.environmentRequired ??
    process.env.T1_REQUIRE_ENVIRONMENT_READY === "1";
  const providerLoad = existingResult?.providerLoad ?? context?.providerLoad ?? activeProviderLoad ?? {
    loaded: existingResult?.providerLoaded === true,
    importCompleted: existingResult?.providerImportCompleted === true,
    importStatus: existingResult?.providerImportStatus ?? "not-loaded",
    terminalState: existingResult?.providerTerminalState ?? null,
    log: {},
    ui: null,
  };
  const normalizedEvidence = createNormalizedEvidence({
    project,
    provider,
    operatingSystem,
    environmentRequired,
    environment: context?.environment ?? existingResult?.environmentEvidence,
    effectiveTimeoutSeconds: 0,
    providerLoad,
    sourceResult: existingResult ?? {
      status: "failure",
      sourceAttempts: 0,
      documentSymbolReady: false,
      hoverReady: false,
      failureCategory: "runner-error",
      error: harnessError,
    },
    sourceReady: existingResult?.sourceReady === true,
    diagnostics: {
      scope: existingResult?.diagnosticScope ?? "unknown",
      stable: existingResult?.diagnosticsStable === true,
      diagnosticsCaptured: existingResult?.diagnosticsCaptured === true,
      counts: {
        error: existingResult?.errorCount ?? 0,
        warning: existingResult?.warningCount ?? 0,
        information: 0,
        hint: 0,
      },
    },
    harnessError,
    harnessCommit,
    adapterVersion,
  });
  const classification = evaluateT1(normalizedEvidence);
  const result = {
    ...existingResult,
    schemaVersion: 2,
    ...environmentResultFields(normalizedEvidence, classification),
    harnessCommit,
    adapterVersion,
    project,
    product: provider,
    verdict: classification.verdict,
    status: classification.status,
    operatingSystem,
    sourceReady: existingResult?.sourceReady === true,
    providerLoad,
    providerLoaded: providerLoad.loaded,
    providerImportCompleted: providerLoad.importCompleted,
    providerImportStatus: providerLoad.importStatus,
    providerTerminalState: providerLoad.terminalState,
    providerState: normalizedEvidence.providerEvidence.state,
    projectHealth: normalizedEvidence.projectEvidence.health,
    semanticState: normalizedEvidence.semanticEvidence.state,
    diagnosticState: normalizedEvidence.diagnosticEvidence.state,
    reasonCodes: classification.reasonCodes,
    loadSuccessful: classification.loadSuccessful,
    loadStatus: classification.loadStatus,
    failureCategory: classification.failureCategory,
    failedPhase: classification.failedPhase,
    errorCount: environmentRequired && existingResult?.diagnosticsCaptured !== true
      ? null : existingResult?.errorCount ?? 0,
    warningCount: environmentRequired && existingResult?.diagnosticsCaptured !== true
      ? null : existingResult?.warningCount ?? 0,
    diagnosticsCaptured: existingResult?.diagnosticsCaptured === true,
    completedAt: failedAt.toISOString(),
    totalDurationMs: failedAt.getTime() - scriptStartedAt,
    error: harnessError,
  };
  writeJson(
    path.join(outputDirectory, "normalized-evidence.json"),
    normalizedEvidence,
  );
  writeJson(path.join(outputDirectory, "result.json"), result);
  if (environmentRequired) {
    writeJson(path.join(outputDirectory, "rule-evidence.json"), {
      ...environmentResultFields(normalizedEvidence, classification),
      result: classification.verdict,
      failureCategory: classification.failureCategory,
      reasonCodes: classification.reasonCodes,
      harnessCommit,
      error: harnessError,
    });
  }
  return result;
}

function getTestProfilePaths(vscodeExecutablePath) {
  const [, ...baseArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const valueFor = (prefix) =>
    baseArgs.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  return {
    userDataDirectory: valueFor("--user-data-dir="),
    extensionsDirectory: valueFor("--extensions-dir="),
  };
}

function extensionInventoryFromCli(vscodeExecutablePath) {
  const [cli, ...baseArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  return run(
    cli,
    [...baseArgs, "--list-extensions", "--show-versions"],
    { capture: true },
  ).trim().split(/\r?\n/).filter(Boolean);
}

function uninstallExtensions(
  vscodeExecutablePath,
  extensionIds,
  outputDirectory,
  logName,
) {
  const [cli, ...baseArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const removed = [];
  const log = [];
  for (const extensionId of extensionIds) {
    const inventory = extensionInventoryFromCli(vscodeExecutablePath);
    const installedById = new Map(
      inventory.map((entry) => [entry.split("@")[0].toLowerCase(), entry]),
    );
    const installed = installedById.get(extensionId.toLowerCase());
    if (!installed) {
      continue;
    }
    log.push(run(
      cli,
      [...baseArgs, "--uninstall-extension", extensionId],
      { capture: true },
    ));
    removed.push(installed);
  }
  fs.writeFileSync(
    path.join(outputDirectory, logName),
    log.join(""),
  );
  return removed;
}

function uninstallConflictingProviderExtensions(
  vscodeExecutablePath,
  provider,
  outputDirectory,
) {
  const jdtlsExtensions = [
    "vscjava.vscode-java-pack",
    "vscjava.vscode-java-test",
    "vscjava.vscode-java-debug",
    "vscjava.vscode-java-dependency",
    "vscjava.vscode-maven",
    "vscjava.vscode-gradle",
    "redhat.java",
  ];
  const extensionIds = provider === "jdtls"
    ? ["JetBrains.intellij-server", "Oracle.oracle-java"]
    : provider === "intellij"
      ? [...jdtlsExtensions, "Oracle.oracle-java"]
      : [...jdtlsExtensions, "JetBrains.intellij-server"];
  return uninstallExtensions(
    vscodeExecutablePath,
    extensionIds,
    outputDirectory,
    "extension-isolation.log",
  );
}

function installProvider(
  vscodeExecutablePath,
  extensionId,
  extensionSources,
  refreshExtensionIds,
  expectedExtensions,
  outputDirectory,
) {
  const [cli, ...baseArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const startedAt = Date.now();
  const replaced = uninstallExtensions(
    vscodeExecutablePath,
    refreshExtensionIds,
    outputDirectory,
    "extension-reinstall.log",
  );
  const installOutput = extensionSources.map((extensionSource) =>
    run(
      cli,
      [...baseArgs, "--install-extension", extensionSource, "--force"],
      { capture: true },
    )
  ).join("");
  fs.writeFileSync(
    path.join(outputDirectory, "extension-install.log"),
    installOutput,
  );
  const inventoryOutput = run(
    cli,
    [...baseArgs, "--list-extensions", "--show-versions"],
    { capture: true },
  );
  const inventory = inventoryOutput.trim().split(/\r?\n/).filter(Boolean);
  if (!inventory.some((entry) =>
    entry.toLowerCase().startsWith(`${extensionId.toLowerCase()}@`))) {
    throw new Error(`Installed extension inventory does not contain ${extensionId}.`);
  }
  for (const expectedExtension of expectedExtensions) {
    if (!inventory.some((entry) =>
      entry.toLowerCase() === expectedExtension.toLowerCase())) {
      throw new Error(
        `Installed extension inventory does not contain ${expectedExtension}.`,
      );
    }
  }
  return {
    inventory,
    replaced,
    durationMs: Date.now() - startedAt,
  };
}

function isMissingPathError(error) {
  return error && ["ENOENT", "ENOTDIR"].includes(error.code);
}

export function statIfPresent(filePath, fileSystem = fs) {
  try {
    return fileSystem.statSync(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function readDirectoryIfPresent(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

function listFiles(rootPath) {
  const files = [];
  if (!rootPath || !fs.existsSync(rootPath)) {
    return files;
  }
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readDirectoryIfPresent(current)) {
      const fullPath = path.join(current, entry.name);
      if (fullPath.includes(`${path.sep}agent-host${path.sep}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const stats = statIfPresent(fullPath);
        if (!stats?.isFile()) {
          continue;
        }
        files.push({
          path: fullPath,
          bytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }
  }
  return files;
}

function copyEvidenceFile(source, target, copied, skipped) {
  const stats = statIfPresent(source);
  if (!stats?.isFile()) {
    return;
  }
  const bytes = stats.size;
  if (bytes > 10 * 1024 * 1024) {
    skipped.push({ source, reason: "file-size-limit", bytes });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied.push({ path: target, bytes });
}

function collectProfileEvidence(
  profile,
  outputDirectory,
  provenance = {},
) {
  const copied = [];
  const skipped = [];
  const userDataFiles = listFiles(profile.userDataDirectory);
  for (const file of userDataFiles) {
    const relative = path.relative(profile.userDataDirectory, file.path);
    const normalized = relative.replaceAll("\\", "/");
    const extension = path.extname(file.path).toLowerCase();
    const inLogs =
      normalized.startsWith("logs/") &&
      [".log", ".txt", ".json"].includes(extension);
    const inProviderWorkspace =
      /^User\/workspaceStorage\/[^/]+\/(?:redhat\.java|JetBrains\.intellij-server|Oracle\.oracle-java)\//i
        .test(normalized) &&
      (path.basename(file.path) === ".log" ||
        [".log", ".txt", ".json"].includes(extension));
    if (inLogs || inProviderWorkspace) {
      copyEvidenceFile(
        file.path,
        path.join(outputDirectory, "profile-evidence", "user-data", relative),
        copied,
        skipped,
      );
    }
  }

  const extensionFiles = listFiles(profile.extensionsDirectory);
  for (const file of extensionFiles) {
    if (!["package.json", "server-bundle.json"].includes(path.basename(file.path))) {
      continue;
    }
    const relative = path.relative(profile.extensionsDirectory, file.path);
    copyEvidenceFile(
      file.path,
      path.join(outputDirectory, "profile-evidence", "extensions", relative),
      copied,
      skipped,
    );
  }

  writeJson(path.join(outputDirectory, "filesystem-evidence.json"), {
    generatedAt: new Date().toISOString(),
    serverBundles: extensionFiles.filter(
      (file) => path.basename(file.path) === "server-bundle.json",
    ),
    filesOver10Mb: [...extensionFiles, ...userDataFiles]
      .filter((file) => file.bytes > 10 * 1024 * 1024)
      .sort((left, right) => right.bytes - left.bytes),
  });
  writeJson(path.join(outputDirectory, "evidence-manifest.json"), {
    schemaVersion: 2,
    ...provenance,
    generatedAt: new Date().toISOString(),
    copied,
    skipped,
  });
}

function extensionInventory(extensionsDirectory) {
  const inventory = [];
  if (!extensionsDirectory || !fs.existsSync(extensionsDirectory)) {
    return inventory;
  }
  for (const entry of fs.readdirSync(extensionsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsDirectory, entry.name, "package.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      inventory.push(`${manifest.publisher}.${manifest.name}@${manifest.version}`);
    } catch {
      // Evidence collection reports malformed manifests separately through logs.
    }
  }
  return inventory.sort();
}

async function main() {
  const projectId = argument("--project", process.env.T1_PROJECT);
  const provider = argument("--provider", process.env.T1_PROVIDER);
  if (!projectId || !provider) {
    throw new Error("--project and --provider are required.");
  }
  if (!providerExtensions[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  let project = loadProjects().find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const harnessCommit = readHarnessCommit({ required: true });
  const outputDirectory = path.resolve(
    process.env.T1_OUTPUT_DIR ??
    path.join(scriptDir, "results", project.id, provider, process.platform),
  );
  activeOutputDirectory = outputDirectory;
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });

  const environmentRequired = process.env.T1_REQUIRE_ENVIRONMENT_READY === "1";
  const operatingSystem = process.env.T1_OPERATING_SYSTEM ?? process.platform;
  const vscodeVersion = process.env.T1_VSCODE_VERSION ?? (environmentRequired ? "1.136.1" : "stable");
  const runVersions = {
    ruleVersion: environmentRequired ? T1_ENVIRONMENT_RULE_VERSION : T1_RULE_VERSION,
    collectorVersion: environmentRequired ? T1_ENVIRONMENT_COLLECTOR_VERSION : T1_COLLECTOR_VERSION,
  };
  const environmentProof = environmentRequired ? loadProviderEnvironment({
    project,
    operatingSystem,
    harnessCommit,
    directory: process.env.T1_ENVIRONMENT_DIRECTORY,
  }) : null;
  activeEnvironmentRun = { environmentRequired, environment: environmentProof?.environment };
  if (environmentRequired) {
    copyEnvironmentEvidence(process.env.T1_ENVIRONMENT_DIRECTORY, outputDirectory);
    writeJson(path.join(outputDirectory, "environment-run-evidence.json"), environmentProof.environment);
    writeJson(path.join(outputDirectory, "run-metadata.json"), {
      schemaVersion: 2, ...runVersions, harnessCommit, project: project.id,
      repository: project.repository, commit: project.commit, provider, operatingSystem,
      vscodeVersion, environmentRequired, environmentState: environmentProof.environment.state,
      environmentEvidence: environmentProof.environment,
      comparisonMode: "prebuilt-workspace", ideStarted: false,
    });
    if (!environmentProof.qualified) {
      const result = createEnvironmentBlockedResult({
        project, provider, operatingSystem, harnessCommit,
        environment: environmentProof.environment,
      });
      writeJson(path.join(outputDirectory, "normalized-evidence.json"), result.normalizedEvidence);
      writeJson(path.join(outputDirectory, "result.json"), result);
      writeJson(path.join(outputDirectory, "rule-evidence.json"), {
        ...environmentResultFields(result.normalizedEvidence, result),
        result: result.verdict, reasonCodes: result.reasonCodes,
        failureCategory: result.failureCategory, harnessCommit,
      });
      appendGithubSummary(result);
      console.log(`${project.id}/${provider}: ${result.environmentState} (NOT_EVALUATED; IDE not started)`);
      return;
    }
    project = environmentProof.project;
    activateBuildJava();
    process.env.IMPORT_DEPENDENCY_CACHE_MODE = "prebuilt-isolated";
  }

  if (!project.t1Eligible) {
    writeJson(path.join(outputDirectory, "result.json"), {
      project: project.id,
      provider,
      status: "not-applicable",
      reason: project.reason,
    });
    return;
  }

  const checkoutPath = environmentProof?.checkout ?? path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `java-provider-t1-${project.id}-${provider}-checkout`,
  );
  const syntheticWorkspacePath = path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `java-provider-t1-${project.id}-${provider}-workspace`,
  );
  const materializedWorkspacePath = path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `java-provider-t1-${project.id}-${provider}-materialized`,
  );
  if (!environmentRequired && project.projectSetup && process.env.T1_PROJECT_JAVA_HOME) {
    process.env.JAVA_HOME = process.env.T1_PROJECT_JAVA_HOME;
  }
  const windowsJavaToolCopies = environmentRequired ? { reusedQualifiedPreparation: true } : applyWindowsJavaToolCopies(
    process.env.JAVA_HOME,
    project.projectSetup?.windowsJavaToolCopies,
  );
  writeJson(
    path.join(outputDirectory, "windows-java-tool-copies.json"),
    windowsJavaToolCopies,
  );
  const gradleToolchainEnvironment = configureGradleToolchainEnvironment(
    project,
    process.env,
  );
  const checkoutSetup = environmentRequired
    ? { reusedQualifiedPreparation: true, checkout: checkoutPath }
    : cloneProject(project, checkoutPath);
  if (!environmentRequired) {
    writeGradleToolchainProperties(checkoutPath, gradleToolchainEnvironment);
    writeJson(path.join(outputDirectory, "checkout-setup.json"), checkoutSetup);
  }
  const preparedRepositoryPath = environmentRequired ? checkoutPath : project.syntheticMavenTargetFile
    ? syntheticWorkspacePath
    : checkoutSetup.requiresMaterializedWorkspace ||
        gradleToolchainEnvironment
      ? materializeWorkspace(checkoutPath, materializedWorkspacePath)
    : checkoutPath;
  if (project.syntheticMavenTargetFile) {
    createSyntheticMavenWorkspace(project, checkoutPath, preparedRepositoryPath);
  } else {
    const expectedFile = path.join(checkoutPath, ...project.relativeFile.split("/"));
    if (!fs.existsSync(expectedFile)) {
      throw new Error(`Pinned T1 source file does not exist: ${expectedFile}`);
    }
  }
  const { workspacePath, runtimeRelativeFile } = resolvePreparedWorkspace(
    project,
    preparedRepositoryPath,
  );
  const projectEnvironment = discoverProjectEnvironment(
    project,
    checkoutPath,
    provider,
    workspacePath,
  );
  const providerSetup = project.projectSetup
    ? getProviderSetup(project, provider)
    : null;
  writeJson(
    path.join(outputDirectory, "project-environment.json"),
    projectEnvironment,
  );
  const hostEnvironmentPath = process.env.T1_PROJECT_ENVIRONMENT_RESULT;
  if (hostEnvironmentPath && fs.existsSync(hostEnvironmentPath)) {
    fs.copyFileSync(
      hostEnvironmentPath,
      path.join(outputDirectory, "host-environment.json"),
    );
  }

  writeJson(
    path.join(outputDirectory, "gradle-toolchain-environment.json"),
    gradleToolchainEnvironment,
  );

  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  const profile = getTestProfilePaths(vscodeExecutablePath);
  const removedConflictingExtensions = uninstallConflictingProviderExtensions(
    vscodeExecutablePath,
    provider,
    outputDirectory,
  );
  let extensionSources;
  let expectedExtensions = [];
  if (provider === "jdtls") {
    const redhatJavaVsix = path.join(
      process.env.RUNNER_TEMP ?? os.tmpdir(),
      `${redhatJavaExtension.inventory}.vsix`,
    );
    await downloadFile(redhatJavaExtension.url, redhatJavaVsix);
    extensionSources = [
      ...providerExtensionSources.jdtls,
      redhatJavaVsix,
    ];
    expectedExtensions = [
      providerExtensionSources.jdtls[0],
      redhatJavaExtension.inventory,
    ];
  } else if (provider === "intellij") {
    extensionSources = process.env.T1_INTELLIJ_VSIX
      ? [path.resolve(process.env.T1_INTELLIJ_VSIX)]
      : providerExtensionSources.intellij;
  } else {
    extensionSources = process.env.T1_ORACLE_VSIX
      ? [path.resolve(process.env.T1_ORACLE_VSIX)]
      : providerExtensionSources.oracle;
  }
  if (
    provider === "intellij" &&
    process.env.T1_INTELLIJ_VSIX &&
    !fs.existsSync(extensionSources[0])
  ) {
    throw new Error(`IntelliJ VSIX does not exist: ${extensionSources[0]}`);
  }
  if (
    provider === "oracle" &&
    process.env.T1_ORACLE_VSIX &&
    !fs.existsSync(extensionSources[0])
  ) {
    throw new Error(`Oracle Java VSIX does not exist: ${extensionSources[0]}`);
  }
  const install = installProvider(
    vscodeExecutablePath,
    providerExtensions[provider],
    extensionSources,
    providerRefreshExtensions[provider],
    expectedExtensions,
    outputDirectory,
  );
  const resultPath = path.join(outputDirectory, "result.json");
  const sourceResultPath = path.join(
    outputDirectory,
    "source-readiness-result.json",
  );
  const effectiveTimeoutSeconds = Math.max(
    project.timeoutSeconds,
    minimumTimeoutSeconds,
  );
  const processStartedAt = new Date();
  process.env.IMPORT_RESULT = sourceResultPath;
  process.env.IMPORT_CASE_JSON = JSON.stringify({
    id: project.id,
    relativeFile: runtimeRelativeFile,
    sourceSymbol: project.sourceSymbol,
  });
  process.env.IMPORT_PRODUCT = provider;
  process.env.IMPORT_TIMEOUT_MS = String(effectiveTimeoutSeconds * 1_000);
  process.env.IMPORT_TARGET_PHASE = "source-ready";
  process.env.IMPORT_PROCESS_STARTED_AT = processStartedAt.toISOString();
  process.env.IMPORT_EXTENSION_INVENTORY = JSON.stringify(install.inventory);
  process.env.IMPORT_RUN_ID = `${project.id}-${provider}-${Date.now()}`;

  const vscodeSettings = {
    "telemetry.telemetryLevel": "off",
    "redhat.telemetry.enabled": false,
    "java.configuration.updateBuildConfiguration": "automatic",
    ...createProjectSettings(
      project,
      provider,
      projectEnvironment,
      process.env,
      workspacePath,
    ),
  };
  writeJson(
    path.join(outputDirectory, "vscode-settings.json"),
    vscodeSettings,
  );
  const preparedWorkspaceSnapshot = snapshotPreparedWorkspace(
    project,
    preparedRepositoryPath,
    { workspacePath, runtimeRelativeFile },
    environmentProof?.lock?.preparedInputs.map((input) => input.path) ?? [],
  );
  writeJson(
    path.join(outputDirectory, "prepared-workspace-evidence.json"),
    preparedWorkspaceSnapshot,
  );
  const driver = new PreparedWorkspaceDriver({
    vscodeVersion,
    extensionPath: importExtensionPath,
    workspacePath,
    workspaceTrust: "disabled",
    settings: vscodeSettings,
  });

  let onboarding = null;
  let error = null;
  let finalResult = null;
  const recordProviderLoad = (observation) => {
    activeProviderLoad = observation;
    writeJson(path.join(outputDirectory, "provider-observation.json"), observation);
    return observation;
  };
  try {
    await driver.launch();
    if (environmentRequired) {
      const metadataPath = path.join(outputDirectory, "run-metadata.json");
      writeJson(metadataPath, {
        ...JSON.parse(fs.readFileSync(metadataPath, "utf8")),
        ideStarted: true, workspacePath, preparedRepositoryPath, runtimeRelativeFile,
      });
    }
    verifyActualWorkspace(driver, preparedWorkspaceSnapshot, outputDirectory);
    await saveScreenshot(driver, outputDirectory, "01-workbench-ready");
    if (provider === "intellij") {
      onboarding = await completeIntellijOnboarding(driver, outputDirectory);
    }
    const deadline =
      Date.parse(processStartedAt.toISOString()) +
      effectiveTimeoutSeconds * 1_000 +
      120_000;
    const providerLog = await waitForProviderLogMilestone(
      driver,
      profile,
      provider,
      Math.max(0, deadline - Date.now()),
      outputDirectory,
    );
    recordProviderLoad(buildProviderLoadResult(providerLog, null));
    const observedProviderLoad = recordProviderLoad(await waitForProviderIdleAfterLog(
      driver,
      provider,
      profile,
      deadline,
      outputDirectory,
      providerLog,
    ));
    let sourceResult = await collectSourceResultIfReady(
      driver, sourceResultPath, deadline, outputDirectory,
      observedProviderLoad, project, provider,
    );
    const diagnosticFiles = [...new Set([
      runtimeRelativeFile,
      ...(project.diagnosticProbeFiles ?? []).map((file) =>
        rebaseRepositoryFile(preparedRepositoryPath, workspacePath, file),
      ),
    ])];
    let diagnostics = await captureStableDiagnostics(
      driver,
      diagnosticFiles,
      outputDirectory,
    );
    let providerLoad = recordProviderLoad(await observeFinalProviderLoad(
      driver, provider, profile, deadline, outputDirectory, observedProviderLoad.log,
    ));
    if (
      Number(sourceResult.sourceAttempts ?? 0) === 0 &&
      providerLoad.importStatus === "ready"
    ) {
      sourceResult = await collectSourceResultIfReady(
        driver, sourceResultPath, deadline, outputDirectory,
        providerLoad, project, provider,
      );
      if (Number(sourceResult.sourceAttempts ?? 0) > 0) {
        diagnostics = await captureStableDiagnostics(
          driver, diagnosticFiles, outputDirectory,
        );
        providerLoad = recordProviderLoad(await observeFinalProviderLoad(
          driver, provider, profile, deadline, outputDirectory, providerLoad.log,
        ));
      }
    }
    const sourceReady =
      sourceResult.status === "source-ready" &&
      Boolean(sourceResult.sourceReadyAt) &&
      sourceResult.documentSymbolReady === true &&
      sourceResult.hoverReady === true &&
      !sourceResult.error;
    const errorCount = environmentRequired && !diagnostics.diagnosticsCaptured
      ? null : Number(diagnostics.counts?.error ?? 0);
    const warningCount = environmentRequired && !diagnostics.diagnosticsCaptured
      ? null : Number(diagnostics.counts?.warning ?? 0);
    const normalizedEvidence = createNormalizedEvidence({
      project: project.id,
      provider,
      ...activeEnvironmentRun,
      operatingSystem:
        process.env.T1_OPERATING_SYSTEM ?? process.platform,
      effectiveTimeoutSeconds,
      providerLoad,
      sourceResult,
      sourceReady,
      diagnostics,
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
    });
    const classification = evaluateT1(normalizedEvidence);
    const successful = classification.successful;
    const completedAt = new Date();
    finalResult = {
      ...sourceResult,
      schemaVersion: 2,
      ...environmentResultFields(normalizedEvidence, classification),
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
      operatingSystem: process.env.T1_OPERATING_SYSTEM ?? process.platform,
      effectiveTimeoutSeconds,
      verdict: classification.verdict,
      status: classification.status,
      sourceReady,
      providerLoaded: providerLoad.loaded,
      providerImportCompleted: providerLoad.importCompleted,
      providerImportStatus: providerLoad.importStatus,
      providerTerminalState: providerLoad.terminalState,
      providerState: normalizedEvidence.providerEvidence.state,
      projectHealth: normalizedEvidence.projectEvidence.health,
      semanticState: normalizedEvidence.semanticEvidence.state,
      diagnosticState: normalizedEvidence.diagnosticEvidence.state,
      reasonCodes: classification.reasonCodes,
      loadSuccessful: successful,
      loadStatus: classification.loadStatus,
      failureCategory: classification.failureCategory,
      failedPhase: classification.failedPhase,
      errorCount,
      warningCount,
      diagnosticScope: diagnostics.scope ?? "workspace",
      diagnosticsCaptured: diagnostics.diagnosticsCaptured,
      diagnosticsStable: diagnostics.stable,
      diagnosticFiles,
      diagnosticSummary: {
        scope: diagnostics.scope ?? "workspace",
        stable: diagnostics.stable,
        counts: diagnostics.counts,
        durationMs: diagnostics.durationMs ?? null,
        files: Array.isArray(diagnostics.files)
          ? diagnostics.files.map((file) => ({
              relativePath: file.relativePath,
              stable: file.stable,
              durationMs: file.durationMs,
              errorCount: file.diagnostics.filter(
                (item) => item.severity === "error",
              ).length,
              warningCount: file.diagnostics.filter(
                (item) => item.severity === "warning",
              ).length,
              error: file.error ?? null,
            }))
          : [],
        error: diagnostics.error ?? null,
      },
      providerLoad,
      completedAt: completedAt.toISOString(),
      totalDurationMs: completedAt.getTime() - processStartedAt.getTime(),
      error: successful
        ? null
        : diagnostics.error ||
          (classification.failedPhase === "source-index"
            ? sourceResult.error
            : null) ||
          `Load result failed: ${classification.failureCategory}`,
    };
    const ruleEvidence = {
      schemaVersion: 2,
      ...environmentResultFields(normalizedEvidence, classification),
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
      provider,
      effectiveTimeoutSeconds,
      fatalLogMatches: providerLoad.log?.fatalLogMatches ?? [],
      fatalBuildOutputMatches:
        providerLoad.log?.fatalBuildOutputMatches ?? [],
      fatalStatusMatches: providerLoad.log?.fatalStatusMatches ?? [],
      fatalEvidenceMatches:
        providerLoad.log?.fatalEvidenceMatches ?? [],
      buildOutputPaths: providerLoad.log?.buildOutputPaths ?? [],
      nativeCompletionMatches:
        providerLoad.log?.nativeCompletionMatches ?? [],
      nativeCompletion: providerLoad.log?.nativeCompleted === true,
      functionalCompletion:
        providerLoad.log?.nativeCompleted !== true &&
        providerLoad.log?.completionEvidence ===
        "functional-fallback-candidate",
      uiStable: providerLoad.ui?.settled === true,
      uiTerminalState: providerLoad.terminalState ?? null,
      finalStatusBarText:
        providerLoad.ui?.finalStatusBarText ??
        providerLoad.log?.statusBarText ??
        "",
      statusProblemCounts:
        providerLoad.log?.statusProblemCounts ?? null,
      documentSymbolReady: sourceResult.documentSymbolReady === true,
      hoverReady: sourceResult.hoverReady === true,
      diagnosticScope: diagnostics.scope ?? "workspace",
      diagnosticsCaptured: diagnostics.diagnosticsCaptured,
      diagnosticsStable: diagnostics.stable,
      errorCount,
      warningCount,
      result: classification.verdict,
      failureCategory: classification.failureCategory,
      failedPhase: classification.failedPhase,
      reasonCodes: classification.reasonCodes,
      measuredAt: completedAt.toISOString(),
    };
    writeJson(
      path.join(outputDirectory, "normalized-evidence.json"),
      normalizedEvidence,
    );
    writeJson(resultPath, finalResult);
    writeJson(path.join(outputDirectory, "rule-evidence.json"), ruleEvidence);
    await saveScreenshot(driver, outputDirectory, "07-load-result");
    writeJson(path.join(outputDirectory, "comparison-metrics.json"), {
      provider,
      status: finalResult.status,
      providerLoaded: finalResult.providerLoaded,
      providerImportStatus: finalResult.providerImportStatus,
      providerTerminalState: finalResult.providerTerminalState,
      providerState: finalResult.providerState,
      projectHealth: finalResult.projectHealth,
      semanticState: finalResult.semanticState,
      diagnosticState: finalResult.diagnosticState,
      verdict: finalResult.verdict,
      reasonCodes: finalResult.reasonCodes,
      ruleVersion: finalResult.ruleVersion,
      ...(environmentRequired ? {
        environmentState: finalResult.environmentState,
        evaluationEligible: finalResult.evaluationEligible,
        eligibility: finalResult.eligibility,
        comparisonMode: finalResult.comparisonMode,
      } : {}),
      loadStatus: finalResult.loadStatus,
      errorCount,
      warningCount,
      totalDurationMs: finalResult.totalDurationMs,
      sourceReadyMs: finalResult.sourceReadyMs,
      processToSourceReadyMs: finalResult.processToSourceReadyMs,
      sourceAttempts: finalResult.sourceAttempts,
      onboardingDurationMs: onboarding?.durationMs ?? 0,
      measuredAt: finalResult.completedAt,
    });
    if (!successful) {
      error = new Error(finalResult.error);
    }
  } catch (caught) {
    error = caught;
    await saveScreenshot(driver, outputDirectory, "99-error").catch(() => {});
    writeJson(path.join(outputDirectory, "runner-error.json"), {
      status: "runner-error",
      error: caught instanceof Error ? caught.stack : String(caught),
      failedAt: new Date().toISOString(),
    });
    const existingResult = fs.existsSync(resultPath)
      ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
      : fs.existsSync(sourceResultPath)
        ? JSON.parse(fs.readFileSync(sourceResultPath, "utf8"))
        : {
            schemaVersion: 1,
            project: project.id,
            product: provider,
          };
    const completedAt = new Date();
    const harnessError =
      caught instanceof Error ? caught.stack : String(caught);
    const providerLoad = activeProviderLoad ?? existingResult.providerLoad ?? {
      loaded: existingResult.providerLoaded === true,
      importCompleted: existingResult.providerImportCompleted === true,
      importStatus: existingResult.providerImportStatus ?? "not-loaded",
      terminalState: existingResult.providerTerminalState ?? null,
      log: {},
      ui: null,
    };
    const normalizedEvidence = createNormalizedEvidence({
      project: project.id,
      provider,
      ...activeEnvironmentRun,
      operatingSystem:
        process.env.T1_OPERATING_SYSTEM ?? process.platform,
      effectiveTimeoutSeconds,
      providerLoad,
      sourceResult: existingResult,
      sourceReady: Boolean(existingResult.sourceReadyAt),
      diagnostics: {
        scope: existingResult.diagnosticScope ?? "unknown",
        stable: existingResult.diagnosticsStable === true,
        diagnosticsCaptured:
          existingResult.diagnosticsCaptured === true,
        counts: {
          error: existingResult.errorCount ?? 0,
          warning: existingResult.warningCount ?? 0,
        },
      },
      harnessError,
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
    });
    const classification = evaluateT1(normalizedEvidence);
    finalResult = {
      ...existingResult,
      schemaVersion: 2,
      ...environmentResultFields(normalizedEvidence, classification),
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
      verdict: classification.verdict,
      status: classification.status,
      operatingSystem: process.env.T1_OPERATING_SYSTEM ?? process.platform,
      sourceReady: Boolean(existingResult.sourceReadyAt),
      providerLoad,
      providerLoaded: providerLoad.loaded,
      providerImportCompleted: providerLoad.importCompleted,
      providerImportStatus: providerLoad.importStatus,
      providerTerminalState: providerLoad.terminalState,
      providerState: normalizedEvidence.providerEvidence.state,
      projectHealth: normalizedEvidence.projectEvidence.health,
      semanticState: normalizedEvidence.semanticEvidence.state,
      diagnosticState: normalizedEvidence.diagnosticEvidence.state,
      reasonCodes: classification.reasonCodes,
      loadSuccessful: classification.loadSuccessful,
      loadStatus: classification.loadStatus,
      failureCategory: classification.failureCategory,
      failedPhase: classification.failedPhase,
      errorCount: environmentRequired && !existingResult.diagnosticsCaptured
        ? null : existingResult.errorCount ?? 0,
      warningCount: environmentRequired && !existingResult.diagnosticsCaptured
        ? null : existingResult.warningCount ?? 0,
      diagnosticsCaptured: Boolean(existingResult.diagnosticsCaptured),
      completedAt: completedAt.toISOString(),
      totalDurationMs: completedAt.getTime() - processStartedAt.getTime(),
      error: harnessError,
    };
    writeJson(
      path.join(outputDirectory, "normalized-evidence.json"),
      normalizedEvidence,
    );
    writeJson(resultPath, finalResult);
    writeJson(path.join(outputDirectory, "rule-evidence.json"), {
      ...environmentResultFields(normalizedEvidence, classification),
      result: classification.verdict,
      reasonCodes: classification.reasonCodes,
      failureCategory: classification.failureCategory,
      harnessCommit,
      error: harnessError,
    });
  } finally {
    let closeError = null;
    try {
      await driver.close();
    } catch (caught) {
      closeError = caught;
    }
    collectProfileEvidence(profile, outputDirectory, {
      ...runVersions,
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
    });
    writeJson(path.join(outputDirectory, "run-metadata.json"), {
      schemaVersion: 2,
      ...runVersions,
      ...(environmentRequired ? {
        environmentRequired,
        environmentState: environmentProof.environment.state,
        environmentEvidence: environmentProof.environment,
        evaluationEligible: finalResult?.evaluationEligible ?? false,
        comparisonMode: "prebuilt-workspace",
        dependencyCacheMode: "prebuilt-isolated",
      } : {}),
      vscodeVersion,
      harnessCommit,
      adapterVersion: providerEvidenceVersions[provider],
      project: project.id,
      repository: project.repository,
      commit: project.commit,
      relativeFile: project.relativeFile,
      runtimeRelativeFile,
      preparedRepositoryPath,
      workspacePath,
      actualWorkspacePath: driver.getWorkspaceRoot(),
      sourceSymbol: project.sourceSymbol,
      provider,
      providerExtension: providerExtensions[provider],
      providerExtensionSource: extensionSources[0],
      providerExtensionSources: extensionSources,
      removedConflictingExtensions,
      reinstalledProviderExtensions: install.replaced,
      extensionInventory: extensionInventory(profile.extensionsDirectory),
      providerInstallDurationMs: install.durationMs,
      javaVersion: project.javaVersion,
      projectJavaVersion:
        providerSetup?.projectJava.version ?? project.javaVersion,
      projectJavaDistribution:
        providerSetup?.projectJava.distribution ?? "temurin",
      providerRuntimeJava: providerSetup?.runtimeJava ?? null,
      projectJavaHome: process.env.T1_PROJECT_JAVA_HOME ?? null,
      buildJavaHome: process.env.T1_BUILD_JAVA_HOME ?? null,
      languageServerJavaHome:
        process.env.T1_LANGUAGE_SERVER_JAVA_HOME ?? null,
      mavenHome: process.env.T1_MAVEN_HOME ?? null,
      preferredBuildTool: project.projectSetup?.buildTool ?? null,
      projectEnvironmentStatus: projectEnvironment.status,
      os: process.platform,
      architecture: process.arch,
      syntheticMavenModel: Boolean(project.syntheticMavenTargetFile),
      processStartedAt: processStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      onboarding,
    });
    if (finalResult) {
      appendGithubSummary(finalResult);
    }
    if (closeError) throw closeError;
  }
  if (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (activeOutputDirectory) {
      if (!fs.existsSync(path.join(activeOutputDirectory, "runner-error.json"))) {
        writeJson(path.join(activeOutputDirectory, "runner-error.json"), {
          status: "runner-error",
          error: error instanceof Error ? error.stack : String(error),
          failedAt: new Date().toISOString(),
        });
      }
      const result = writeOuterRunnerFailure(activeOutputDirectory, error);
      try {
        appendGithubSummary(result);
      } catch (summaryError) {
        console.error(
          summaryError instanceof Error
            ? summaryError.stack
            : String(summaryError),
        );
      }
    }
    console.error(error);
    process.exitCode = 1;
  });
}
