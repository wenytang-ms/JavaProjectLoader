import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { loadProjects } from "../create-matrix.mjs";
import {
  createProjectSettings,
  discoverProjectEnvironment,
  provisionProjectEnvironment,
} from "../project-environment.mjs";
import {
  applyWindowsGradleExecutableExtensions,
  applyWindowsJavaToolCopies,
  applyWindowsTextReplacements,
  configureGradleToolchainEnvironment,
  captureStableDiagnostics,
  findBuildOutputLogs,
  gradleSiblingProjectSettings,
  materializeWorkspace,
  readBuildOutputEvidence,
  writeGradleToolchainProperties,
} from "../run-t1-autotest.mjs";

function writeFixture(root, relativePath, content = "fixture\n") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("workflow limits each twenty-five-project batch to twenty parallel jobs", () => {
  const workflow = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../.github/workflows/t1-java-providers.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /max-parallel: 20/);
  assert.match(workflow, /--batch "\$\{\{ inputs\.batch \}\}"/);
  assert.match(workflow, /t1-aggregate-conclusion-batch-/);
  assert.match(workflow, /overwrite-settings: false/);
  assert.match(
    workflow,
    /JDK\$\{\{ matrix\.environment\.projectJavaVersion \}\}=\$env:JAVA_HOME/,
  );
});

test("every project exposes complete provider host requirements", () => {
  for (const project of loadProjects()) {
    for (const provider of ["jdtls", "intellij"]) {
      const plan = provisionProjectEnvironment(project, {
        provider,
        dryRun: true,
      });
      assert.equal(plan.status, "planned");
      assert.equal(plan.requirements.projectJava.version, project.javaVersion);
      assert.match(plan.requirements.buildTool, /^(gradle|maven)$/);
    }
  }
});

