import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VscodeDriver } from "@vscjava/vscode-autotest";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { loadProjects } from "./create-matrix.mjs";
import {
  createProjectSettings,
  discoverProjectEnvironment,
  getProviderSetup,
} from "./project-environment.mjs";
import {
  buildProviderLoadResult,
  classifyLoadResult,
  detectProviderTerminalState,
  reconcileProviderLoadResult,
} from "./result-classification.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const importExtensionPath = path.join(repositoryRoot, "lab", "import-extension");
const providerExtensions = {
  jdtls: "vscjava.vscode-java-pack",
  intellij: "JetBrains.intellij-server",
};
const providerExtensionSources = {
  jdtls: ["vscjava.vscode-java-pack@0.31.1"],
  intellij: ["JetBrains.intellij-server"],
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
};
const approvedIntellijOnboarding = {
  region: "middle_east",
  dataSharing: "none",
  eulaVersion: "1.0",
  eulaEffectiveDate: "July 31, 2026",
  eulaSha256: "ca5e72e6658dd12b6149ddf81411d0029d7d63aaea0c74e2282e0e386832e371",
};
let activeOutputDirectory = null;
const scriptStartedAt = Date.now();

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

function cloneRepository(repository, commit, targetPath, { submodules = false } = {}) {
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

function cloneProject(project, checkoutPath) {
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
    filter: (currentPath) => path.basename(currentPath) !== ".git",
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

function createSyntheticMavenWorkspace(project, checkoutPath, workspacePath) {
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    return provider === "jdtls"
      ? normalized.endsWith("/redhat.java/jdt_ws/.metadata/.log")
      : normalized.endsWith(
          "/JetBrains.intellij-server/system/log/intellij-server.log",
        );
  })?.path ?? null;
}

