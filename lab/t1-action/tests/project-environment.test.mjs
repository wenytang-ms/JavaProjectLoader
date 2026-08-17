import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";
import {
  createProjectSettings,
  discoverProjectEnvironment,
  provisionProjectEnvironment,
} from "../project-environment.mjs";

function writeFixture(root, relativePath, content = "fixture\n") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("MPAndroidChart declares its pinned dual-build Android environment", () => {
  const project = loadProjects().find((entry) => entry.id === "mpandroidchart");
  assert.equal(project.javaVersion, "21");
  assert.equal(
    project.projectSetup.providers.jdtls.projectJava.version,
    "11",
  );
  assert.equal(project.projectSetup.buildTool, "gradle");
  assert.equal(project.projectSetup.buildToolVersion, "7.2");
  assert.deepEqual(project.projectSetup.buildDescriptors.maven, [
    "MPChartLib/pom.xml",
  ]);
  assert.equal(project.projectSetup.androidSdk.platform, "android-28");
  assert.equal(
    project.projectSetup.androidSdk.declaredBuildToolsVersion,
    "28.0.3",
  );
  assert.equal(
    project.projectSetup.androidSdk.effectiveBuildToolsVersion,
    "30.0.2",
  );
  assert.equal(
    project.projectSetup.providers.jdtls.vscodeSettings[
      "java.jdt.ls.androidSupport.enabled"
    ],
    "on",
  );
});

test("discovery verifies pinned requirements and JDT LS prefers Gradle", () => {
  const project = loadProjects().find((entry) => entry.id === "mpandroidchart");
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "t1-mpandroidchart-environment-"),
  );
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
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-7.2-bin.zip\n",
    );
    writeFixture(
      fixture,
      "build.gradle",
      "classpath 'com.android.tools.build:gradle:7.0.4'\n",
    );
    writeFixture(
      fixture,
      "MPChartLib/build.gradle",
      "compileSdkVersion 28\nbuildToolsVersion '28.0.3'\n",
    );

    const discovery = discoverProjectEnvironment(project, fixture, "jdtls");
    assert.deepEqual(discovery.detection.availableBuildTools, [
      "gradle",
      "maven",
    ]);
    assert.equal(discovery.detection.multipleBuildTools, true);
    assert.equal(discovery.detection.gradleWrapperVersion, "7.2");
    assert.equal(
      discovery.requirements.android.declaredBuildToolsVersion,
      "28.0.3",
    );
    assert.equal(
      discovery.requirements.android.effectiveBuildToolsVersion,
      "30.0.2",
    );

    const settings = createProjectSettings(project, "jdtls", discovery, {
      T1_LANGUAGE_SERVER_JAVA_HOME: "C:\\jdks\\21",
      T1_PROJECT_JAVA_HOME: "C:\\jdks\\11",
    });
    assert.equal(settings["java.jdt.ls.java.home"], "C:\\jdks\\21");
    assert.equal(settings["java.jdt.ls.androidSupport.enabled"], "on");
    assert.equal(settings["java.import.gradle.java.home"], "C:\\jdks\\11");
    assert.equal(settings["java.import.gradle.enabled"], true);
    assert.equal(settings["java.import.gradle.wrapper.enabled"], true);
    assert.equal(settings["java.import.maven.enabled"], false);
    assert.equal(
      settings["java.project.importOnFirstTimeStartup"],
      "automatic",
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("dry-run reports every host requirement without changing the host", () => {
  const project = loadProjects().find((entry) => entry.id === "mpandroidchart");
  const plan = provisionProjectEnvironment(project, {
    provider: "jdtls",
    dryRun: true,
  });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.requirements, {
    runtimeJava: {
      source: "setup-java",
      distribution: "temurin",
      version: "21",
    },
    projectJava: {
      distribution: "temurin",
      version: "11",
    },
    buildTool: "gradle",
    buildToolVersion: "7.2",
    androidPackages: [
      "platforms;android-28",
      "build-tools;30.0.2",
    ],
  });
});

test("Algorithms and RxJava expose provider-specific toolchains", () => {
  const projects = loadProjects();
  const algorithms = projects.find((entry) => entry.id === "the-algorithms-java");
  const rxjava = projects.find((entry) => entry.id === "rxjava");

  assert.equal(algorithms.projectSetup.buildTool, "maven");
  assert.equal(algorithms.projectSetup.buildToolVersion, "3.9.11");
  assert.deepEqual(algorithms.projectSetup.providers.jdtls.projectJava, {
    distribution: "temurin",
    version: "21",
  });
  assert.equal(
    algorithms.projectSetup.providers.intellij.runtimeJava.source,
    "bundled",
  );

  assert.equal(rxjava.projectSetup.buildTool, "gradle");
  assert.equal(rxjava.projectSetup.buildToolVersion, "9.7.0");
  assert.deepEqual(rxjava.projectSetup.providers.jdtls.projectJava, {
    distribution: "zulu",
    version: "26",
  });
  assert.equal(
    rxjava.projectSetup.providers.jdtls.runtimeJava.version,
    "21",
  );
  assert.equal(
    rxjava.projectSetup.providers.intellij.runtimeJava.source,
    "bundled",
  );
});

test("seven added CSV cases expose pinned project toolchains", () => {
  const projects = loadProjects();
  const expected = {
    "java-design-patterns": ["maven", "3.9.6", "21"],
    "spring-boot": ["gradle", "9.7.0", "25"],
    elasticsearch: ["gradle", "9.6.1", "21"],
    mall: ["maven", "3.9.11", "17"],
    interviews: ["maven", "3.9.11", "21"],
    guava: ["maven", "3.9.12", "26"],
    spark: ["maven", "3.9.11", "17"],
  };

  for (const [id, [buildTool, buildVersion, javaVersion]] of Object.entries(
    expected,
  )) {
    const project = projects.find((entry) => entry.id === id);
    assert.equal(project.projectSetup.buildTool, buildTool);
    assert.equal(project.projectSetup.buildToolVersion, buildVersion);
    assert.equal(
      project.projectSetup.providers.jdtls.projectJava.version,
      javaVersion,
    );
    assert.equal(
      project.projectSetup.providers.jdtls.runtimeJava.version,
      "21",
    );
    assert.equal(
      project.projectSetup.providers.intellij.runtimeJava.source,
      "bundled",
    );
  }
});

test("unmanaged interviews case validates its generated Maven descriptor", () => {
  const project = loadProjects().find((entry) => entry.id === "interviews");
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "t1-interviews-source-"));
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "t1-interviews-workspace-"),
  );
  try {
    writeFixture(checkout, "README.md");
    writeFixture(checkout, "company/adobe/AddDigits.java", "class AddDigits {}\n");
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
