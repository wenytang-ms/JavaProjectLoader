import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  applyEnvironmentPlan,
  discoverEnvironmentPlan,
  environmentGithubOutputs,
} from "../environment-plan.mjs";

const commit = "a".repeat(40);
const provider = {
  projectJava: { version: "17", distribution: "temurin" },
  runtimeJava: { version: "21", distribution: "temurin", source: "setup-java" },
  vscodeSettings: {},
};

function project(overrides = {}) {
  return {
    id: "fixture", commit, relativeFile: "src/Main.java", javaVersion: "17",
    projectSetup: {
      buildTool: "maven", buildToolVersion: "3.9.11",
      providers: { jdtls: structuredClone(provider), oracle: structuredClone(provider) },
      maven: {
        downloadUrl: "https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.zip",
        sha512: "a".repeat(128),
      },
    },
    ...overrides,
  };
}

function fixture(t, files = {}) {
  const root = path.join(import.meta.dirname, "fixtures", `environment-plan-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const absolute = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  write("src/Main.java", "class Main {}\n");
  for (const [file, content] of Object.entries(files)) write(file, content);
  return { root, write };
}

const pom = (body) => `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion><groupId>example</groupId>
  <artifactId>fixture</artifactId><version>1</version>${body}</project>`;
const java = (version) => `<properties><maven.compiler.release>${version}</maven.compiler.release></properties>`;
const enforcer = (rules) => `<build><plugins><plugin><artifactId>maven-enforcer-plugin</artifactId>
  <executions><execution><configuration><rules>${rules}</rules></configuration></execution></executions>
  </plugin></plugins></build>`;
const discover = (input, root, extra = {}) => discoverEnvironmentPlan(input, {
  checkoutPath: root, operatingSystem: "windows-latest", ...extra,
});

test("local parent Java 25 supersedes the old Java 17 contract and source changes alter the plan", (t) => {
  const { root, write } = fixture(t, {
    "pom.xml": pom(`${java("25")}<packaging>pom</packaging><modules><module>server</module></modules>`),
    "server/pom.xml": `<project><parent><groupId>example</groupId><artifactId>fixture</artifactId><version>1</version></parent>
      <artifactId>server</artifactId><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><release>\${maven.compiler.release}</release></configuration></plugin></plugins></build></project>`,
    "server/src/Main.java": "class Main {}",
  });
  const input = project({ id: "appsmith", relativeFile: "server/src/Main.java" });
  const plan = discover(input, root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.java.build.version, "25");
  assert.equal(plan.java.runtime.version, "25");
  assert.ok(plan.requirements.some((item) => item.value === "25" && item.evidence.some((source) => source.path === "pom.xml")));
  assert.ok(plan.inputHashes.some((item) => item.path === "server/pom.xml"));
  write("pom.xml", pom(`${java("26")}<modules><module>server</module></modules>`));
  const changed = discover({ ...input, commit: "b".repeat(40) }, root);
  assert.equal(changed.java.project.version, "26");
  assert.notEqual(changed.inputHashes.find((item) => item.path === "pom.xml").sha256,
    plan.inputHashes.find((item) => item.path === "pom.xml").sha256);
  assert.equal(input.projectSetup.providers.jdtls.projectJava.version, "17");
});

test("all reactor modules, not only the probe module, contribute Java requirements", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("8")}<modules><module>one</module><module>two</module></modules>`),
    "one/pom.xml": pom(java("11")),
    "two/pom.xml": pom(java("23")),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "23");
  assert.deepEqual(plan.inputHashes.filter((item) => item.path.endsWith("pom.xml")).map((item) => item.path),
    ["one/pom.xml", "pom.xml", "two/pom.xml"]);
});

test("missing generated Maven modules are unresolved bootstrap requirements, not ordinary import plans", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(`${java("17")}<modules><module>generated</module></modules>`) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.unresolved.some((item) => item.code === "MISSING_MAVEN_MODULE"));
  assert.ok(plan.requirements.some((item) => item.name === "maven.missingModule" && item.value === "generated/pom.xml"));
});

test("Maven release 8 is not an exact Java 8 compiler; explicit toolchain 17 stays distinct", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("8")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><release>8</release><jdkToolchain><version>17</version></jdkToolchain></configuration>
      </plugin></plugins></build>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "17");
  assert.equal(plan.java.runtime.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, ["17"]);
  assert.notEqual(plan.java.build.version, "17");
});

test("Maven enforcer build JVM and compiler target are independent", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("8") +
    enforcer("<requireJavaVersion><version>[17,22)</version></requireJavaVersion>")) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "8");
  assert.equal(plan.java.build.version, "17");
  assert.deepEqual(plan.java.toolchains.versions, []);
});

test("unused managed enforcer rules are not confused with active Maven executions", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(`${java("17")}<build><pluginManagement><plugins>
    <plugin><artifactId>maven-enforcer-plugin</artifactId><configuration><rules>
    <requireJavaVersion><version>[25]</version></requireJavaVersion>
    </rules></configuration></plugin></plugins></pluginManagement></build>`) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "17");
  assert.equal(plan.java.build.version, "17");
});

test("legacy bytecode selects a usable compiler baseline rather than an exact obsolete JDK", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(`<properties>
    <maven.compiler.source>1.6</maven.compiler.source><maven.compiler.target>1.6</maven.compiler.target>
    </properties>`) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "8");
  assert.equal(plan.java.build.version, "8");
  assert.deepEqual(plan.java.toolchains.versions, []);
});

test("Maven minimum upgrades the harness pin and discards the old checksum", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17") +
    enforcer("<requireMavenVersion><version>[3.9.16,)</version></requireMavenVersion>")) });
  const input = project();
  const plan = discover(input, root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "3.9.16");
  assert.equal(plan.build.sha512, undefined);
  assert.match(plan.build.downloadUrl, /3\.9\.16\/binaries\/apache-maven-3\.9\.16-bin\.zip$/);
  const updated = applyEnvironmentPlan(input, plan);
  assert.equal(updated.projectSetup.maven.sha512, undefined);
  assert.equal(input.projectSetup.maven.sha512, "a".repeat(128));
});

