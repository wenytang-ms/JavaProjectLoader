import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportedBuildTools = new Set(["gradle", "maven"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function requireRelativePath(value, label) {
  requireString(value, label);
  if (path.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path: ${value}`);
  }
}

function isDescriptorFreeConfiguredSource(project) {
  return project.comparisonMode === "configured-source" &&
    Object.values(project.projectSetup.buildDescriptors).every((files) => files.length === 0);
}

export function validateProjectSetup(project) {
  const setup = project.projectSetup;
  if (!setup) {
    return;
  }

  requireString(setup.buildTool, `${project.id}.projectSetup.buildTool`);
  requireString(setup.buildToolVersion, `${project.id}.projectSetup.buildToolVersion`);
  requireString(
    setup.buildToolVersionSource,
    `${project.id}.projectSetup.buildToolVersionSource`,
  );
  if (!supportedBuildTools.has(setup.buildTool)) {
    throw new Error(
      `${project.id}.projectSetup.buildTool must be gradle or maven.`,
    );
  }

  if (!Array.isArray(setup.evidenceFiles) || setup.evidenceFiles.length === 0) {
    throw new Error(`${project.id}.projectSetup.evidenceFiles must not be empty.`);
  }
  for (const file of setup.evidenceFiles) {
    requireRelativePath(file, `${project.id}.projectSetup.evidenceFiles`);
  }

  if (!setup.buildDescriptors || typeof setup.buildDescriptors !== "object") {
    throw new Error(`${project.id}.projectSetup.buildDescriptors is required.`);
  }
  if (
    setup.buildDescriptorRoot &&
    !["repository", "workspace"].includes(setup.buildDescriptorRoot)
  ) {
    throw new Error(
      `${project.id}.projectSetup.buildDescriptorRoot must be repository or workspace.`,
    );
  }
  if (
    setup.buildDescriptorRoot === "workspace" &&
    !project.syntheticMavenTargetFile
  ) {
    throw new Error(
      `${project.id}.projectSetup.buildDescriptorRoot=workspace requires a synthetic workspace.`,
    );
  }
  for (const [tool, files] of Object.entries(setup.buildDescriptors)) {
    if (!supportedBuildTools.has(tool) || !Array.isArray(files)) {
      throw new Error(
        `${project.id}.projectSetup.buildDescriptors has invalid tool ${tool}.`,
      );
    }
    for (const file of files) {
      requireRelativePath(
        file,
        `${project.id}.projectSetup.buildDescriptors.${tool}`,
      );
    }
  }
  if ((setup.buildDescriptors[setup.buildTool] ?? []).length === 0 &&
      !isDescriptorFreeConfiguredSource(project)) {
    throw new Error(
      `${project.id}.projectSetup.buildDescriptors.${setup.buildTool} must not be empty.`,
    );
  }

  if (!setup.providers || typeof setup.providers !== "object") {
    throw new Error(`${project.id}.projectSetup.providers is required.`);
  }
  for (const provider of ["jdtls", "intellij"]) {
    const providerSetup = setup.providers[provider];
    if (provider === "intellij" && providerSetup === undefined) {
      continue;
    }
    if (!providerSetup) {
      throw new Error(`${project.id}.projectSetup.providers.${provider} is required.`);
    }
    requireString(
      providerSetup.projectJava?.version,
      `${project.id}.${provider}.projectJava.version`,
    );
    requireString(
      providerSetup.projectJava?.distribution,
      `${project.id}.${provider}.projectJava.distribution`,
    );
    if (!["setup-java", "bundled"].includes(providerSetup.runtimeJava?.source)) {
      throw new Error(
        `${project.id}.${provider}.runtimeJava.source must be setup-java or bundled.`,
      );
    }
    if (providerSetup.runtimeJava.source === "setup-java") {
      requireString(
        providerSetup.runtimeJava.version,
        `${project.id}.${provider}.runtimeJava.version`,
      );
      requireString(
        providerSetup.runtimeJava.distribution,
        `${project.id}.${provider}.runtimeJava.distribution`,
      );
    }
    if (
      !providerSetup.vscodeSettings ||
      typeof providerSetup.vscodeSettings !== "object" ||
      Array.isArray(providerSetup.vscodeSettings)
    ) {
      throw new Error(`${project.id}.${provider}.vscodeSettings must be an object.`);
    }
  }
  if (setup.providers.oracle) {
    const providerSetup = setup.providers.oracle;
    requireString(
      providerSetup.projectJava?.version,
      `${project.id}.oracle.projectJava.version`,
    );
    requireString(
      providerSetup.projectJava?.distribution,
      `${project.id}.oracle.projectJava.distribution`,
    );
    if (providerSetup.runtimeJava?.source !== "setup-java") {
      throw new Error(
        `${project.id}.oracle.runtimeJava.source must be setup-java.`,
      );
    }
    requireString(
      providerSetup.runtimeJava.version,
      `${project.id}.oracle.runtimeJava.version`,
    );
    requireString(
      providerSetup.runtimeJava.distribution,
      `${project.id}.oracle.runtimeJava.distribution`,
    );
    if (
      !providerSetup.vscodeSettings ||
      typeof providerSetup.vscodeSettings !== "object" ||
      Array.isArray(providerSetup.vscodeSettings)
    ) {
      throw new Error(`${project.id}.oracle.vscodeSettings must be an object.`);
    }
  }

  if (setup.gradleWrapper) {
    requireRelativePath(
      setup.gradleWrapper.path,
      `${project.id}.projectSetup.gradleWrapper.path`,
    );
  }

  if (setup.toolchainJava) {
    requireString(
      setup.toolchainJava.distribution,
      `${project.id}.projectSetup.toolchainJava.distribution`,
    );
    if (
      !Array.isArray(setup.toolchainJava.versions) ||
      setup.toolchainJava.versions.length === 0
    ) {
      throw new Error(
        `${project.id}.projectSetup.toolchainJava.versions must not be empty.`,
      );
    }
    for (const version of setup.toolchainJava.versions) {
      requireString(
        version,
        `${project.id}.projectSetup.toolchainJava.versions`,
      );
    }
    for (const [operatingSystem, distribution] of Object.entries(
      setup.toolchainJava.distributionsByOs ?? {},
    )) {
      if (!["windows-latest", "macos-latest"].includes(operatingSystem)) {
        throw new Error(
          `${project.id}.projectSetup.toolchainJava has unknown OS: ` +
          operatingSystem,
        );
      }
      requireString(
        distribution,
        `${project.id}.projectSetup.toolchainJava.distributionsByOs.` +
        operatingSystem,
      );
    }
  }

  if (
    setup.gradleToolchains?.restrictToConfiguredJdks !== undefined &&
    typeof setup.gradleToolchains.restrictToConfiguredJdks !== "boolean"
  ) {
    throw new Error(
      `${project.id}.projectSetup.gradleToolchains.` +
      `restrictToConfiguredJdks must be boolean.`,
    );
  }

  if (setup.goVersion) {
    requireString(setup.goVersion, `${project.id}.projectSetup.goVersion`);
  }

  if (setup.bootstrapGradleVersion) {
    requireString(
      setup.bootstrapGradleVersion,
      `${project.id}.projectSetup.bootstrapGradleVersion`,
    );
    if (setup.buildTool !== "gradle") {
      throw new Error(
        `${project.id}.projectSetup.bootstrapGradleVersion requires Gradle.`,
      );
    }
  }

  for (const [index, copy] of (setup.windowsJavaToolCopies ?? []).entries()) {
    requireRelativePath(
      copy.source,
      `${project.id}.projectSetup.windowsJavaToolCopies[${index}].source`,
    );
    requireRelativePath(
      copy.target,
      `${project.id}.projectSetup.windowsJavaToolCopies[${index}].target`,
    );
  }

  if (setup.checkout) {
    if (
      setup.checkout.submodules !== undefined &&
      typeof setup.checkout.submodules !== "boolean"
    ) {
      throw new Error(
        `${project.id}.projectSetup.checkout.submodules must be boolean.`,
      );
    }
    if (
      setup.checkout.gradleSiblingProjects !== undefined &&
      !Array.isArray(setup.checkout.gradleSiblingProjects)
    ) {
      throw new Error(
        `${project.id}.projectSetup.checkout.gradleSiblingProjects must be an array.`,
      );
    }
    for (const dependency of setup.checkout.gradleSiblingProjects ?? []) {
      requireString(
        dependency.name,
        `${project.id}.projectSetup.checkout.gradleSiblingProjects.name`,
      );
      if (!/^[A-Za-z0-9._-]+$/.test(dependency.name)) {
        throw new Error(
          `${project.id}.projectSetup.checkout dependency name is invalid: ` +
          dependency.name,
        );
      }
      requireString(
        dependency.repository,
        `${project.id}.projectSetup.checkout.gradleSiblingProjects.repository`,
      );
      if (!/^[a-f0-9]{40}$/.test(dependency.commit ?? "")) {
        throw new Error(
          `${project.id}.projectSetup.checkout dependency commit is invalid: ` +
          dependency.commit,
        );
      }
    }
    if (setup.checkout.windowsGradleExecutableExtensions) {
      const executableExtensions =
        setup.checkout.windowsGradleExecutableExtensions;
      requireRelativePath(
        executableExtensions.file,
        `${project.id}.projectSetup.checkout.windowsGradleExecutableExtensions.file`,
      );
      if (
        !Array.isArray(executableExtensions.tools) ||
        executableExtensions.tools.length === 0
      ) {
        throw new Error(
          `${project.id}.projectSetup.checkout.windowsGradleExecutableExtensions.tools ` +
          "must not be empty.",
        );
      }
      for (const tool of executableExtensions.tools) {
        requireString(
          tool,
          `${project.id}.projectSetup.checkout.windowsGradleExecutableExtensions.tools`,
        );
      }
    }
    for (const [index, replacement] of (
      setup.checkout.windowsTextReplacements ?? []
    ).entries()) {
      requireRelativePath(
        replacement.file,
        `${project.id}.projectSetup.checkout.windowsTextReplacements[${index}].file`,
      );
      requireString(
        replacement.from,
        `${project.id}.projectSetup.checkout.windowsTextReplacements[${index}].from`,
      );
      requireString(
        replacement.to,
        `${project.id}.projectSetup.checkout.windowsTextReplacements[${index}].to`,
      );
    }
  }

  if (setup.buildTool === "maven") {
    requireString(
      setup.maven?.downloadUrl,
      `${project.id}.projectSetup.maven.downloadUrl`,
    );
    if (!/^[a-f0-9]{128}$/.test(setup.maven?.sha512 ?? "")) {
      throw new Error(`${project.id}.projectSetup.maven.sha512 is invalid.`);
    }
  }

  if (setup.androidSdk) {
    if (!/^android-\d+$/.test(setup.androidSdk.platform)) {
      throw new Error(
        `${project.id}.projectSetup.androidSdk.platform must look like android-28.`,
      );
    }
    requireString(
      setup.androidSdk.declaredBuildToolsVersion,
      `${project.id}.projectSetup.androidSdk.declaredBuildToolsVersion`,
    );
    requireString(
      setup.androidSdk.effectiveBuildToolsVersion,
      `${project.id}.projectSetup.androidSdk.effectiveBuildToolsVersion`,
    );
    requireString(
      setup.androidSdk.effectiveBuildToolsReason,
      `${project.id}.projectSetup.androidSdk.effectiveBuildToolsReason`,
    );
    requireRelativePath(
      setup.androidSdk.requirementsFile,
      `${project.id}.projectSetup.androidSdk.requirementsFile`,
    );
    requireString(
      setup.androidSdk.androidGradlePluginVersion,
      `${project.id}.projectSetup.androidSdk.androidGradlePluginVersion`,
    );
    requireRelativePath(
      setup.androidSdk.androidGradlePluginFile,
      `${project.id}.projectSetup.androidSdk.androidGradlePluginFile`,
    );
  }
}

function resolveRepositoryFile(checkoutPath, relativePath) {
  const root = path.resolve(checkoutPath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project checkout: ${relativePath}`);
  }
  return resolved;
}

function readRequiredFile(checkoutPath, relativePath) {
  const filePath = resolveRepositoryFile(checkoutPath, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pinned project requirement file is missing: ${relativePath}`);
  }
  return {
    path: relativePath,
    filePath,
    content: fs.readFileSync(filePath, "utf8"),
  };
}

function fileEvidence(checkoutPath, relativePath) {
  const file = readRequiredFile(checkoutPath, relativePath);
  return {
    path: relativePath,
    bytes: Buffer.byteLength(file.content),
    sha256: createHash("sha256").update(file.content).digest("hex"),
  };
}

function extractGradleWrapperVersion(content, sourcePath) {
  const match = content.match(/gradle-([0-9][0-9A-Za-z.-]*)-(?:bin|all)\.zip/);
  if (!match) {
    throw new Error(`Could not read the Gradle version from ${sourcePath}.`);
  }
  return match[1];
}

function extractRequiredMatch(content, expression, label, sourcePath) {
  const match = content.match(expression);
  if (!match) {
    throw new Error(`Could not read ${label} from ${sourcePath}.`);
  }
  return match[1];
}

export function getProviderSetup(project, provider) {
  const providerSetup = project.projectSetup?.providers?.[provider];
  if (providerSetup) {
    return providerSetup;
  }
  if (provider === "oracle") {
    const jdtlsSetup = project.projectSetup?.providers?.jdtls;
    if (!jdtlsSetup) {
      throw new Error(
        `Project ${project.id} cannot derive Oracle settings without a JDT LS contract.`,
      );
    }
    return {
      runtimeJava: {
        source: "setup-java",
        distribution: "temurin",
        version: "21",
      },
      projectJava: { ...jdtlsSetup.projectJava },
      vscodeSettings: {},
    };
  }
  throw new Error(
    `Project ${project.id} has no environment contract for provider ${provider}.`,
  );
}

export function discoverProjectEnvironment(
  project,
  checkoutPath,
  provider,
  workspacePath = checkoutPath,
) {
  validateProjectSetup(project);
  const setup = project.projectSetup;
  if (!setup) {
    return {
      status: "legacy",
      project: project.id,
      message: "No explicit projectSetup manifest is defined.",
    };
  }
  const providerSetup = getProviderSetup(project, provider);
  const descriptorRoot = setup.buildDescriptorRoot === "workspace"
    ? workspacePath
    : checkoutPath;

  const descriptors = {};
  for (const [tool, files] of Object.entries(setup.buildDescriptors)) {
    descriptors[tool] = files.map((relativePath) =>
      fileEvidence(descriptorRoot, relativePath),
    );
  }
  const availableBuildTools = Object.entries(descriptors)
    .filter(([, files]) => files.length > 0)
    .map(([tool]) => tool)
    .sort();
  if (!availableBuildTools.includes(setup.buildTool) &&
      !isDescriptorFreeConfiguredSource(project)) {
    throw new Error(
      `Preferred build tool ${setup.buildTool} has no descriptor in the pinned checkout.`,
    );
  }

  let actualGradleVersion = null;
  if (setup.gradleWrapper) {
    const wrapper = readRequiredFile(checkoutPath, setup.gradleWrapper.path);
    actualGradleVersion = extractGradleWrapperVersion(
      wrapper.content,
      setup.gradleWrapper.path,
    );
    if (actualGradleVersion !== setup.buildToolVersion) {
      throw new Error(
        `Gradle wrapper changed: expected ${setup.buildToolVersion}, ` +
        `found ${actualGradleVersion}.`,
      );
    }
  }

  let android = null;
  if (setup.androidSdk) {
    const requirements = readRequiredFile(
      checkoutPath,
      setup.androidSdk.requirementsFile,
    );
    const plugin = readRequiredFile(
      checkoutPath,
      setup.androidSdk.androidGradlePluginFile,
    );
    const compileSdk = extractRequiredMatch(
      requirements.content,
      /compileSdkVersion\s+(\d+)/,
      "compileSdkVersion",
      setup.androidSdk.requirementsFile,
    );
    const declaredBuildToolsVersion = extractRequiredMatch(
      requirements.content,
      /buildToolsVersion\s+['"]([^'"]+)['"]/,
      "buildToolsVersion",
      setup.androidSdk.requirementsFile,
    );
    const androidGradlePluginVersion = extractRequiredMatch(
      plugin.content,
      /com\.android\.tools\.build:gradle:([^'"\s]+)/,
      "Android Gradle Plugin version",
      setup.androidSdk.androidGradlePluginFile,
    );

    if (`android-${compileSdk}` !== setup.androidSdk.platform) {
      throw new Error(
        `Android platform changed: expected ${setup.androidSdk.platform}, ` +
        `found android-${compileSdk}.`,
      );
    }
    if (
      declaredBuildToolsVersion !==
      setup.androidSdk.declaredBuildToolsVersion
    ) {
      throw new Error(
        `Declared Android build tools changed: expected ` +
        `${setup.androidSdk.declaredBuildToolsVersion}, ` +
        `found ${declaredBuildToolsVersion}.`,
      );
    }
    if (
      androidGradlePluginVersion !==
      setup.androidSdk.androidGradlePluginVersion
    ) {
      throw new Error(
        `Android Gradle Plugin changed: expected ` +
        `${setup.androidSdk.androidGradlePluginVersion}, ` +
        `found ${androidGradlePluginVersion}.`,
      );
    }
    android = {
      platform: setup.androidSdk.platform,
      declaredBuildToolsVersion,
      effectiveBuildToolsVersion:
        setup.androidSdk.effectiveBuildToolsVersion,
      effectiveBuildToolsReason: setup.androidSdk.effectiveBuildToolsReason,
      androidGradlePluginVersion,
      minSdk: setup.androidSdk.minSdk,
      targetSdk: setup.androidSdk.targetSdk,
    };
  }

  return {
    status: "configured",
    project: project.id,
    provider,
    requirements: {
      runtimeJava: providerSetup.runtimeJava,
      projectJava: providerSetup.projectJava,
      toolchainJava: setup.toolchainJava ?? null,
      gradleToolchains: setup.gradleToolchains ?? null,
      checkout: setup.checkout ?? null,
      goVersion: setup.goVersion ?? null,
      bootstrapGradleVersion: setup.bootstrapGradleVersion ?? null,
      windowsJavaToolCopies: setup.windowsJavaToolCopies ?? [],
      preferredBuildTool: setup.buildTool,
      buildToolVersion: setup.buildToolVersion,
      buildToolVersionSource: setup.buildToolVersionSource,
      selectionReason: setup.selectionReason,
      android,
    },
    detection: {
      availableBuildTools,
      multipleBuildTools: availableBuildTools.length > 1,
      descriptors,
      buildDescriptorRoot: setup.buildDescriptorRoot ?? "repository",
      gradleWrapperVersion: actualGradleVersion,
      evidenceFiles: setup.evidenceFiles.map((relativePath) =>
        fileEvidence(checkoutPath, relativePath),
      ),
    },
  };
}

export function createProjectSettings(
  project,
  provider,
  discovery,
  environment = process.env,
  workspacePath = null,
) {
  const setup = project.projectSetup;
  if (!setup) {
    return {};
  }

  const providerSetup = getProviderSetup(project, provider);
  if (provider === "oracle") {
    const settings = { ...providerSetup.vscodeSettings };
    const languageServerJavaHome = environment.T1_LANGUAGE_SERVER_JAVA_HOME;
    const projectJavaHome = environment.T1_PROJECT_JAVA_HOME;
    if (languageServerJavaHome) {
      settings["jdk.jdkhome"] = languageServerJavaHome;
    }
    if (projectJavaHome) {
      settings["jdk.project.jdkhome"] = projectJavaHome;
    }
    return settings;
  }
  if (provider !== "jdtls") {
    const settings = { ...providerSetup.vscodeSettings };
    const projectJavaHome = environment.T1_PROJECT_JAVA_HOME;
    settings["intellij.buildTool"] = setup.buildTool;
    if (projectJavaHome) {
      settings["intellij.jdkForSymbolResolution"] = projectJavaHome;
    }
    if (workspacePath) {
      const configuredProject = {
        type: setup.buildTool,
        path: pathToFileURL(workspacePath).href,
      };
      if (setup.buildTool === "maven" && projectJavaHome) {
        Object.assign(configuredProject, {
          env: {
            JAVA_HOME: projectJavaHome,
          },
          "java-home": projectJavaHome,
        });
      }
      settings["intellij.projects"] = [configuredProject];
    }
    return settings;
  }
  const settings = {
    "java.project.importOnFirstTimeStartup": "automatic",
    ...providerSetup.vscodeSettings,
  };
  const languageServerJavaHome = environment.T1_LANGUAGE_SERVER_JAVA_HOME;
  const projectJavaHome = environment.T1_PROJECT_JAVA_HOME;
  const buildJavaHome = environment.T1_BUILD_JAVA_HOME ?? projectJavaHome;
  if (languageServerJavaHome) {
    settings["java.jdt.ls.java.home"] = languageServerJavaHome;
  }
  if (environment.T1_REQUIRE_ENVIRONMENT_READY === "1" &&
      Number(providerSetup.runtimeJava?.version) >= 26) {
    // The pinned prerelease's AppCDS launcher adds a VM option removed in Java 26.
    settings["java.jdt.ls.appcds.enabled"] = "off";
  }
  if (projectJavaHome) {
    const homes = environment.T1_JAVA_HOMES_JSON
      ? JSON.parse(environment.T1_JAVA_HOMES_JSON)
      : [];
    if (!Array.isArray(homes)) {
      throw new Error("T1_JAVA_HOMES_JSON must be an array.");
    }
    const candidates = [
      {
        version: providerSetup.projectJava.version,
        home: projectJavaHome,
        default: true,
      },
      ...(buildJavaHome
        ? [{
            version: providerSetup.buildJava?.version ??
              providerSetup.projectJava.version,
            home: buildJavaHome,
          }]
        : []),
      ...homes,
      ...(languageServerJavaHome && providerSetup.runtimeJava.version
        ? [{
            version: providerSetup.runtimeJava.version,
            home: languageServerJavaHome,
          }]
        : []),
    ];
    const runtimes = new Map();
    for (const candidate of candidates) {
      const major = String(candidate.version).match(/^(?:1\.)?(\d+)/)?.[1];
      if (!major || typeof candidate.home !== "string" || !candidate.home) {
        throw new Error("Invalid provisioned Java execution environment.");
      }
      const name = Number(major) < 9 ? `JavaSE-1.${major}` : `JavaSE-${major}`;
      if (!runtimes.has(name)) {
        runtimes.set(name, {
          name,
          path: candidate.home,
          ...(candidate.default ? { default: true } : {}),
        });
      }
    }
    settings["java.configuration.runtimes"] = [...runtimes.values()];
    if (environment.T1_REQUIRE_ENVIRONMENT_READY === "1") {
      settings["java.configuration.detectJdksAtStart"] = false;
    }
  }
  if (setup.buildTool === "gradle" && buildJavaHome) {
    settings["java.import.gradle.java.home"] = buildJavaHome;
  }
  if (setup.buildTool === "maven" && environment.T1_MAVEN_HOME) {
    settings["maven.executable.path"] = path.join(
      environment.T1_MAVEN_HOME,
      "bin",
      process.platform === "win32" ? "mvn.cmd" : "mvn",
    );
  }
  return settings;
}

function javaExecutable(javaHome) {
  return path.join(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
}

export function inspectJavaHome(javaHome, expectedVersion, label) {
  requireString(javaHome, label);
  const executable = javaExecutable(javaHome);
  if (!fs.existsSync(executable)) {
    throw new Error(`${label} does not contain a Java executable: ${javaHome}`);
  }
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed java -version: ${result.stderr}`);
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  const match = output.match(/version "(?:1\.)?(\d+)/);
  if (!match || match[1] !== String(expectedVersion)) {
    throw new Error(
      `${label} expected Java ${expectedVersion}, got: ${output.split("\n")[0]}`,
    );
  }
  const compiler = path.join(javaHome, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  return {
    home: javaHome,
    expectedVersion: String(expectedVersion),
    versionLine: output.split("\n")[0],
    exactVersion: output.match(/version "([^"]+)"/)?.[1],
    releaseSha256: fs.existsSync(path.join(javaHome, "release"))
      ? createHash("sha256")
          .update(fs.readFileSync(path.join(javaHome, "release")))
          .digest("hex")
      : null,
    executableSha256: createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    compilerSha256: fs.existsSync(compiler)
      ? createHash("sha256").update(fs.readFileSync(compiler)).digest("hex")
      : null,
  };
}

export function findSdkManager(sdkRoot) {
  const executableName =
    process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const candidates = [
    path.join(sdkRoot, "cmdline-tools", "latest", "bin", executableName),
    path.join(sdkRoot, "tools", "bin", executableName),
  ];
  const commandLineTools = path.join(sdkRoot, "cmdline-tools");
  if (fs.existsSync(commandLineTools)) {
    for (const entry of fs
      .readdirSync(commandLineTools, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
      .reverse()) {
      candidates.push(
        path.join(commandLineTools, entry, "bin", executableName),
      );
    }
  }
  const sdkManager = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sdkManager) {
    throw new Error(`sdkmanager was not found under ${sdkRoot}.`);
  }
  return sdkManager;
}

export function runSdkManager(sdkManager, sdkRoot, packages, javaHome) {
  const args = [`--sdk_root=${sdkRoot}`, ...packages];
  const result = spawnSync(sdkManager, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
    },
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(
      `sdkmanager failed with exit code ${result.status}:\n${output.slice(-10000)}`,
    );
  }
  if (output.trim()) {
    console.log(output.slice(-20000));
  }
}

function provisionAndroidSdk(androidSdk, environment) {
  const sdkRoot = environment.ANDROID_SDK_ROOT || environment.ANDROID_HOME;
  requireString(sdkRoot, "ANDROID_SDK_ROOT or ANDROID_HOME");
  const toolJava = inspectJavaHome(
    environment.T1_ANDROID_SDK_JAVA_HOME,
    "17",
    "T1_ANDROID_SDK_JAVA_HOME",
  );
  const sdkManager = findSdkManager(sdkRoot);
  const packages = [
    `platforms;${androidSdk.platform}`,
    `build-tools;${androidSdk.effectiveBuildToolsVersion}`,
  ];
  const platformJar = path.join(
    sdkRoot,
    "platforms",
    androidSdk.platform,
    "android.jar",
  );
  const buildToolsPath = path.join(
    sdkRoot,
    "build-tools",
    androidSdk.effectiveBuildToolsVersion,
  );
  if (!fs.existsSync(platformJar) || !fs.existsSync(buildToolsPath)) {
    runSdkManager(sdkManager, sdkRoot, packages, toolJava.home);
  }
  if (!fs.existsSync(platformJar) || !fs.existsSync(buildToolsPath)) {
    throw new Error(`Android SDK packages were not installed: ${packages.join(", ")}`);
  }
  return {
    sdkRoot,
    sdkManager,
    packages,
    platformJar,
    buildToolsPath,
    toolJava,
  };
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.environment ?? process.env,
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === "win32" && options.windowsShell === true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: ` +
      `${result.stderr ?? result.stdout ?? ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function appendGithubEnvironment(filePath, line) {
  if (filePath) {
    fs.appendFileSync(filePath, `${line}\n`);
  }
}

export function provisionMaven(setup, environment) {
  const version = setup.buildToolVersion;
  const installRoot = path.join(
    environment.RUNNER_TOOL_CACHE ??
      environment.RUNNER_TEMP ??
      os.tmpdir(),
    "t1-maven",
    version,
  );
  const mavenHome = path.join(installRoot, `apache-maven-${version}`);
  const executable = path.join(
    mavenHome,
    "bin",
    process.platform === "win32" ? "mvn.cmd" : "mvn",
  );

  if (!fs.existsSync(executable)) {
    fs.rmSync(installRoot, { recursive: true, force: true });
    fs.mkdirSync(installRoot, { recursive: true });
    const archivePath = path.join(installRoot, `apache-maven-${version}-bin.zip`);
    runTool("curl", [
      "-fsSL",
      "--retry",
      "3",
      "-o",
      archivePath,
      setup.maven.downloadUrl,
    ]);
    const actualSha512 = createHash("sha512")
      .update(fs.readFileSync(archivePath))
      .digest("hex");
    if (actualSha512 !== setup.maven.sha512) {
      throw new Error(
        `Maven ${version} checksum mismatch: expected ${setup.maven.sha512}, ` +
        `got ${actualSha512}.`,
      );
    }
    if (process.platform === "win32") {
      runTool("tar", ["-xf", archivePath, "-C", installRoot]);
    } else {
      runTool("unzip", ["-q", archivePath, "-d", installRoot]);
    }
    fs.rmSync(archivePath, { force: true });
  }

  const versionOutput = runTool(executable, ["--version"], {
    environment: {
      ...process.env,
      ...environment,
      JAVA_HOME: environment.T1_BUILD_JAVA_HOME ?? environment.T1_PROJECT_JAVA_HOME,
    },
    windowsShell: true,
  });
  if (!versionOutput.includes(`Apache Maven ${version}`)) {
    throw new Error(`Expected Apache Maven ${version}, got: ${versionOutput}`);
  }

  appendGithubEnvironment(environment.GITHUB_ENV, `MAVEN_HOME=${mavenHome}`);
  appendGithubEnvironment(environment.GITHUB_ENV, `M2_HOME=${mavenHome}`);
  appendGithubEnvironment(environment.GITHUB_ENV, `T1_MAVEN_HOME=${mavenHome}`);
  appendGithubEnvironment(
    environment.GITHUB_PATH,
    path.join(mavenHome, "bin"),
  );
  return {
    version,
    home: mavenHome,
    executable,
    versionLine: versionOutput.split(/\r?\n/)[0],
    sha512: setup.maven.sha512,
  };
}

export function provisionProjectEnvironment(
  project,
  { provider = "jdtls", dryRun = false, environment = process.env } = {},
) {
  validateProjectSetup(project);
  const setup = project.projectSetup;
  if (!setup) {
    return {
      status: "legacy",
      project: project.id,
      message: "No explicit host environment provisioning is required.",
    };
  }
  const providerSetup = getProviderSetup(project, provider);

  const result = {
    status: dryRun ? "planned" : "provisioned",
    project: project.id,
    provider,
    requirements: {
      runtimeJava: providerSetup.runtimeJava,
      projectJava: providerSetup.projectJava,
      toolchainJava: setup.toolchainJava ?? null,
      gradleToolchains: setup.gradleToolchains ?? null,
      checkout: setup.checkout ?? null,
      goVersion: setup.goVersion ?? null,
      bootstrapGradleVersion: setup.bootstrapGradleVersion ?? null,
      windowsJavaToolCopies: setup.windowsJavaToolCopies ?? [],
      buildTool: setup.buildTool,
      buildToolVersion: setup.buildToolVersion,
      androidPackages: setup.androidSdk
        ? [
            `platforms;${setup.androidSdk.platform}`,
            `build-tools;${setup.androidSdk.effectiveBuildToolsVersion}`,
          ]
        : [],
    },
  };
  if (dryRun) {
    return result;
  }

  result.providerRuntimeJava =
    providerSetup.runtimeJava.source === "setup-java"
      ? inspectJavaHome(
          environment.T1_LANGUAGE_SERVER_JAVA_HOME,
          providerSetup.runtimeJava.version,
          "T1_LANGUAGE_SERVER_JAVA_HOME",
        )
      : { source: "bundled" };
  result.projectJava = inspectJavaHome(
    environment.T1_PROJECT_JAVA_HOME,
    providerSetup.projectJava.version,
    "T1_PROJECT_JAVA_HOME",
  );
  if (providerSetup.buildJava) {
    result.buildJava = inspectJavaHome(
      environment.T1_BUILD_JAVA_HOME,
      providerSetup.buildJava.version,
      "T1_BUILD_JAVA_HOME",
    );
  }
  if (environment.T1_JAVA_HOMES_JSON) {
    const homes = JSON.parse(environment.T1_JAVA_HOMES_JSON);
    if (!Array.isArray(homes)) {
      throw new Error("T1_JAVA_HOMES_JSON must be an array.");
    }
    result.javaInstallations = homes.map((entry) => ({
      ...inspectJavaHome(entry.home, entry.version, "Provisioned Java home"),
      distribution: entry.distribution,
      role: entry.role,
      setupJavaVersion: entry.setupJavaVersion,
      setupJavaCacheVersion: entry.setupJavaCacheVersion,
    }));
  }
  result.maven = setup.buildTool === "maven"
    ? provisionMaven(setup, environment)
    : null;
  result.androidSdk = setup.androidSdk
    ? provisionAndroidSdk(setup.androidSdk, environment)
    : null;
  return result;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const projectId = argument("--project", process.env.T1_PROJECT);
  const provider = argument("--provider", process.env.T1_PROVIDER);
  if (!projectId || !provider) {
    throw new Error("--project and --provider are required.");
  }
  const { loadProjects } = await import("./create-matrix.mjs");
  const project = loadProjects().find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const result = provisionProjectEnvironment(project, {
    provider,
    dryRun: process.argv.includes("--dry-run"),
  });
  const resultPath = argument(
    "--result",
    process.env.T1_PROJECT_ENVIRONMENT_RESULT,
  );
  if (resultPath) {
    writeJson(path.resolve(resultPath), result);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
