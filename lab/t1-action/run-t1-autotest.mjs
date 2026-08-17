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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const importExtensionPath = path.join(repositoryRoot, "lab", "import-extension");
const providerExtensions = {
  jdtls: "vscjava.vscode-java-pack",
  intellij: "JetBrains.intellij-server",
};
const approvedIntellijOnboarding = {
  region: "middle_east",
  dataSharing: "none",
  eulaVersion: "1.0",
  eulaEffectiveDate: "July 31, 2026",
  eulaSha256: "ca5e72e6658dd12b6149ddf81411d0029d7d63aaea0c74e2282e0e386832e371",
};
let activeOutputDirectory = null;

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

function cloneProject(project, checkoutPath) {
  fs.rmSync(checkoutPath, { recursive: true, force: true });
  fs.mkdirSync(checkoutPath, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: checkoutPath });
  if (process.platform === "win32") {
    run("git", ["config", "core.longpaths", "true"], { cwd: checkoutPath });
  }
  run("git", ["remote", "add", "origin", project.repository], { cwd: checkoutPath });
  run(
    "git",
    ["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", project.commit],
    { cwd: checkoutPath },
  );
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkoutPath });
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
  await driver.screenshot(path.join(outputDirectory, `${name}.png`));
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

async function clickWebviewElement(locator) {
  await locator.waitFor({ state: "attached", timeout: 15_000 });
  await locator.evaluate((element) => element.click());
}

async function clickUntilTransition(frame, sourceSelector, targetSelector) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (await frame.locator(targetSelector).isVisible().catch(() => false)) {
      return;
    }
    const source = frame.locator(sourceSelector);
    if (await source.isVisible().catch(() => false)) {
      await clickWebviewElement(source);
    }
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
    frame = await findLicenseFrame(driver);
  }
  const middleEast = frame.locator("label.region-row", { hasText: "Middle East" });
  await clickWebviewElement(middleEast);
  await wait(500);
  if (!(await middleEast.locator('input[name="region"]').isChecked())) {
    throw new Error("Middle East region was not selected");
  }
  await captureLicensePage(driver, outputDirectory, "02-region-middle-east");
  await clickUntilTransition(frame, ".region-next", ".eula-wizard");
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
  await clickUntilTransition(
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
    await clickWebviewElement(noSharing);
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

async function waitForT1Result(driver, resultPath, timeoutMs, outputDirectory) {
  const startedAt = Date.now();
  let screenshotIndex = 0;
  while (!fs.existsSync(resultPath) && Date.now() - startedAt < timeoutMs + 120_000) {
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
    throw new Error(`T1 result was not written within ${timeoutMs + 120_000}ms`);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (result.status !== "source-ready" || result.error) {
    throw new Error(`T1 result did not pass: ${JSON.stringify(result)}`);
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

function installProvider(vscodeExecutablePath, extensionId, outputDirectory) {
  const [cli, ...baseArgs] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const startedAt = Date.now();
  const installOutput = run(
    cli,
    [...baseArgs, "--install-extension", extensionId, "--force"],
    { capture: true },
  );
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
  return {
    inventory,
    durationMs: Date.now() - startedAt,
  };
}

function listFiles(rootPath) {
  const files = [];
  if (!rootPath || !fs.existsSync(rootPath)) {
    return files;
  }
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (fullPath.includes(`${path.sep}agent-host${path.sep}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
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
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return;
  }
  const bytes = fs.statSync(source).size;
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
  cloneProject(project, checkoutPath);
  const workspacePath = project.syntheticMavenTargetFile
    ? syntheticWorkspacePath
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

  if (project.projectSetup && process.env.T1_PROJECT_JAVA_HOME) {
    process.env.JAVA_HOME = process.env.T1_PROJECT_JAVA_HOME;
  }

  const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
  const profile = getTestProfilePaths(vscodeExecutablePath);
  const install = installProvider(
    vscodeExecutablePath,
    providerExtensions[provider],
    outputDirectory,
  );
  const resultPath = path.join(outputDirectory, "result.json");
  const processStartedAt = new Date();
  process.env.IMPORT_RESULT = resultPath;
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
  try {
    await driver.launch();
    await saveScreenshot(driver, outputDirectory, "01-workbench-ready");
    if (provider === "intellij") {
      onboarding = await completeIntellijOnboarding(driver, outputDirectory);
    }
    const result = await waitForT1Result(
      driver,
      resultPath,
      project.timeoutSeconds * 1_000,
      outputDirectory,
    );
    await wait(10_000);
    await saveScreenshot(driver, outputDirectory, "07-t1-source-ready");
    writeJson(path.join(outputDirectory, "comparison-metrics.json"), {
      provider,
      sourceReadyMs: result.sourceReadyMs,
      processToSourceReadyMs: result.processToSourceReadyMs,
      sourceAttempts: result.sourceAttempts,
      onboardingDurationMs: onboarding?.durationMs ?? 0,
      measuredAt: result.sourceReadyAt,
    });
  } catch (caught) {
    error = caught;
    await saveScreenshot(driver, outputDirectory, "99-error").catch(() => {});
    writeJson(path.join(outputDirectory, "runner-error.json"), {
      status: "runner-error",
      error: caught instanceof Error ? caught.stack : String(caught),
      failedAt: new Date().toISOString(),
    });
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
  }
  if (error) {
    throw error;
  }
}

main().catch((error) => {
  if (activeOutputDirectory && !fs.existsSync(
    path.join(activeOutputDirectory, "runner-error.json"),
  )) {
    writeJson(path.join(activeOutputDirectory, "runner-error.json"), {
      status: "runner-error",
      error: error instanceof Error ? error.stack : String(error),
      failedAt: new Date().toISOString(),
    });
  }
  console.error(error);
  process.exitCode = 1;
});