test("Maven exact constraints select 3.8.6 and incompatible minima are blocked", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("11") +
    enforcer("<requireMavenVersion><version>[3.8.6]</version></requireMavenVersion>")) });
  const exact = discover(project(), root);
  assert.equal(exact.state, "PLANNED");
  assert.equal(exact.build.version, "3.8.6");
  const conflict = discover(project(), root, {
    recipe: { commit, constraints: { mavenMin: "3.9.16" }, evidence: [{ path: "pom.xml", reason: "Audited minimum" }] },
  });
  assert.equal(conflict.state, "ENV_BLOCKED");
  assert.ok(conflict.blockers.some((item) => item.code === "MAVEN_VERSION_CONFLICT"));
});

test("Maven wrapper recommendations do not contradict a compatible external Maven pin", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(java("17") + enforcer("<requireMavenVersion><version>[3.3.9,)</version></requireMavenVersion>")),
    ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.12/apache-maven-3.9.12-bin.zip",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "3.9.11");
  assert.ok(plan.requirements.some((item) => item.name === "maven.wrapperRecommendation" && item.value === "3.9.12"));
  assert.equal(plan.requirements.some((item) => item.name === "maven.version" && item.value === "3.9.12"), false);
});

test("native Maven union ranges select a supported allowed build JDK instead of the largest alternative", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`<parent><groupId>external</groupId><artifactId>parent</artifactId><version>52</version>
      <relativePath/></parent>${java("11")}`),
  });
  const model = pom(`<properties><maven.compiler.release>11</maven.compiler.release>
    <maven.compiler.testRelease>17</maven.compiler.testRelease></properties>` + enforcer(
    "<requireJavaVersion><version>[21,22),[25,26),[26,27),[27,28)</version></requireJavaVersion>" +
    "<requireMavenVersion><version>[3.9.16,)</version></requireMavenVersion>"));
  const plan = discover(project(), root, { effectiveMavenModels: [{ path: "pom.xml", xml: model }] });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "17");
  assert.equal(plan.java.build.version, "21");
  assert.equal(plan.java.runtime.version, "21");
  assert.equal(plan.build.version, "3.9.16");
});

test("Maven version union ranges retain gaps when intersected with exact pins", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(java("17") + enforcer(
      "<requireMavenVersion><version>[3.8.6,3.8.9],[3.9.16,)</version></requireMavenVersion>")),
  });
  const compatible = discover(project(), root);
  assert.equal(compatible.state, "PLANNED");
  assert.equal(compatible.build.version, "3.8.6");
  const conflict = discover(project(), root, {
    recipe: { commit, constraints: { mavenExact: "3.9.15" }, evidence: [{ path: "pom.xml" }] },
  });
  assert.equal(conflict.state, "ENV_BLOCKED");
  assert.ok(conflict.blockers.some((item) => item.code === "MAVEN_VERSION_CONFLICT"));
});

test("exclusive or partial Maven minima do not invent a released patch version", (t) => {
  for (const constraint of ["(3.9.16,)", "[3.10,)", "(,3.9)"]) {
    const { root } = fixture(t, { "pom.xml": pom(java("17") +
      enforcer(`<requireMavenVersion><version>${constraint}</version></requireMavenVersion>`)) });
    const plan = discover(project(), root);
    assert.equal(plan.state, "ENV_UNVERIFIED");
    assert.equal(plan.build.version, "");
    assert.ok(plan.unresolved.some((item) => item.code === "AMBIGUOUS_MAVEN_VERSION"));
  }
});

test("a lower toolchain in one Maven module does not cap another module's build compiler", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom("<packaging>pom</packaging><modules><module>old</module><module>new</module></modules>"),
    "old/pom.xml": pom(`${java("8")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><jdkToolchain><version>8</version></jdkToolchain></configuration></plugin></plugins></build>`),
    "new/pom.xml": pom(java("25")),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.java.build.version, "25");
  assert.deepEqual(plan.java.toolchains.versions, ["8"]);
});

test("an insufficient compiler toolchain is blocked within its own Maven module", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("25")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><jdkToolchain><version>17</version></jdkToolchain></configuration></plugin></plugins></build>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.ok(plan.blockers.some((item) => item.code === "COMPILER_TOOLCHAIN_CONFLICT"));
});

test("a compiler toolchain range is satisfied at the module release rather than its lower bound", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("21")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><jdkToolchain><version>[17,25)</version></jdkToolchain></configuration></plugin></plugins></build>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, ["21"]);
});

test("provider JVM can load build plugins requiring newer Java than project bytecode", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("8") +
    enforcer("<requireJavaVersion><version>[25,)</version></requireJavaVersion>")) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "8");
  assert.equal(plan.java.build.version, "25");
  assert.equal(plan.java.runtime.version, "25");
});

test("old Gradle builds on Java 11 while provider runtime stays on Java 21", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "rootProject.name = 'jib'",
    "build.gradle": "plugins { id 'java' }\nsourceCompatibility = JavaVersion.VERSION_1_8\ntargetCompatibility = JavaVersion.VERSION_1_8",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-6.9.2-bin.zip",
  });
  const input = project();
  input.projectSetup.buildTool = "gradle";
  input.projectSetup.buildToolVersion = "8.10";
  const plan = discover(input, root, {
    recipe: { commit, constraints: { buildJavaMin: "11" }, evidence: [{ path: "build.gradle" }] },
  });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "6.9.2");
  assert.equal(plan.java.project.version, "8");
  assert.equal(plan.java.build.version, "11");
  assert.equal(plan.java.runtime.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, []);
});

