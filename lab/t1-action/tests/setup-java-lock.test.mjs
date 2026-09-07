import assert from "node:assert/strict";
import test from "node:test";
import { lockedSetupJavaVersion, setupJavaPackageVersion } from "../environment-toolchains.mjs";

test("four-component runtime versions replay using the installer's package identifier", () => {
  const version = setupJavaPackageVersion(
    "/Users/runner/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.12-101.0/arm64/Contents/Home",
    "/Users/runner/hostedtoolcache", "darwin",
  );
  assert.equal(version, "21.0.12+101.0");
  assert.equal(lockedSetupJavaVersion({
    role: "project", exactVersion: "21.0.12.1", setupJavaVersion: version,
  }), version);
  assert.throws(() => lockedSetupJavaVersion({ role: "project", exactVersion: "21.0.12.1" }), /Missing valid/);
  assert.throws(() => lockedSetupJavaVersion({ role: "project", setupJavaVersion: "21.0.12.1" }), /Missing valid/);
});

test("Java 8 and Windows compiler toolchains retain installer build numbers", () => {
  assert.equal(setupJavaPackageVersion(
    "C:\\hostedtoolcache\\windows\\Java_Zulu_jdk\\8.0.472-8\\x64",
    "C:\\hostedtoolcache\\windows", "win32",
  ), "8.0.472+8");
  assert.equal(setupJavaPackageVersion(
    "/cache/Java_Temurin-Hotspot_jdk/26.0.0-ea.35/arm64/Contents/Home", "/cache", "darwin",
  ), "26.0.0+35-ea");
  assert.throws(() => setupJavaPackageVersion("/elsewhere/jdk", "/cache", "darwin"), /not an identifiable/);
});