async function readStatusBarText(driver) {
  const page = driver.getPage();
  const items = page.locator("footer a, footer [role='button']");
  const values = [];
  for (let index = 0; index < await items.count(); index += 1) {
    const value = (await items.nth(index).textContent().catch(() => ""))?.trim();
    if (value) {
      values.push(value);
    }
  }
  return values.join(" | ");
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
  let lastObservation = "";
  let initializationCompleted = false;
  let bspClasspathsUpdated = false;
  let importFailureLogged = false;

  while (Date.now() - startedAt < timeoutMs) {
    let statusBarText = "";
    let javaError = false;
    if (provider === "jdtls") {
      statusBarText = await readStatusBarText(driver).catch(() => "");
      javaError = /Java:\s*Error/i.test(statusBarText);
    }
    logPath ??= findProviderLog(profile.userDataDirectory, provider);
    if (logPath && fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8");
      initializationCompleted =
        content.includes(">> initialization job finished") ||
        content.includes("Workspace initialized");
      bspClasspathsUpdated =
        /Updating classpaths for \d+ projects? \(\d+ build targets?\) using batched BSP calls\./
          .test(content);
      importFailureLogged =
        /(?:Failed to import projects?|Initialization failed)/i.test(content);
      if (provider === "intellij" && /\bBUILD FAILED\b/.test(content)) {
        const result = {
          loaded: false,
          failed: true,
          failureCategory: "provider-import-failed",
          logPath,
          durationMs: Date.now() - startedAt,
          lastObservation: "BUILD FAILED",
        };
        writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
        return result;
      }
      const initialized =
        provider === "jdtls"
          ? content.includes(">> build jobs finished")
          : content.includes("Workspace model cache saved");
      lastObservation =
        provider === "jdtls"
          ? content.includes(">> build jobs finished")
            ? "build-jobs-finished"
            : initializationCompleted
              ? "initialization-finished"
              : bspClasspathsUpdated
                ? "bsp-classpaths-updated"
              : "waiting-for-workspace"
          : content.includes("Workspace model cache saved")
            ? "workspace-model-saved"
            : content.includes("BUILD SUCCESSFUL")
              ? "gradle-import-succeeded"
              : "waiting-for-gradle-import";
      if (initialized) {
        const result = {
          loaded: true,
          failed: false,
          logPath,
          durationMs: Date.now() - startedAt,
          lastObservation,
          initializationCompleted,
          bspClasspathsUpdated,
        };
        writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
        return result;
      }
    }
    if (javaError) {
      const result = {
        loaded: false,
        failed: true,
        failureCategory: "provider-import-failed",
        logPath,
        durationMs: Date.now() - startedAt,
        lastObservation: "java-error",
        statusBarText,
        initializationCompleted,
        bspClasspathsUpdated,
        importFailureLogged,
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
    lastObservation,
    initializationCompleted,
    bspClasspathsUpdated,
    importFailureLogged,
  };
  writeJson(path.join(outputDirectory, "provider-log-readiness.json"), result);
  return result;
}

async function waitForProviderIdle(
  driver,
  provider,
  timeoutMs,
  outputDirectory,
  stableMs = 30_000,
) {
  const startedAt = Date.now();
  const busyPattern =
    provider === "jdtls"
      ? /Java:\s*(?:Activating|Importing|Building)/i
      : /(?:Indexing(?::\s*Indexing)?|Importing project)/i;
  let stableStartedAt = null;
  let stableTerminalState = null;
  let lastTerminalState = null;
  let lastText = null;
  const transitions = [];

  while (Date.now() - startedAt < timeoutMs) {
    const text = (await readStatusBarText(driver)).replace(/\s+/g, " ").trim();
    if (text !== lastText) {
      transitions.push({
        at: new Date().toISOString(),
        text: text.slice(0, 1000),
      });
      lastText = text;
    }
    const busy = busyPattern.test(text);
    const terminalState = detectProviderTerminalState(provider, text, busy);
    lastTerminalState = terminalState;
    if (terminalState) {
      if (stableTerminalState !== terminalState) {
        stableTerminalState = terminalState;
        stableStartedAt = Date.now();
      }
      if (Date.now() - stableStartedAt >= stableMs) {
        const result = {
          idle: true,
          settled: true,
          terminalState,
          durationMs: Date.now() - startedAt,
          stableMs,
          finalStatusBarText: text,
          transitions,
        };
        writeJson(path.join(outputDirectory, "provider-ui-readiness.json"), result);
        return result;
      }
    } else {
      stableStartedAt = null;
      stableTerminalState = null;
    }
    await wait(1000);
  }

  const result = {
    idle: false,
    settled: false,
    terminalState: lastTerminalState,
    durationMs: Date.now() - startedAt,
    stableMs,
    finalStatusBarText: lastText ?? "",
    transitions,
  };
  writeJson(path.join(outputDirectory, "provider-ui-readiness.json"), result);
  return result;
}

async function waitForProviderIdleAfterLog(
  driver,
  provider,
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
    Math.max(0, deadline - Date.now()),
    outputDirectory,
  );
  return buildProviderLoadResult(log, ui);
}

async function captureStableDiagnostics(
  driver,
  provider,
  relativeFiles,
  outputDirectory,
) {
  const resultPath = path.join(outputDirectory, "diagnostics-result.json");
  fs.rmSync(resultPath, { force: true });
  const stableMs = 15_000;
  const timeoutMs = 60_000;
  try {
    await driver.executeVSCodeCommand(
      "javaImportBenchmark.captureDiagnostics",
      {
        scope: provider === "jdtls" ? "workspace" : "probe-files",
        relativeFiles,
        resultPath,
        stableMs,
        timeoutMs,
      },
    );
  } catch (error) {
    return {
      stable: false,
      scope: "probe-files",
      counts: { error: 0, warning: 0, information: 0, hint: 0 },
      diagnosticsCaptured: false,
      error: error instanceof Error ? error.stack : String(error),
    };
  }

  const waitStartedAt = Date.now();
  const waitTimeoutMs = relativeFiles.length * (timeoutMs + stableMs) + 60_000;
  while (!fs.existsSync(resultPath) && Date.now() - waitStartedAt < waitTimeoutMs) {
    await wait(1000);
  }
  if (!fs.existsSync(resultPath)) {
    return {
      stable: false,
      scope: "probe-files",
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
  const extensionIds =
    provider === "jdtls"
      ? ["JetBrains.intellij-server"]
      : [
          "vscjava.vscode-java-pack",
          "vscjava.vscode-java-test",
          "vscjava.vscode-java-debug",
          "vscjava.vscode-java-dependency",
          "vscjava.vscode-maven",
          "vscjava.vscode-gradle",
          "redhat.java",
        ];
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

function collectProfileEvidence(profile, outputDirectory) {
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
      /^User\/workspaceStorage\/[^/]+\/(?:redhat\.java|JetBrains\.intellij-server)\//i
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

  const project = loadProjects().find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const outputDirectory = path.resolve(
    process.env.T1_OUTPUT_DIR ??
    path.join(scriptDir, "results", project.id, provider, process.platform),
  );
  activeOutputDirectory = outputDirectory;
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });

  if (!project.t1Eligible) {
    writeJson(path.join(outputDirectory, "result.json"), {
      project: project.id,
      provider,
      status: "not-applicable",
      reason: project.reason,
    });
    return;
  }

  const checkoutPath = path.join(
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
  if (project.projectSetup && process.env.T1_PROJECT_JAVA_HOME) {
    process.env.JAVA_HOME = process.env.T1_PROJECT_JAVA_HOME;
  }
  const windowsJavaToolCopies = applyWindowsJavaToolCopies(
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
  const checkoutSetup = cloneProject(project, checkoutPath);
  writeGradleToolchainProperties(checkoutPath, gradleToolchainEnvironment);
  writeJson(path.join(outputDirectory, "checkout-setup.json"), checkoutSetup);
  const workspacePath = project.syntheticMavenTargetFile
    ? syntheticWorkspacePath
    : checkoutSetup.requiresMaterializedWorkspace ||
        gradleToolchainEnvironment
      ? materializeWorkspace(checkoutPath, materializedWorkspacePath)
    : checkoutPath;
  const runtimeRelativeFile = project.syntheticMavenTargetFile
    ? project.syntheticMavenTargetFile
    : project.relativeFile;
  if (project.syntheticMavenTargetFile) {
    createSyntheticMavenWorkspace(project, checkoutPath, workspacePath);
  } else {
    const expectedFile = path.join(checkoutPath, ...project.relativeFile.split("/"));
    if (!fs.existsSync(expectedFile)) {
      throw new Error(`Pinned T1 source file does not exist: ${expectedFile}`);
    }
  }
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

  const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
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
  } else {
    extensionSources = process.env.T1_INTELLIJ_VSIX
      ? [path.resolve(process.env.T1_INTELLIJ_VSIX)]
      : providerExtensionSources.intellij;
  }
  if (
    provider === "intellij" &&
    process.env.T1_INTELLIJ_VSIX &&
    !fs.existsSync(extensionSources[0])
  ) {
    throw new Error(`IntelliJ VSIX does not exist: ${extensionSources[0]}`);
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
  const processStartedAt = new Date();
  process.env.IMPORT_RESULT = sourceResultPath;
  process.env.IMPORT_CASE_JSON = JSON.stringify({
    id: project.id,
    relativeFile: runtimeRelativeFile,
    sourceSymbol: project.sourceSymbol,
  });
  process.env.IMPORT_PRODUCT = provider;
  process.env.IMPORT_TIMEOUT_MS = String(project.timeoutSeconds * 1_000);
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
    ),
  };
  writeJson(
    path.join(outputDirectory, "vscode-settings.json"),
    vscodeSettings,
  );
  const driver = new VscodeDriver({
    vscodeVersion: "stable",
    extensionPath: importExtensionPath,
    workspacePath,
    workspaceTrust: "disabled",
    settings: vscodeSettings,
  });

  let onboarding = null;
  let error = null;
  let finalResult = null;
  try {
    await driver.launch();
    await saveScreenshot(driver, outputDirectory, "01-workbench-ready");
    if (provider === "intellij") {
      onboarding = await completeIntellijOnboarding(driver, outputDirectory);
    }
    const deadline =
      Date.parse(processStartedAt.toISOString()) +
      project.timeoutSeconds * 1_000 +
      120_000;
    const providerLog = await waitForProviderLogMilestone(
      driver,
      profile,
      provider,
      Math.max(0, deadline - Date.now()),
      outputDirectory,
    );
    const observedProviderLoad = await waitForProviderIdleAfterLog(
      driver,
      provider,
      deadline,
      outputDirectory,
      providerLog,
    );
    const sourceResult = fs.existsSync(sourceResultPath)
      ? JSON.parse(fs.readFileSync(sourceResultPath, "utf8"))
      : observedProviderLoad.importStatus === "ready"
        ? await waitForT1Result(
            driver,
            sourceResultPath,
            deadline,
            outputDirectory,
          )
        : {
            schemaVersion: 1,
            project: project.id,
            product: provider,
            status: "failure",
            sourceReadyAt: null,
            sourceAttempts: 0,
            failureCategory: observedProviderLoad.failureCategory,
            error: null,
          };
    const diagnosticFiles = [...new Set([
      runtimeRelativeFile,
      ...(project.diagnosticProbeFiles ?? []),
    ])];
    const diagnostics = await captureStableDiagnostics(
      driver,
      provider,
      diagnosticFiles,
      outputDirectory,
    );
    const sourceReady =
      sourceResult.status === "source-ready" &&
      Boolean(sourceResult.sourceReadyAt) &&
      !sourceResult.error;
    const errorCount = Number(diagnostics.counts?.error ?? 0);
    const warningCount = Number(diagnostics.counts?.warning ?? 0);
    const providerLoad = reconcileProviderLoadResult(observedProviderLoad, {
      sourceReady,
      diagnosticsStable: diagnostics.stable,
      errorCount,
    });
    const classification = classifyLoadResult({
      sourceReady,
      sourceFailureCategory: sourceResult.failureCategory,
      providerLoad,
      diagnosticsStable: diagnostics.stable,
      errorCount,
    });
    const successful = classification.successful;
    const completedAt = new Date();
    finalResult = {
      ...sourceResult,
      operatingSystem: process.env.T1_OPERATING_SYSTEM ?? process.platform,
      status: successful ? "success" : "failure",
      sourceReady,
      providerLoaded: providerLoad.loaded,
      providerImportCompleted: providerLoad.importCompleted,
      providerImportStatus: providerLoad.importStatus,
      providerTerminalState: providerLoad.terminalState,
      loadSuccessful: successful,
      loadStatus: classification.loadStatus,
      failureCategory: classification.failureCategory,
      failedPhase: classification.failedPhase,
      errorCount,
      warningCount,
      diagnosticScope: diagnostics.scope ?? "probe-files",
      diagnosticsCaptured: diagnostics.diagnosticsCaptured,
      diagnosticsStable: diagnostics.stable,
      diagnosticFiles,
      diagnosticSummary: {
        scope: diagnostics.scope ?? "probe-files",
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
    writeJson(resultPath, finalResult);
    await saveScreenshot(driver, outputDirectory, "07-load-result");
    writeJson(path.join(outputDirectory, "comparison-metrics.json"), {
      provider,
      status: finalResult.status,
      providerLoaded: finalResult.providerLoaded,
      providerImportStatus: finalResult.providerImportStatus,
      providerTerminalState: finalResult.providerTerminalState,
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
    finalResult = {
      ...existingResult,
      status: "failure",
      operatingSystem: process.env.T1_OPERATING_SYSTEM ?? process.platform,
      sourceReady: Boolean(existingResult.sourceReadyAt),
      providerLoaded: false,
      providerImportCompleted: false,
      providerImportStatus: "not-loaded",
      providerTerminalState: null,
      loadSuccessful: false,
      loadStatus: "not-loaded",
      failureCategory: "runner-error",
      failedPhase: "runner",
      errorCount: Number(existingResult.errorCount ?? 0),
      warningCount: Number(existingResult.warningCount ?? 0),
      diagnosticsCaptured: Boolean(existingResult.diagnosticsCaptured),
      completedAt: completedAt.toISOString(),
      totalDurationMs: completedAt.getTime() - processStartedAt.getTime(),
      error: caught instanceof Error ? caught.stack : String(caught),
    };
    writeJson(resultPath, finalResult);
  } finally {
    await driver.close();
    collectProfileEvidence(profile, outputDirectory);
    writeJson(path.join(outputDirectory, "run-metadata.json"), {
      project: project.id,
      repository: project.repository,
      commit: project.commit,
      relativeFile: project.relativeFile,
      runtimeRelativeFile,
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
      const resultPath = path.join(activeOutputDirectory, "result.json");
      if (!fs.existsSync(resultPath)) {
        const failedAt = new Date();
        const result = {
          schemaVersion: 1,
          project: argument("--project", process.env.T1_PROJECT) ?? null,
          product: argument("--provider", process.env.T1_PROVIDER) ?? null,
          status: "failure",
          operatingSystem: process.env.T1_OPERATING_SYSTEM ?? process.platform,
          providerLoaded: false,
          providerImportCompleted: false,
          providerImportStatus: "not-loaded",
          providerTerminalState: null,
          loadSuccessful: false,
          loadStatus: "not-loaded",
          failureCategory: "runner-error",
          failedPhase: "runner",
          errorCount: 0,
          warningCount: 0,
          diagnosticsCaptured: false,
          completedAt: failedAt.toISOString(),
          totalDurationMs: failedAt.getTime() - scriptStartedAt,
          error: error instanceof Error ? error.stack : String(error),
        };
        writeJson(resultPath, result);
        appendGithubSummary(result);
      }
    }
    console.error(error);
    process.exitCode = 1;
  });
}
