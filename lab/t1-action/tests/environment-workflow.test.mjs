import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjects } from "../create-matrix.mjs";

const project = loadProjects().find((entry) => entry.id === "supertokens-core");
const workflow = path.resolve(import.meta.dirname, "../environment-workflow.mjs");

for (const wrapperPath of [undefined, "gradle/wrapper/gradle-wrapper.properties"]) {
  test(`installation outputs derive bootstrap and Android tools from the plan (${wrapperPath ?? "no wrapper"})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t1-plan-outputs-"));
    try {
      const plan = {
        schemaVersion: 1, project: project.id, commit: project.commit,
        operatingSystem: "windows-latest", scope: "native", buildRoot: ".", state: "PLANNED",
        java: {
          project: { version: "17", distribution: "temurin" },
          build: { version: "17", distribution: "temurin" },
          runtime: { version: "21", distribution: "temurin" },
          toolchains: { versions: [], distribution: "temurin" },
        },
        build: { tool: "gradle", version: "8.4", wrapperPath },
        android: { platforms: [], buildTools: [], ndkVersions: ["27.0.12077973"] },
      };
      fs.writeFileSync(path.join(root, "environment-plan.json"), JSON.stringify(plan));
      const outputs = path.join(root, "outputs");
      const result = spawnSync(process.execPath, [
        workflow, "--phase", "load", "--project", project.id, "--os", plan.operatingSystem,
        "--directory", root, "--locked", "false",
      ], {
        env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_ENV: path.join(root, "environment") },
        encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
      const emitted = fs.readFileSync(outputs, "utf8");
      assert.match(emitted, new RegExp(`bootstrapGradleVersion<<[^\\n]+\\n${wrapperPath ? "" : "8\\.4"}\\n`));
      assert.match(emitted, /requiresAndroidSdk<<[^\n]+\ntrue\n/);
      assert.match(emitted, /runtimeJavaVersion<<[^\n]+\n21\n/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
