import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Gradle preflight tolerates a non-Java included build but rejects an empty primary build", {
  skip: process.env.T1_GRADLE_PREFLIGHT_TEST !== "1",
  timeout: 180_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-gradle-preflight-"));
  try {
    const write = (file, content) => {
      const destination = path.join(root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    };
    write("settings.gradle", "rootProject.name = 'main'\nincludeBuild('constraints')\n");
    write("build.gradle", "plugins { id 'java' }\ndependencies { implementation platform('fixture:constraints:1') }\n");
    write("src/main/java/Probe.java", "class Probe {}\n");
    write("constraints/settings.gradle", "rootProject.name = 'constraints'\n");
    write("constraints/build.gradle", "plugins { id 'java-platform' }\ngroup = 'fixture'\nversion = '1'\n");
    const model = path.join(root, "environment.json");
    const run = (cwd) => spawnSync(process.platform === "win32" ? "gradle.exe" : "gradle", [
      "--offline", "--no-daemon", "--console=plain", "--max-workers=2",
      "--init-script", path.resolve(import.meta.dirname, "../environment-preflight.init.gradle"),
      `-Dt1.environment.model=${model}`, "t1EnvironmentValidate",
    ], { cwd, encoding: "utf8", timeout: 80_000 });
    const qualified = run(root);
    assert.equal(qualified.status, 0, `${qualified.stdout}\n${qualified.stderr}\n${qualified.error ?? ""}`);
    const evidence = JSON.parse(fs.readFileSync(model, "utf8"));
    assert.deepEqual(evidence.compiledTargets, [":classes"]);
    assert.ok(evidence.compilers.some((compiler) => compiler.task === ":compileJava"));
    const unqualified = run(path.join(root, "constraints"));
    assert.notEqual(unqualified.status, 0);
    assert.match(`${unqualified.stdout}\n${unqualified.stderr}`, /requires an explicit native compilation target/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
