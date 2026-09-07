import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJavaPackageVersion } from "../java-package-catalog.mjs";
import { createProjectSettings } from "../project-environment.mjs";

const release = (version) => ({
  version_data: { semver: version },
  binaries: [{ architecture: "aarch64", os: "mac", image_type: "jdk" }],
});
const resolve = (versions, extra = {}) => canonicalJavaPackageVersion({
  version: "21.0.12+101.0", distribution: "temurin", platform: "darwin", architecture: "arm64",
  fetchCatalog: async (url) => {
    assert.match(url, /feature_releases\/21\/ga/);
    assert.match(url, /architecture=aarch64/);
    return new Response(JSON.stringify(versions.map(release)));
  },
  ...extra,
});

test("catalog identity restores LTS metadata missing from hosted JDK cache names", async () => {
  assert.equal(await resolve(["21.0.12+8.0.LTS", "21.0.12+101.0.LTS"]), "21.0.12+101.0.LTS");
  assert.equal(await resolve(["21.0.12+101.0.LTS"], { version: "21.0.12+101.0.LTS" }), "21.0.12+101.0.LTS");
});

test("a different build, missing package or ambiguous identity never falls back to latest", async () => {
  await assert.rejects(resolve(["21.0.12+8.0.LTS"]), /No catalog package/);
  await assert.rejects(resolve([]), /No catalog package/);
  await assert.rejects(resolve(["21.0.12+101.0", "21.0.12+101.0.LTS"]), /Ambiguous/);
  await assert.rejects(resolve([], { fetchCatalog: async () => new Response("", { status: 503 }) }), /HTTP 503/);
});

test("other distributions retain their package identifiers without a Temurin lookup", async () => {
  assert.equal(await canonicalJavaPackageVersion({
    version: "8.0.512+8", distribution: "zulu",
    fetchCatalog: () => { throw new Error("Unexpected catalog request"); },
  }), "8.0.512+8");
});

test("qualified Java 26 disables only incompatible JDT AppCDS, not project SDK or Lombok support", () => {
  const project = {
    projectSetup: { buildTool: "maven", providers: { jdtls: {
      projectJava: { version: "26", distribution: "temurin" },
      runtimeJava: { version: "26", distribution: "temurin", source: "setup-java" },
      vscodeSettings: {},
    } } },
  };
  const environment = {
    T1_REQUIRE_ENVIRONMENT_READY: "1", T1_PROJECT_JAVA_HOME: "C:\\jdk26",
    T1_LANGUAGE_SERVER_JAVA_HOME: "C:\\jdk26",
  };
  const settings = createProjectSettings(project, "jdtls", {}, environment);
  assert.equal(settings["java.jdt.ls.appcds.enabled"], "off");
  assert.equal(settings["java.jdt.ls.java.home"], "C:\\jdk26");
  assert.equal(settings["java.configuration.runtimes"][0].name, "JavaSE-26");
  assert.equal(settings["java.jdt.ls.lombokSupport.enabled"], undefined);
  assert.equal(createProjectSettings(project, "jdtls", {}, {
    ...environment, T1_REQUIRE_ENVIRONMENT_READY: "0",
  })["java.jdt.ls.appcds.enabled"], undefined);
});
