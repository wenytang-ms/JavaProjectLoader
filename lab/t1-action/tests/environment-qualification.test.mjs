import assert from "node:assert/strict";
import test from "node:test";
import { applyJavaPlatformPolicy } from "../environment-toolchains.mjs";
import {
  nativeCompilerCompatibility,
  resolveNativeCompilerRequirements,
  verifyNativeCompilerRequirements,
} from "../environment-qualification.mjs";

const plan = {
  state: "ENV_UNVERIFIED", build: { tool: "maven" }, blockers: [], requirements: [], inputHashes: [],
  unresolved: [{ code: "ANNOTATION_PROCESSOR_JAVA_UNVERIFIED", evidence: [{ path: "pom.xml" }] }],
};
const observation = (extraConfiguration = "") => ({
  nativeResult: { successful: true, args: ["test-compile", "-DskipTests"] },
  nativeLog: "[INFO] Compiling 20 source files with javac [release 25]",
  javaInstallations: ["project", "build", "runtime"].map((role) => ({
    role, exactVersion: "25.0.4.1", releaseSha256: "release", executableSha256: "java", compilerSha256: "javac",
  })),
  effectiveMavenModels: [{
    path: "pom.xml",
    xml: `<projects><project><groupId>example</groupId><artifactId>app</artifactId><version>1</version>
      <build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version>
      <configuration><release>25</release><annotationProcessorPaths><path>
      <groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.40</version>
      </path></annotationProcessorPaths>${extraConfiguration}</configuration>
      </plugin></plugins></build></project></projects>`,
  }],
});

test("successful native compiler proof can establish compatibility without inventing a processor minimum", () => {
  const observed = observation();
  const resolved = resolveNativeCompilerRequirements(plan, observed);
  assert.equal(resolved.state, "PLANNED");
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.requirements[0].value.minimumJavaVersionInferred, false);
  assert.equal(plan.state, "ENV_UNVERIFIED");
  assert.equal(verifyNativeCompilerRequirements(resolved, observed).verified, true);
  observed.effectiveMavenModels[0].xml = observed.effectiveMavenModels[0].xml.replace("1.18.40", "1.18.42");
  assert.equal(verifyNativeCompilerRequirements(resolved, observed).verified, false);
});

test("native proof never clears unrelated environment uncertainty", () => {
  const mixed = { ...plan, unresolved: [...plan.unresolved, { code: "UNRESOLVED_BUILD_JAVA" }] };
  const resolved = resolveNativeCompilerRequirements(mixed, observation());
  assert.equal(resolved.state, "ENV_UNVERIFIED");
  assert.deepEqual(resolved.unresolved.map((item) => item.code), ["UNRESOLVED_BUILD_JAVA"]);
});

test("property-selected compilers and non-javac execution cannot certify javac processors", () => {
  const alternate = observation();
  alternate.effectiveMavenModels[0].xml = alternate.effectiveMavenModels[0].xml.replace(
    "<build>", "<properties><maven.compiler.compilerId>eclipse</maven.compiler.compilerId></properties><build>",
  );
  assert.equal(nativeCompilerCompatibility(alternate).verified, false);
  for (const line of [
    "[INFO] Compiling 3 source files with eclipse",
    "[INFO] Compiling 3 source files with forked javac",
    "[INFO] Compiling 3 source files to target/classes",
  ]) {
    const mixed = observation();
    mixed.nativeLog += `\n${line}`;
    assert.equal(nativeCompilerCompatibility(mixed).verified, false);
  }
});

for (const configuration of [
  "<fork>true</fork>", "<executable>/different/javac</executable>",
  "<jdkToolchain><version>26</version></jdkToolchain>", "<proc>none</proc>", "<compilerId>eclipse</compilerId>",
  "<skipMain>true</skipMain>", "<compilerArgs><arg>-proc:none</arg></compilerArgs>",
]) {
  test(`native proof rejects unobserved or disabled compiler execution: ${configuration}`, () => {
    assert.equal(nativeCompilerCompatibility(observation(configuration)).verified, false);
    assert.equal(resolveNativeCompilerRequirements(plan, observation(configuration)), plan);
  });
}

test("native proof requires actual compilation and identical JDKs, not help success or matching majors", () => {
  for (const mutate of [
    (value) => { value.nativeResult.successful = false; },
    (value) => { value.nativeResult.args = ["help:effective-pom"]; },
    (value) => { value.nativeLog = "Nothing to compile"; },
    (value) => { value.javaInstallations[2].executableSha256 = "different"; },
    (value) => { value.javaInstallations.pop(); },
  ]) {
    const observed = observation();
    mutate(observed);
    assert.equal(nativeCompilerCompatibility(observed).verified, false);
  }
});

test("macOS ARM64 Java 8 policy preserves versions and the separate Gradle build JVM", () => {
  const original = {
    requirements: [], java: {
      project: { version: "8", distribution: "temurin" },
      build: { version: "11", distribution: "temurin" },
      runtime: { version: "21", distribution: "temurin" },
    },
  };
  const configured = applyJavaPlatformPolicy(original, { platform: "darwin", architecture: "arm64" });
  assert.deepEqual(configured.java.project, { version: "8", distribution: "zulu" });
  assert.deepEqual(configured.java.build, original.java.build);
  assert.deepEqual(configured.java.runtime, original.java.runtime);
  assert.equal(configured.requirements.length, 1);
  assert.equal(original.java.project.distribution, "temurin");
  assert.equal(applyJavaPlatformPolicy(original, { platform: "win32", architecture: "x64" }), original);
  assert.equal(applyJavaPlatformPolicy(original, { platform: "darwin", architecture: "x64" }), original);
});