test("Gradle discovery verifies the pinned wrapper and JDT LS settings", () => {
  const project = loadProjects().find((entry) => entry.id === "rxjava");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t1-rxjava-environment-"));
  try {
    for (const relativePath of project.projectSetup.evidenceFiles) {
      writeFixture(fixture, relativePath);
    }
    for (const files of Object.values(project.projectSetup.buildDescriptors)) {
      for (const relativePath of files) {
        writeFixture(fixture, relativePath);
      }
    }
    writeFixture(
      fixture,
      project.projectSetup.gradleWrapper.path,
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${project.projectSetup.buildToolVersion}-bin.zip\n`,
    );

    const discovery = discoverProjectEnvironment(project, fixture, "jdtls");
    assert.deepEqual(discovery.detection.availableBuildTools, ["gradle"]);
    assert.equal(
      discovery.detection.gradleWrapperVersion,
      project.projectSetup.buildToolVersion,
    );

    const settings = createProjectSettings(project, "jdtls", discovery, {
      T1_LANGUAGE_SERVER_JAVA_HOME: "C:\\jdks\\21",
      T1_PROJECT_JAVA_HOME: "C:\\jdks\\26",
    });
    assert.equal(settings["java.jdt.ls.java.home"], "C:\\jdks\\21");
    assert.equal(settings["java.import.gradle.enabled"], true);
    assert.equal(settings["java.import.maven.enabled"], false);
    assert.match(settings["java.jdt.ls.vmargs"], /-Xmx4G/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("IntelliJ Maven import receives the configured project JDK", () => {
  const project = loadProjects().find(
    (entry) => entry.id === "java-design-patterns",
  );
  const workspace = path.join(os.tmpdir(), "t1-intellij-maven-workspace");
  const projectJavaHome = path.join(os.tmpdir(), "jdks", "21");
  const settings = createProjectSettings(
    project,
    "intellij",
    {},
    { T1_PROJECT_JAVA_HOME: projectJavaHome },
    workspace,
  );

  assert.equal(settings["intellij.buildTool"], "maven");
  assert.equal(
    settings["intellij.jdkForSymbolResolution"],
    projectJavaHome,
  );
  assert.deepEqual(settings["intellij.projects"], [
    {
      type: "maven",
      path: pathToFileURL(workspace).href,
      env: {
        JAVA_HOME: projectJavaHome,
      },
      "java-home": projectJavaHome,
    },
  ]);
});

test("IntelliJ Gradle import receives the configured project JDK", () => {
  const project = loadProjects().find((entry) => entry.id === "rxjava");
  const workspace = path.join(os.tmpdir(), "t1-intellij-gradle-workspace");
  const projectJavaHome = path.join(os.tmpdir(), "jdks", "26");
  const settings = createProjectSettings(
    project,
    "intellij",
    {},
    { T1_PROJECT_JAVA_HOME: projectJavaHome },
    workspace,
  );

  assert.equal(settings["intellij.buildTool"], "gradle");
  assert.equal(
    settings["intellij.jdkForSymbolResolution"],
    projectJavaHome,
  );
  assert.deepEqual(settings["intellij.projects"], [
    {
      type: "gradle",
      path: pathToFileURL(workspace).href,
    },
  ]);
});

test("Guava disables auxiliary Gradle discovery for its Maven contract", () => {
  const project = loadProjects().find((entry) => entry.id === "guava");
  const settings = createProjectSettings(project, "jdtls", {}, {});

  assert.equal(settings["gradle.autoDetect"], "off");
  assert.equal(settings["gradle.nestedProjects"], false);
  assert.equal(settings["java.gradle.buildServer.enabled"], "off");
});

test("JDT LS gate analyzes all Maven and Gradle Build Output", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "t1-build-output-"));
  try {
    const outputDirectory = path.join(
      userData,
      "logs",
      "session",
      "window1",
      "exthost",
      "output_logging_session",
    );
    fs.mkdirSync(outputDirectory, { recursive: true });
    const mavenLog = path.join(outputDirectory, "1-Maven for Java.log");
    const gradleLog = path.join(outputDirectory, "2-Gradle for Java.log");
    fs.writeFileSync(mavenLog, "Maven project import completed\n");
    fs.writeFileSync(
      gradleLog,
      "[error] FAILURE: Build failed with an exception.\nCONFIGURE FAILED\n",
    );
    fs.writeFileSync(
      path.join(outputDirectory, "5-Language Support for Java.log"),
      "BUILD FAILED text outside Build Output\n",
    );

    assert.deepEqual(
      findBuildOutputLogs(userData, "jdtls"),
      [mavenLog, gradleLog],
    );
    const evidence = readBuildOutputEvidence(userData, "jdtls");
    assert.deepEqual(evidence.buildOutputPaths, [mavenLog, gradleLog]);
    assert.deepEqual(evidence.fatalBuildOutputMatches, [
      "gradle-build-failed",
    ]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("an unmanaged case validates its generated Maven descriptor", () => {
  const project = loadProjects().find(
    (entry) => entry.syntheticMavenTargetFile,
  );
  assert.ok(project);
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-unmanaged-source-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "t1-unmanaged-workspace-"));
  try {
    for (const relativePath of project.projectSetup.evidenceFiles) {
      writeFixture(checkout, relativePath, `class ${project.sourceSymbol} {}\n`);
    }
    writeFixture(workspace, "pom.xml", "<project />\n");

    const discovery = discoverProjectEnvironment(
      project,
      checkout,
      "jdtls",
      workspace,
    );
    assert.equal(discovery.detection.buildDescriptorRoot, "workspace");
    assert.deepEqual(discovery.detection.availableBuildTools, ["maven"]);
    assert.equal(discovery.detection.descriptors.maven[0].path, "pom.xml");
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Gradle sibling project settings support Groovy and Kotlin DSL", () => {
  assert.equal(
    gradleSiblingProjectSettings(
      "supertokens-plugin-interface",
      "../plugin-interface",
    ),
    "\ninclude ':supertokens-plugin-interface'\n" +
      "project(':supertokens-plugin-interface').projectDir = " +
      "file('../plugin-interface')\n",
  );
  assert.equal(
    gradleSiblingProjectSettings("dependency", "../dependency", true),
    "\ninclude(\":dependency\")\n" +
      "project(\":dependency\").projectDir = file(\"../dependency\")\n",
  );
});

test("Windows Gradle executable paths receive the required extension", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-gradle-exe-"));
  try {
    fs.writeFileSync(
      path.join(checkout, "common.gradle"),
      [
        'file("bin/javac")',
        "file('bin/javadoc')",
      ].join("\n"),
    );
    const applied = applyWindowsGradleExecutableExtensions(
      checkout,
      {
        file: "common.gradle",
        tools: ["javac", "javadoc"],
      },
      "win32",
    );
    assert.deepEqual(applied, {
      file: "common.gradle",
      tools: ["javac", "javadoc"],
    });

    assert.equal(
      fs.readFileSync(path.join(checkout, "common.gradle"), "utf8"),
      [
        'file("bin/javac.exe")',
        "file('bin/javadoc.exe')",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("Windows checkout replacements normalize shell paths", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-windows-text-"));
  try {
    fs.writeFileSync(
      path.join(checkout, "plugin.gradle"),
      'def root = "${project.rootDir}/sdks/go"\n',
    );
    const applied = applyWindowsTextReplacements(
      checkout,
      [{
        file: "plugin.gradle",
        from: 'def root = "${project.rootDir}/sdks/go"',
        to: 'def root = "${project.rootDir.toString().replace("\\\\", "/")}/sdks/go"',
      }],
      "win32",
    );
    assert.deepEqual(applied, ["plugin.gradle"]);
    assert.match(
      fs.readFileSync(path.join(checkout, "plugin.gradle"), "utf8"),
      /rootDir\.toString\(\)\.replace/,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("Windows Java tool copies expose tools Gradle cannot detect", () => {
  const javaHome = fs.mkdtempSync(path.join(os.tmpdir(), "t1-java-tools-"));
  try {
    writeFixture(
      javaHome,
      "lib/svm/bin/native-image.exe",
      "native-image",
    );
    const applied = applyWindowsJavaToolCopies(
      javaHome,
      [{
        source: "lib/svm/bin/native-image.exe",
        target: "bin/native-image.exe",
      }],
      "win32",
    );
    assert.deepEqual(applied, [{
      source: "lib/svm/bin/native-image.exe",
      target: "bin/native-image.exe",
    }]);
    assert.equal(
      fs.readFileSync(path.join(javaHome, "bin", "native-image.exe"), "utf8"),
      "native-image",
    );
  } finally {
    fs.rmSync(javaHome, { recursive: true, force: true });
  }
});

test("materialized workspaces preserve setup files and Git metadata", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "t1-materialize-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "t1-materialize-target-"));
  try {
    writeFixture(source, ".git/config", "git metadata");
    writeFixture(source, "SharedModules/core_settings.gradle", "configured");
    materializeWorkspace(source, target);
    assert.equal(
      fs.readFileSync(path.join(target, ".git", "config"), "utf8"),
      "git metadata",
    );
    assert.equal(
      fs.readFileSync(
        path.join(target, "SharedModules", "core_settings.gradle"),
        "utf8",
      ),
      "configured",
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("T1 gate captures stable workspace diagnostics", async () => {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "t1-workspace-diagnostics-"),
  );
  try {
    const driver = {
      async executeVSCodeCommand(command, options) {
        assert.equal(command, "javaImportBenchmark.captureDiagnostics");
        assert.equal(options.scope, "workspace");
        fs.writeFileSync(
          options.resultPath,
          JSON.stringify({
            scope: options.scope,
            stable: true,
            counts: {
              error: 1,
              warning: 2,
              information: 0,
              hint: 0,
            },
            files: [],
            diagnostics: [
              {
                relativePath: "src/main/java/example/Example.java",
                severity: "error",
              },
            ],
          }),
        );
      },
    };

    const diagnostics = await captureStableDiagnostics(
      driver,
      ["src/main/java/example/Example.java"],
      outputDirectory,
    );
    assert.equal(diagnostics.scope, "workspace");
    assert.equal(diagnostics.stable, true);
    assert.equal(diagnostics.counts.error, 1);
    assert.equal(diagnostics.diagnosticsCaptured, true);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("Gradle toolchains can be restricted to configured JDK homes", () => {
  const project = loadProjects().find((entry) => entry.id === "okhttp");
  const environment = {
    T1_PROJECT_JAVA_HOME: "C:\\jdks\\graalvm-25",
    T1_TOOLCHAIN_JAVA_HOMES: "C:\\jdks\\8;C:\\jdks\\11",
  };
  const result = configureGradleToolchainEnvironment(project, environment);
  assert.deepEqual(result.homes, [
    "C:\\jdks\\graalvm-25",
    "C:\\jdks\\8",
    "C:\\jdks\\11",
  ]);
  assert.match(
    environment.GRADLE_OPTS,
    /org\.gradle\.java\.installations\.auto-download=false/,
  );

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-toolchains-"));
  try {
    const propertiesPath = writeGradleToolchainProperties(checkout, result);
    const properties = fs.readFileSync(propertiesPath, "utf8");
    assert.match(
      properties,
      /org\.gradle\.java\.installations\.paths=C:\/jdks\/graalvm-25/,
    );
    assert.match(
      properties,
      /org\.gradle\.java\.installations\.auto-detect=false/,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
