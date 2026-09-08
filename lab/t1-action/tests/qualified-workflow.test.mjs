import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative) => yaml.load(fs.readFileSync(path.join(root, relative), "utf8"));

test("comparison qualifies project environments before independent provider jobs", () => {
  const workflow = read(".github/workflows/t1-jdtls-oracle.yml");
  assert.ok(workflow.jobs.prepare.outputs.qualification_matrix);
  assert.equal(workflow.jobs.qualify.uses, "./.github/workflows/t1-environment-qualification.yml");
  assert.ok(workflow.jobs.compare.needs.includes("qualify"));
  assert.equal(workflow.jobs.compare.env.T1_REQUIRE_ENVIRONMENT_READY, "1");
  const steps = workflow.jobs.compare.steps;
  const install = steps.findIndex((step) => step.id === "environment");
  const replay = steps.findIndex((step) => step.run?.includes("--phase replay"));
  const launch = steps.findIndex((step) => step.run?.includes("run-t1-autotest.mjs"));
  assert.equal(steps[install].with.locked, "true");
  assert.ok(install < replay && replay < launch);
  assert.ok(!steps.some((step) => step.with?.["java-version"]?.includes("matrix.environment")));
});

test("qualification preserves blocked and failed evidence instead of requiring provider startup", () => {
  const workflow = read(".github/workflows/t1-environment-qualification.yml");
  const steps = workflow.jobs.qualify.steps;
  assert.ok(steps.find((step) => step.id === "discover")?.run.includes("--phase discover"));
  assert.ok(steps.find((step) => step.id === "refine")?.run.includes("--phase refine"));
  assert.ok(steps.some((step) => step.run?.includes("--phase qualify")));
  assert.ok(steps.some((step) => step.if === "always()" && step.run?.includes("--phase record-failure")));
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(!steps.some((step) => step.run?.includes("run-t1-autotest")));
});

test("environment installation uses plan or lock outputs for all Java roles", () => {
  const action = read(".github/actions/t1-environment/action.yml");
  const javaSteps = action.runs.steps.filter((step) => step.uses === "actions/setup-java@v5");
  assert.equal(javaSteps.length, 5);
  for (const step of javaSteps) {
    assert.match(step.if, /ENV_BLOCKED/);
    assert.match(step.with["java-version"], /steps\.plan\.outputs\./);
    assert.equal(step.with["overwrite-settings"], false);
  }
  assert.ok(action.runs.steps.some((step) => step.run?.includes("--role build")));
  assert.ok(action.runs.steps.some((step) => step.run?.includes("--role runtime")));
  assert.ok(action.runs.steps.some((step) => step.run?.includes("--role project")));
});

test("configured-source is opt-in and its mode reaches qualification and both provider jobs", () => {
  const comparison = read(".github/workflows/t1-jdtls-oracle.yml");
  const qualification = read(".github/workflows/t1-environment-qualification.yml");
  assert.equal(comparison.on.workflow_dispatch.inputs.environment_mode.default, "prebuilt-workspace");
  assert.ok(comparison.on.workflow_dispatch.inputs.environment_mode.options.includes("configured-source"));
  assert.match(comparison.jobs.qualify.with.environment_mode, /inputs\.environment_mode/);
  assert.match(comparison.jobs.compare.env.T1_ENVIRONMENT_MODE, /inputs\.environment_mode/);
  assert.match(qualification.jobs.qualify.env.T1_ENVIRONMENT_MODE, /inputs\.environment_mode/);
  const matrix = comparison.jobs.prepare.steps.find((step) => step.id === "matrix");
  assert.match(matrix.env.T1_ENVIRONMENT_MODE, /inputs\.environment_mode/);
});