test("unresolved separate compiler selection keeps a compatible Gradle bootstrap JVM for native refinement", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": `sourceCompatibility = 21
      targetCompatibility = 21
      java { toolchain { languageVersion = JavaLanguageVersion.of(Integer.parseInt('21')) } }`,
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4-bin.zip",
  });
  const candidate = discover(project(), root);
  assert.equal(candidate.state, "ENV_UNVERIFIED");
  assert.equal(candidate.java.build.version, "17");
  assert.deepEqual(candidate.java.toolchains.versions, []);
  assert.ok(candidate.unresolved.some((item) => item.code === "GRADLE_COMPILER_SELECTION_UNVERIFIED"));
  assert.equal(candidate.blockers.some((item) => item.code === "BUILD_JAVA_CONFLICT"), false);
  const refined = discover(project(), root, {
    effectiveGradleModel: {
      gradleVersion: "8.4", buildJavaVersion: "17.0.12", buildJavaHome: "C:\\jdks\\17",
      projects: [{ path: ":", javaToolchain: "21", sourceCompatibility: "21", targetCompatibility: "21" }],
    },
  });
  assert.equal(refined.state, "PLANNED");
  assert.equal(refined.java.build.version, "17");
  assert.deepEqual(refined.java.toolchains.versions, ["21"]);
  assert.equal(refined.unresolved.some((item) => item.code === "GRADLE_COMPILER_SELECTION_UNVERIFIED"), false);
});

test("a known lower module compiler does not turn another unresolved compiler into a launcher conflict", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "include 'aux'",
    "build.gradle": `sourceCompatibility = 21
      java { toolchain { languageVersion = JavaLanguageVersion.of(Integer.parseInt('21')) } }`,
    "aux/build.gradle": "sourceCompatibility = 17\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4-bin.zip",
  });
  const candidate = discover(project(), root);
  assert.equal(candidate.state, "ENV_UNVERIFIED");
  assert.equal(candidate.java.build.version, "17");
  assert.deepEqual(candidate.java.toolchains.versions, ["17"]);
  assert.equal(candidate.blockers.some((item) => item.code === "BUILD_JAVA_CONFLICT"), false);
});

test("proven build JVM conflicts remain blocked despite the compiler-refinement bootstrap path", (t) => {
  const { root, write } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "sourceCompatibility = 21\ntargetCompatibility = 21",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4-bin.zip",
  });
  const noSeparateCompiler = discover(project(), root);
  assert.equal(noSeparateCompiler.state, "ENV_BLOCKED");
  assert.ok(noSeparateCompiler.blockers.some((item) => item.code === "BUILD_JAVA_CONFLICT"));
  write("build.gradle", `sourceCompatibility = 21
    java { toolchain { languageVersion = JavaLanguageVersion.of(Integer.parseInt('21')) } }`);
  const explicitBuildMinimum = discover(project(), root, {
    recipe: {
      commit, constraints: { buildJavaMin: "21" },
      evidence: [{ path: "build.gradle", reason: "An explicit audited launcher minimum, independent of compiler selection." }],
    },
  });
  assert.equal(explicitBuildMinimum.state, "ENV_BLOCKED");
  assert.ok(explicitBuildMinimum.blockers.some((item) => item.code === "BUILD_JAVA_CONFLICT"));
});

test("committed Gradle daemon criteria select the build JVM independently of compiler targets", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\nsourceCompatibility = 17",
    "gradle/gradle-daemon-jvm.properties": "toolchainVersion=25\ntoolchainVendor=ADOPTIUM",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
    ".sdkmanrc": "java=25-librca",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "17");
  assert.equal(plan.java.build.version, "25");
  assert.equal(plan.java.runtime.version, "25");
  assert.equal(plan.java.build.distribution, "temurin");
  assert.deepEqual(plan.java.toolchains.versions, ["17"]);
  assert.ok(plan.inputHashes.some((item) => item.path === "gradle/gradle-daemon-jvm.properties"));
});

test("an independent nested Gradle workspace uses its own wrapper and daemon criteria", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "rootProject.name = 'beam'",
    "build.gradle": "sourceCompatibility = 25",
    "gradle/gradle-daemon-jvm.properties": "toolchainVersion=25",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip",
    "plugins/completion/settings.gradle.kts": 'rootProject.name = "completion"',
    "plugins/completion/build.gradle.kts": "sourceCompatibility = JavaVersion.VERSION_11",
    "plugins/completion/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-7.5.1-bin.zip",
    "plugins/completion/src/Main.java": "class Main {}",
  });
  const plan = discover(project({ relativeFile: "plugins/completion/src/Main.java" }), root, {
    recipe: { commit, buildRoot: "plugins/completion", scope: "java-subproject", constraints: {}, evidence: [] },
  });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "7.5.1");
  assert.equal(plan.build.wrapperPath, "plugins/completion/gradle/wrapper/gradle-wrapper.properties");
  assert.equal(plan.java.project.version, "11");
  assert.equal(plan.java.build.version, "17");
  assert.equal(plan.inputHashes.some((item) => item.path === "gradle/gradle-daemon-jvm.properties"), false);
});

test("Gradle discovers compiler toolchains in buildSrc and convention plugins", (t) => {
  const { root } = fixture(t, {
    "settings.gradle.kts": 'rootProject.name = "conventions"',
    "build.gradle.kts": "plugins { java }\ntasks.withType<JavaCompile>().configureEach { options.release.set(8) }",
    "buildSrc/src/main/kotlin/java-convention.gradle.kts": "java { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }",
    "conventions/src/main/groovy/compiler.gradle": "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.tool, "gradle");
  assert.equal(plan.java.project.version, "21");
  assert.equal(plan.java.build.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, ["17", "21"]);
  assert.ok(plan.inputHashes.some((item) => item.path.includes("buildSrc")));
});

test("Gradle property references resolve without executing DSL", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "gradle.properties": "javaVersion=17",
    "build.gradle": "sourceCompatibility = javaVersion\njava { toolchain { languageVersion = JavaLanguageVersion.of(javaVersion) } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-7.6-bin.zip",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.build.version, "17");
  assert.deepEqual(plan.java.toolchains.versions, ["17"]);
});

test("Gradle settings select real modules rather than disconnected test fixture builds", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "include 'api', 'impl'",
    "build.gradle": "plugins { id 'java' }\nsourceCompatibility = 8",
    "api/build.gradle": "def javaVersion = 17\nsourceCompatibility = javaVersion",
    "impl/build.gradle": "def javaVersion = 21\nsourceCompatibility = javaVersion // actual compiler requirement",
    "fixtures/broken/build.gradle": "sourceCompatibility = 99",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "21");
  assert.equal(plan.inputHashes.some((item) => item.path === "fixtures/broken/build.gradle"), false);
});

test("recipe commit mismatch blocks and does not override discovered source requirements", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("25")) });
  const plan = discover(project(), root, {
    recipe: { commit: "b".repeat(40), buildRoot: "missing", constraints: { projectJavaMin: "8" }, evidence: [] },
  });
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.equal(plan.buildRoot, ".");
  assert.equal(plan.java.project.version, "25");
  assert.ok(plan.blockers.some((item) => item.code === "RECIPE_COMMIT_MISMATCH"));
});

test("an audited build-tool override selects native Maven instead of the old Gradle contract", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(java("21")),
    "settings.gradle": "rootProject.name = 'secondary-fixture'",
    "build.gradle": "sourceCompatibility = 8",
  });
  const input = project();
  input.projectSetup.buildTool = "gradle";
  input.projectSetup.buildToolVersion = "8.5";
  input.projectSetup.bootstrapGradleVersion = "8.5";
  input.projectSetup.gradleWrapper = { path: "gradle/wrapper/gradle-wrapper.properties", enabled: true };
  input.projectSetup.buildDescriptors = { maven: [], gradle: ["build.gradle"] };
  input.projectSetup.providers.jdtls.vscodeSettings = {
    "java.import.maven.enabled": false,
    "java.import.gradle.enabled": true,
    "java.import.gradle.wrapper.enabled": true,
    "java.import.gradle.version": "8.5",
    "java.import.gradle.home": "C:\\old-gradle",
  };
  const recipe = {
    commit, buildTool: "maven", constraints: { mavenExact: "3.9.11" },
    evidence: [{ path: "pom.xml", reason: "Native Quarkus reactor is Maven." }],
  };
  const plan = discover(input, root, { recipe });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.tool, "maven");
  assert.equal(plan.build.version, "3.9.11");
  assert.equal(plan.java.project.version, "21");
  const applied = applyEnvironmentPlan(input, plan);
  assert.equal(applied.projectSetup.buildTool, "maven");
  assert.deepEqual(applied.projectSetup.buildDescriptors, { maven: ["pom.xml"], gradle: [] });
  assert.equal(applied.projectSetup.bootstrapGradleVersion, undefined);
  assert.equal(applied.projectSetup.gradleWrapper, undefined);
  assert.deepEqual(applied.projectSetup.providers.jdtls.vscodeSettings, {
    "java.import.maven.enabled": true,
    "java.import.gradle.enabled": false,
    "java.import.gradle.wrapper.enabled": false,
  });
  assert.deepEqual(plan.java.toolchains.versions, []);
  assert.equal(environmentGithubOutputs(plan).toolchainJavaVersions, "");
  assert.equal(input.projectSetup.buildTool, "gradle");
  assert.equal(input.projectSetup.bootstrapGradleVersion, "8.5");
});

test("Gradle bootstrap follows the selected version only when source has no wrapper", (t) => {
  const { root, write } = fixture(t, {
    "settings.gradle": "rootProject.name = 'bootstrap'",
    "build.gradle": "sourceCompatibility = 17",
  });
  const input = project();
  input.projectSetup.buildTool = "gradle";
  input.projectSetup.buildToolVersion = "8.5";
  input.projectSetup.bootstrapGradleVersion = "8.5";
  const recipe = { commit, constraints: { gradleVersion: "8.13" }, evidence: [{ path: "build.gradle" }] };
  const planned = discover(input, root, { recipe });
  assert.equal(planned.state, "PLANNED");
  const generated = applyEnvironmentPlan(input, planned);
  assert.equal(generated.projectSetup.bootstrapGradleVersion, "8.13");
  assert.equal(generated.projectSetup.providers.jdtls.vscodeSettings["java.import.gradle.version"], "8.13");
  assert.equal(input.projectSetup.bootstrapGradleVersion, "8.5");
  write("gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip");
  const wrapped = applyEnvironmentPlan(input, discover(input, root, { recipe }));
  assert.equal(wrapped.projectSetup.bootstrapGradleVersion, undefined);
  assert.deepEqual(wrapped.projectSetup.gradleWrapper, { path: "gradle/wrapper/gradle-wrapper.properties", enabled: true });
});

test("an audited build-tool override cannot fabricate a missing native descriptor", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("21")) });
  const plan = discover(project(), root, {
    recipe: { commit, buildTool: "gradle", constraints: { gradleVersion: "8.5" }, evidence: [] },
  });
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.ok(plan.blockers.some((item) => item.code === "RECIPE_BUILD_TOOL_UNAVAILABLE"));
});

test("audited Android packages are copied into the plan with evidence and no recipe mutation", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17")) });
  const recipe = {
    commit, constraints: {},
    android: {
      platforms: ["android-35"], buildTools: ["35.0.0"], ndkVersions: ["27.0.12077973"],
    },
    evidence: [{ path: "build.gradle", reason: "Audited Android SDK package contract." }],
  };
  const original = structuredClone(recipe);
  const plan = discover(project(), root, { recipe });
  assert.equal(plan.state, "PLANNED");
  assert.deepEqual(plan.android, recipe.android);
  assert.notEqual(plan.android, recipe.android);
  assert.notEqual(plan.android.platforms, recipe.android.platforms);
  assert.ok(plan.requirements.some((item) => item.name === "android.ndkVersions" && item.value === "27.0.12077973"));
  assert.deepEqual(recipe, original);
  const mismatch = discover(project(), root, { recipe: { ...recipe, commit: "b".repeat(40), buildTool: "gradle" } });
  assert.equal(mismatch.state, "ENV_BLOCKED");
  assert.equal(mismatch.android, undefined);
  assert.equal(mismatch.build.tool, "maven");
});

test("unresolved Android package versions block provisioning rather than guessing SDK packages", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17")) });
  const plan = discover(project(), root, {
    recipe: { commit, constraints: {}, android: { platforms: ["latest"] }, evidence: [] },
  });
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.ok(plan.blockers.some((item) => item.code === "INVALID_ANDROID_RECIPE"));
});

test("numeric Android platform strings normalize to SDK package IDs without mutating recipes", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17")) });
  const recipe = {
    commit, constraints: {}, android: { platforms: ["36", "android-37"], buildTools: [] },
    evidence: [{ path: "build.gradle", line: 12, reason: "Pinned numeric compile SDK declarations." }],
  };
  const original = structuredClone(recipe);
  const plan = discover(project(), root, { recipe });
  assert.equal(plan.state, "PLANNED");
  assert.deepEqual(plan.android, { platforms: ["android-36", "android-37"], buildTools: [] });
  assert.deepEqual(recipe, original);
  assert.equal(plan.java.project.version, "17");
  assert.ok(plan.requirements.some((item) => item.name === "android.platforms" && item.value === "android-36"));
});

test("native Java subproject roots must contain the actual probe", (t) => {
  const { root } = fixture(t, {
    "server/pom.xml": pom(java("21")),
    "server/src/Main.java": "class Main {}",
  });
  const recipe = { commit, scope: "java-subproject", buildRoot: "server", constraints: {}, evidence: [{ path: "server/pom.xml" }] };
  const plan = discover(project(), root, { recipe });
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.ok(plan.blockers.some((item) => item.code === "PROBE_OUTSIDE_BUILD_ROOT"));
  const valid = discover(project({ relativeFile: "server/src/Main.java" }), root, { recipe });
  assert.equal(valid.state, "PLANNED");
  assert.equal(valid.buildRoot, "server");
  assert.equal(valid.scope, "java-subproject");
});

test("synthetic single-file fixtures remain blocked even if a generated POM exists", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17")) });
  const plan = discover(project({ syntheticMavenTargetFile: "src/Main.java" }), root);
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.equal(plan.scope, "synthetic");
  assert.ok(plan.blockers.some((item) => item.code === "SYNTHETIC_NATIVE_COMPARISON"));
});

test("unresolved Maven properties and external parents never silently pass", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`<parent><groupId>external</groupId><artifactId>parent</artifactId><version>1</version>
      <relativePath/></parent>${java("${compiler.version}")}`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((item) => item.code === "EXTERNAL_MAVEN_PARENT"));
  assert.ok(plan.unresolved.some((item) => item.code === "UNRESOLVED_JAVA_VERSION"));
  const refined = discover(project(), root, {
    effectiveMavenModels: [{ path: "pom.xml", xml: pom(java("25")) }],
  });
  assert.equal(refined.state, "PLANNED");
  assert.equal(refined.java.project.version, "25");
  assert.ok(refined.inputHashes.some((item) => item.path === "pom.xml#effective-model"));
  assert.ok(refined.inputHashes.some((item) => item.path === "pom.xml"));
  assert.ok(refined.requirements.some((item) => item.name === "maven.modelApplicability" &&
    item.value === "launcher-qualification-required"));
});

test("annotation-processor artifact versions do not imply executable Java compatibility", (t) => {
  const content = pom(`${java("8")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
    <configuration><annotationProcessorPaths><path>
    <groupId>example.processor</groupId><artifactId>processor</artifactId><version>5.1.1</version>
    </path></annotationProcessorPaths></configuration></plugin></plugins></build>`);
  const { root } = fixture(t, { "pom.xml": content });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.equal(plan.java.project.version, "8");
  assert.ok(plan.unresolved.some((item) => item.code === "ANNOTATION_PROCESSOR_JAVA_UNVERIFIED"));
  const effectiveOnly = discover(project(), root, { effectiveMavenModels: [{ path: "pom.xml", xml: content }] });
  assert.equal(effectiveOnly.state, "ENV_UNVERIFIED");
  assert.ok(effectiveOnly.unresolved.some((item) => item.code === "ANNOTATION_PROCESSOR_JAVA_UNVERIFIED"));
  const sourceOnlyRecipe = discover(project(), root, {
    recipe: { commit, constraints: { projectJavaMin: "17" }, evidence: [{ path: "pom.xml", reason: "Project source uses Java 17." }] },
  });
  assert.equal(sourceOnlyRecipe.state, "ENV_UNVERIFIED");
  assert.ok(sourceOnlyRecipe.unresolved.some((item) => item.code === "ANNOTATION_PROCESSOR_JAVA_UNVERIFIED"));
  const audited = discover(project(), root, {
    recipe: {
      commit, constraints: { projectJavaMin: "25" },
      evidence: [{ path: "pom.xml", reason: "Audited processor source/bytecode requires Java 25." }],
    },
  });
  assert.equal(audited.state, "PLANNED");
  assert.equal(audited.java.project.version, "25");
});

test("an explicitly empty Maven annotation-processor list does not invent a dependency requirement", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("17")}<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
      <configuration><annotationProcessorPaths/></configuration></plugin></plugins></build>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
});

test("native aggregate effective Maven models refine every matching reactor module", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`<packaging>pom</packaging>${java("17")}<modules><module>server</module></modules>`),
    "server/pom.xml": `<project><parent><groupId>example</groupId><artifactId>fixture</artifactId><version>1</version></parent>
      <artifactId>server</artifactId><properties><maven.compiler.release>\${external.release}</maven.compiler.release></properties></project>`,
  });
  const rootModel = pom(`<packaging>pom</packaging>${java("17")}<modules><module>server</module></modules>`);
  const serverModel = pom(java("25")).replace("<artifactId>fixture</artifactId>", "<artifactId>server</artifactId>");
  const plan = discover(project(), root, {
    effectiveMavenModels: [{ path: "pom.xml", xml: `<projects>${rootModel}${serverModel}</projects>` }],
  });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.ok(plan.inputHashes.some((item) => item.path === "server/pom.xml#effective-model"));
});

test("modules inherit active compiler configuration from parent pluginManagement", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`<packaging>pom</packaging><modules><module>module</module></modules><build><pluginManagement><plugins>
      <plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>25</release></configuration></plugin>
      </plugins></pluginManagement></build>`),
    "module/pom.xml": `<project><parent><groupId>example</groupId><artifactId>fixture</artifactId><version>1</version></parent>
      <artifactId>module</artifactId><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId></plugin></plugins></build></project>`,
    "module/src/Main.java": "class Main {}",
  });
  const plan = discover(project({ relativeFile: "module/src/Main.java" }), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.java.build.version, "25");
});

test("a parent outside the selected reactor is inherited, not executed with its pre-override enforcer rules", (t) => {
  const rule = (version) => `<build><plugins><plugin><artifactId>maven-enforcer-plugin</artifactId><executions>
    <execution><id>jdk</id><configuration><rules><requireJavaVersion><version>[${version}]</version>
    </requireJavaVersion></rules></configuration></execution></executions></plugin></plugins></build>`;
  const { root } = fixture(t, {
    "pom.xml": pom(`<packaging>pom</packaging>${rule("25")}`),
    "child/pom.xml": `<project><parent><groupId>example</groupId><artifactId>fixture</artifactId><version>1</version></parent>
      <artifactId>child</artifactId>${java("17")}${rule("17")}</project>`,
    "child/src/Main.java": "class Main {}",
  });
  const plan = discover(project({ relativeFile: "child/src/Main.java" }), root, {
    recipe: { commit, buildRoot: "child", scope: "java-subproject", constraints: {}, evidence: [] },
  });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.build.version, "17");
  assert.ok(plan.inputHashes.some((item) => item.path === "pom.xml"));
});

test("aggregate effective Maven models resolve repository-relative nested build roots", (t) => {
  const rootBody = `<packaging>pom</packaging>${java("17")}<modules><module>child</module></modules>`;
  const childBody = java("${parent.release}");
  const { root } = fixture(t, {
    "app/server/pom.xml": pom(rootBody),
    "app/server/child/pom.xml": pom(childBody).replace("<artifactId>fixture</artifactId>", "<artifactId>child</artifactId>"),
    "app/server/child/src/Main.java": "class Main {}",
  });
  const input = project({ relativeFile: "app/server/child/src/Main.java" });
  const recipe = { commit, buildRoot: "app/server", scope: "java-subproject", constraints: {}, evidence: [] };
  const childModel = pom(java("25")).replace("<artifactId>fixture</artifactId>", "<artifactId>child</artifactId>");
  const plan = discover(input, root, {
    recipe,
    effectiveMavenModels: [{ path: "app/server/pom.xml", xml: `<projects>${pom(rootBody)}${childModel}</projects>` }],
  });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.buildRoot, "app/server");
  const applied = applyEnvironmentPlan(input, plan);
  assert.deepEqual(applied.projectSetup.buildDescriptors.maven, ["app/server/child/pom.xml", "app/server/pom.xml"]);
  assert.deepEqual(plan.java.toolchains.versions, []);
});

test("unrecognized Gradle DSL and future Gradle runtime compatibility stay unverified", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "java { toolchain { languageVersion = computeRequiredJdk() } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-10.0-bin.zip",
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((item) => item.code === "UNRESOLVED_GRADLE_JAVA"));
  assert.ok(plan.unresolved.some((item) => item.code === "UNSUPPORTED_GRADLE_COMPATIBILITY"));
});

test("native Gradle model resolves dynamic toolchains without replacing source evidence", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "java { toolchain { languageVersion = computeRequiredJdk() } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const effectiveGradleModel = {
    gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
    projects: [{ path: ":", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" }],
  };
  const plan = discover(project(), root, { effectiveGradleModel });
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.java.build.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, ["25"]);
  assert.ok(plan.inputHashes.some((item) => item.path === "build.gradle"));
  assert.ok(plan.inputHashes.some((item) => item.path === "gradle-native-model#effective-model"));
  const mismatch = discover(project(), root, { effectiveGradleModel: { ...effectiveGradleModel, gradleVersion: "8.5" } });
  assert.equal(mismatch.state, "ENV_BLOCKED");
  assert.ok(mismatch.blockers.some((item) => item.code === "GRADLE_NATIVE_VERSION_CONFLICT"));
});

test("native Gradle metadata discovers new compiler JDKs without static hints or log guesses", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "plugins { id 'java' }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const input = project();
  const candidate = discover(input, root);
  assert.equal(candidate.state, "ENV_UNVERIFIED");
  assert.equal(candidate.java.project.version, "17");
  const effectiveGradleModel = {
    gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
    projects: [{ path: ":", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" }],
  };
  const original = structuredClone(effectiveGradleModel);
  const refined = discover(input, root, { effectiveGradleModel });
  assert.equal(refined.state, "PLANNED");
  assert.equal(refined.java.project.version, "25");
  assert.equal(refined.java.build.version, "21");
  assert.equal(refined.java.runtime.version, "25");
  assert.deepEqual(refined.java.toolchains.versions, ["25"]);
  assert.deepEqual(effectiveGradleModel, original);
  assert.notDeepEqual(refined.java, candidate.java);
});

test("the full producer schema retains observed compiler evidence without changing default-JVM requirements", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "include 'core'",
    "build.gradle": "plugins { id 'base' }",
    "core/build.gradle": "sourceCompatibility = 17",
    "core/src/Main.java": "class Main {}",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.0-bin.zip",
  });
  const input = project({ relativeFile: "core/src/Main.java" });
  const model = {
    gradleVersion: "9.7.0", buildJavaHome: "C:\\jdks\\21", buildJavaVersion: "21.0.12",
    projects: [{ path: ":core", javaToolchain: null, sourceCompatibility: "17", targetCompatibility: "17" }],
  };
  const requested = discover(input, root, { effectiveGradleModel: model });
  const actual = discover(input, root, {
    effectiveGradleModel: {
      ...model, compiledTargets: [":core:classes"],
      compilers: [{
        task: ":core:compileJava", sourceCompatibility: "17", targetCompatibility: "17",
        compilerHome: "C:\\jdks\\21", compilerVersion: "21.0.12",
      }],
    },
  });
  assert.equal(actual.state, "PLANNED");
  assert.deepEqual(actual.java, requested.java);
  assert.deepEqual(actual.java.toolchains.versions, []);
  assert.ok(actual.requirements.some((item) => item.name === "gradle.observedCompiler" && item.value === "21.0.12"));
  assert.equal(actual.unresolved.some((item) => item.code === "JAVA_PATCH_CONSTRAINT"), false);
});

test("task-specific compiler requests require matching actual task metadata, not project extension defaults", (t) => {
  const { root } = fixture(t, {
    "settings.gradle.kts": "",
    "build.gradle.kts": `java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      sourceCompatibility = JavaVersion.VERSION_17
      tasks.named<JavaCompile>("compileJava") {
        javaCompiler = javaToolchains.compilerFor { languageVersion = requiredCompiler() }
      }`,
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.0-bin.zip",
  });
  const model = {
    gradleVersion: "9.7.0", buildJavaHome: "C:\\jdks\\21", buildJavaVersion: "21.0.12",
    projects: [{ path: ":", javaToolchain: "17", sourceCompatibility: "17", targetCompatibility: "17" }],
  };
  const requested = discover(project(), root, { effectiveGradleModel: model });
  assert.equal(requested.state, "ENV_UNVERIFIED");
  assert.ok(requested.unresolved.some((item) => item.code === "UNRESOLVED_GRADLE_JAVA"));
  const actual = discover(project(), root, {
    effectiveGradleModel: {
      ...model, compiledTargets: [":classes"],
      compilers: [{
        task: ":compileJava", sourceCompatibility: "17", targetCompatibility: "17",
        compilerHome: "C:\\jdks\\25", compilerVersion: "25",
      }],
    },
  });
  assert.equal(actual.state, "PLANNED");
  assert.deepEqual(actual.java.toolchains.versions, ["17", "25"]);
  assert.equal(actual.java.project.version, "25");
  assert.equal(actual.java.build.version, "21");
  assert.equal(actual.java.runtime.version, "25");
  const wrongTask = discover(project(), root, {
    effectiveGradleModel: {
      ...model, compilers: [{
        task: ":compileTestJava", sourceCompatibility: "17", targetCompatibility: "17",
        compilerHome: "C:\\jdks\\25", compilerVersion: "25",
      }],
    },
  });
  assert.equal(wrongTask.state, "ENV_UNVERIFIED");
  assert.ok(wrongTask.unresolved.some((item) => item.code === "UNRESOLVED_GRADLE_JAVA"));
});

test("native daemon observations select compatible candidates without becoming minimum-JDK constraints", (t) => {
  const { root, write } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }\nsourceCompatibility = 17",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const model = {
    gradleVersion: "9.1.0", buildJavaVersion: "17.0.12",
    projects: [{ path: ":", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" }],
  };
  const observed17 = discover(project(), root, { effectiveGradleModel: model });
  assert.equal(observed17.state, "PLANNED");
  assert.equal(observed17.java.build.version, "17");
  assert.equal(observed17.requirements.some((item) => item.name === "java.build" && item.value === "17"), false);
  const observed21 = discover(project(), root, { effectiveGradleModel: { ...model, buildJavaVersion: "21.0.8" } });
  assert.equal(observed21.state, "PLANNED");
  assert.equal(observed21.java.build.version, "21");
  write("gradle/gradle-daemon-jvm.properties", "toolchainVersion=25");
  const conflict = discover(project(), root, { effectiveGradleModel: model });
  assert.equal(conflict.state, "ENV_UNVERIFIED");
  assert.equal(conflict.java.build.version, "25");
  assert.ok(conflict.unresolved.some((item) => item.code === "GRADLE_OBSERVED_BUILD_CONFLICT"));
});

test("native Gradle refinement clears only the matching Java extension field", (t) => {
  const cases = [
    { code: "java { toolchain { languageVersion = requiredJdk() } }", toolchain: null, source: "17", concern: "toolchain" },
    { code: "minimumJavaVersion = requiredMinimum()", toolchain: "25", source: "17", concern: "build" },
    { code: "tasks.withType(JavaCompile) { options.release.set(requiredRelease()) }", toolchain: "25", source: "17", concern: "project" },
    { code: "sourceCompatibility = requiredSource()", toolchain: "25", source: null, concern: "project" },
  ];
  for (const item of cases) {
    const { root } = fixture(t, {
      "settings.gradle": "",
      "build.gradle": item.code,
      "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
    });
    const refined = discover(project(), root, {
      effectiveGradleModel: {
        gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
        projects: [{ path: ":", javaToolchain: item.toolchain, sourceCompatibility: item.source, targetCompatibility: "17" }],
      },
    });
    assert.equal(refined.state, "ENV_UNVERIFIED", item.code);
    assert.ok(refined.unresolved.some((issue) => issue.code === "UNRESOLVED_GRADLE_JAVA" &&
      issue.message.includes(`resolve ${item.concern} Java`)), item.code);
  }
});

test("native root metadata cannot stand in for missing subproject or buildSrc toolchains", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "include 'child'",
    "build.gradle": "plugins { id 'java' }",
    "child/build.gradle": "java { toolchain { languageVersion = requiredChildJdk() } }",
    "buildSrc/build.gradle": "java { toolchain { languageVersion = requiredBuildSrcJdk() } }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const plan = discover(project(), root, {
    effectiveGradleModel: {
      gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
      projects: [{ path: ":", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" }],
    },
  });
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((issue) => issue.code === "UNRESOLVED_GRADLE_JAVA" &&
    issue.evidence.some((item) => item.path === "child/build.gradle")));
  assert.ok(plan.unresolved.some((issue) => issue.code === "UNRESOLVED_GRADLE_JAVA" &&
    issue.evidence.some((item) => item.path === "buildSrc/build.gradle")));
});

test("native subproject extensions resolve shared subproject declarations and preserve every compiler JDK", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "include 'one', 'two'",
    "build.gradle": "subprojects { java { toolchain { languageVersion = requiredJdkFor(project) } } }",
    "one/build.gradle": "plugins { id 'java' }",
    "two/build.gradle": "plugins { id 'java' }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const plan = discover(project(), root, {
    effectiveGradleModel: {
      gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
      projects: [
        { path: ":", javaToolchain: null, sourceCompatibility: null, targetCompatibility: null },
        { path: ":one", javaToolchain: "17", sourceCompatibility: "8", targetCompatibility: "8" },
        { path: ":two", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" },
      ],
    },
  });
  assert.equal(plan.state, "PLANNED");
  assert.deepEqual(plan.java.toolchains.versions, ["17", "25"]);
  assert.equal(plan.java.project.version, "25");
  assert.equal(plan.java.build.version, "21");
  assert.ok(plan.requirements.some((item) => item.name === "gradle.nativeRefinement" &&
    item.evidence.some((entry) => entry.reason?.includes(":two"))));
});

test("native project extensions do not verify dynamic included builds or external scripts", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "includeBuild('build-' + variant)",
    "build.gradle": "apply from: 'https://example.invalid/compiler.gradle'",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const plan = discover(project(), root, {
    effectiveGradleModel: {
      gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
      projects: [{ path: ":", javaToolchain: "25", sourceCompatibility: "17", targetCompatibility: "17" }],
    },
  });
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((issue) => issue.code === "DYNAMIC_GRADLE_MODULES"));
  assert.ok(plan.unresolved.some((issue) => issue.code === "DYNAMIC_GRADLE_SCRIPT"));
});

test("conflicting native extension toolchains need per-task evidence, not a newer guessed build JVM", (t) => {
  const { root } = fixture(t, {
    "settings.gradle": "",
    "build.gradle": "plugins { id 'java' }",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip",
  });
  const plan = discover(project(), root, {
    effectiveGradleModel: {
      gradleVersion: "9.1.0", buildJavaVersion: "21.0.7",
      projects: [{ path: ":", javaToolchain: "17", sourceCompatibility: "25", targetCompatibility: "25" }],
    },
  });
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((issue) => issue.code === "GRADLE_NATIVE_COMPILER_CONFLICT"));
});

test("malformed XML is blocked using an XML parser rather than matching source text", (t) => {
  const { root } = fixture(t, { "pom.xml": "<project><properties><java.version>25</properties></project>" });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_BLOCKED");
  assert.ok(plan.blockers.some((item) => item.code === "INVALID_MAVEN_XML"));
});

test("JDK-activated Maven profiles are inspected and inactive high-JDK alternatives are not forced", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(`${java("17")}<profiles>
    <profile><id>current</id><activation><jdk>[17,22)</jdk></activation>${java("21")}</profile>
    <profile><id>future</id><activation><jdk>[25,)</jdk></activation>${java("25")}</profile>
    </profiles>`) });
  const plan = discover(project(), root);
  assert.equal(plan.java.project.version, "21");
  assert.equal(plan.java.build.version, "21");
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((item) => item.code === "MAVEN_PROFILE_REFINEMENT"));
});

test("Maven profile JDK and property activation are conjunctive, not an automatic legacy Android import", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("8")}<profiles><profile><id>android</id>
      <activation><jdk>[8,9)</jdk><property><name>env.ANDROID_HOME</name></property></activation>
      <modules><module>android</module></modules></profile></profiles>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.ok(plan.unresolved.some((item) => item.code === "CONDITIONAL_MAVEN_PROFILE"));
  assert.equal(plan.unresolved.some((item) => item.code === "MISSING_MAVEN_MODULE"), false);
  assert.equal(plan.requirements.some((item) => item.name === "maven.missingModule"), false);
  const refined = discover(project(), root, { effectiveMavenModels: [{ path: "pom.xml", xml: pom(java("17")) }] });
  assert.equal(refined.state, "PLANNED");
  assert.equal(refined.java.project.version, "17");
});

test("JDK-activated Maven version constraints update the initially selected tool", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(`${java("17")}<profiles>
    <profile><id>modern-maven</id><activation><jdk>[17,)</jdk></activation>
    ${enforcer("<requireMavenVersion><version>[3.9.16,)</version></requireMavenVersion>")}
    </profile></profiles>`) });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "3.9.16");
  assert.equal(plan.build.sha512, undefined);
  assert.deepEqual(plan.requirements.filter((item) => item.name === "maven.selectedVersion").map((item) => item.value), ["3.9.16"]);
});

test("JDK profile unions normalize legacy Java version notation", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("17")}<profiles><profile><id>compatible-jdk</id><activation><jdk>[1.8,1.9),[17,18)</jdk></activation>
      <properties><maven.version>3.9.16</maven.version></properties></profile></profiles>`),
  });
  const plan = discover(project(), root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.build.version, "3.9.16");
  assert.ok(plan.requirements.some((item) => item.name === "maven.activeJdkProfile" && item.value === "compatible-jdk"));
});

test("application clones providers, preserves vendor/OS toolchains and exposes string outputs", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("17")) });
  const input = project();
  input.projectSetup.toolchainJava = {
    versions: ["11", "17"], distribution: "liberica",
    distributionsByOs: { "windows-latest": "zulu", "macos-latest": "liberica" },
  };
  input.projectSetup.checkout = { submodules: true };
  const original = structuredClone(input);
  const plan = discover(input, root);
  const updated = applyEnvironmentPlan(input, plan);
  assert.deepEqual(input, original);
  assert.notEqual(updated, input);
  assert.deepEqual(updated.projectSetup.checkout, input.projectSetup.checkout);
  assert.equal(updated.projectSetup.toolchainJava.distribution, "liberica");
  assert.deepEqual(updated.projectSetup.toolchainJava.distributionsByOs, input.projectSetup.toolchainJava.distributionsByOs);
  assert.deepEqual(updated.projectSetup.providers.jdtls.runtimeJava, updated.projectSetup.providers.oracle.runtimeJava);
  assert.equal(updated.projectSetup.providers.oracle.runtimeJava.distribution, "temurin");
  const outputs = environmentGithubOutputs(plan);
  assert.equal(outputs.toolchainJavaVersions, "11\n17");
  assert.equal(outputs.toolchainJavaDistribution, "zulu");
  assert.equal(outputs.buildRoot, ".");
  assert.ok(Object.values(outputs).every((value) => typeof value === "string" || typeof value === "boolean"));
});

test("preserving extra installed JDKs does not upgrade the source/compiler requirement", (t) => {
  const { root } = fixture(t, { "pom.xml": pom(java("11")) });
  const input = project();
  input.projectSetup.toolchainJava = { versions: ["8", "25"], distribution: "temurin" };
  const plan = discover(input, root);
  assert.equal(plan.state, "PLANNED");
  assert.equal(plan.java.project.version, "11");
  assert.equal(plan.java.build.version, "11");
  assert.equal(plan.java.runtime.version, "21");
  assert.deepEqual(plan.java.toolchains.versions, ["8", "25"]);
});

test("path traversal and module parent cycles fail closed", (t) => {
  const { root } = fixture(t, {
    "pom.xml": pom(`${java("17")}<parent><groupId>example</groupId><artifactId>fixture</artifactId>
      <version>1</version><relativePath>pom.xml</relativePath></parent>`),
  });
  const cycle = discover(project(), root);
  assert.equal(cycle.state, "ENV_BLOCKED");
  assert.ok(cycle.blockers.some((item) => item.code === "MAVEN_PARENT_CYCLE"));
  const outside = discover(project(), root, {
    recipe: { commit, buildRoot: "..", constraints: {}, evidence: [] },
  });
  assert.equal(outside.state, "ENV_BLOCKED");
  assert.ok(outside.blockers.some((item) => item.code === "PATH_OUTSIDE_CHECKOUT"));
});
