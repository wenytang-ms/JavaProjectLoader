import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProjectSetup } from "./project-environment.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectsPath = path.resolve(scriptDir, "..", "t1-projects.json");
const environmentsPath = path.resolve(
  scriptDir,
  "..",
  "t1-project-environments.json",
);

export function loadProjectEnvironments() {
  const document = JSON.parse(fs.readFileSync(environmentsPath, "utf8"));
  if (document.schemaVersion !== 1 || !Array.isArray(document.projects)) {
    throw new Error("T1 project environments require schemaVersion 1 and projects.");
  }
  if (
    !Number.isInteger(document.selection?.targetCaseCount) ||
    document.selection.targetCaseCount !== document.projects.length
  ) {
    throw new Error(
      "T1 project environment selection count must match the configured projects.",
    );
  }
  const environments = new Map();
  for (const environment of document.projects) {
    if (!environment.id || environments.has(environment.id)) {
      throw new Error(`Invalid or duplicate project environment id: ${environment.id}`);
    }
    if (
      typeof environment.csvBaseline?.projectType !== "string" ||
      typeof environment.csvBaseline?.dismissed !== "boolean"
    ) {
      throw new Error(
        `Environment contract ${environment.id} requires a CSV baseline.`,
      );
    }
    environments.set(environment.id, environment);
  }
  return environments;
}

export function loadProjects() {
  const projects = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  const environments = loadProjectEnvironments();
  const ids = new Set();

  for (const project of projects) {
    if (!project.id || !project.repository || !project.commit) {
      throw new Error("Every T1 project requires id, repository, and commit.");
    }
    if (ids.has(project.id)) {
      throw new Error(`Duplicate T1 project id: ${project.id}`);
    }
    if (!Number.isInteger(project.batch) || project.batch < 1 || project.batch > 4) {
      throw new Error(`Project ${project.id} requires a batch from 1 through 4.`);
    }
    ids.add(project.id);
    const projectSetup = environments.get(project.id);
    if (projectSetup) {
      if (
        projectSetup.repository !== project.repository ||
        projectSetup.commit !== project.commit
      ) {
        throw new Error(
          `Environment contract for ${project.id} does not match its repository and commit.`,
        );
      }
      project.projectSetup = projectSetup;
    }

    if (project.t1Eligible) {
      for (const field of ["relativeFile", "sourceSymbol", "javaVersion", "timeoutSeconds"]) {
        if (!project[field]) {
          throw new Error(`Eligible project ${project.id} is missing ${field}.`);
        }
      }
      validateProjectSetup(project);
    } else if (!project.reason) {
      throw new Error(`Ineligible project ${project.id} requires a reason.`);
    }
  }

  for (const environmentId of environments.keys()) {
    if (!ids.has(environmentId)) {
      throw new Error(
        `Environment contract ${environmentId} has no matching T1 project.`,
      );
    }
  }

  return projects;
}

function matrixEnvironment(project, provider) {
  const providerSetup = project.projectSetup?.providers?.[provider];
  if (!providerSetup) {
    return {
      configured: false,
      projectJavaVersion: String(project.javaVersion ?? "21"),
      projectJavaDistribution: "temurin",
      runtimeJavaSource: provider === "jdtls" ? "setup-java" : "bundled",
      runtimeJavaVersion: provider === "jdtls"
        ? String(project.javaVersion ?? "21")
        : "",
      runtimeJavaDistribution: provider === "jdtls" ? "temurin" : "",
      toolchainJavaVersions: "",
      toolchainJavaDistribution: "",
      buildTool: "",
    };
  }

  const environment = {
    configured: true,
    projectJavaVersion: providerSetup.projectJava.version,
    projectJavaDistribution: providerSetup.projectJava.distribution,
    runtimeJavaSource: providerSetup.runtimeJava.source,
    runtimeJavaVersion: providerSetup.runtimeJava.version ?? "",
    runtimeJavaDistribution: providerSetup.runtimeJava.distribution ?? "",
    toolchainJavaVersions:
      project.projectSetup.toolchainJava?.versions?.join("\n") ?? "",
    toolchainJavaDistribution:
      project.projectSetup.toolchainJava?.distribution ?? "",
    buildTool: project.projectSetup.buildTool,
  };
  if (project.projectSetup.androidSdk) {
    environment.requiresAndroidSdk = true;
  }
  return environment;
}

export function createMatrixEntries(projects, providers, operatingSystems) {
  return projects.flatMap((project) =>
    providers.flatMap((provider) =>
      operatingSystems.map((os) => ({
        project: {
          id: project.id,
          javaVersion: project.javaVersion ?? "21",
        },
        provider,
        os,
        environment: matrixEnvironment(project, provider),
      })),
    ),
  );
}

export function excludeMatrixEntries(entries, requestedExclusions = "") {
  const exclusions = requestedExclusions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (exclusions.length === 0) {
    return entries;
  }
  const available = new Set(
    entries.map(
      (entry) => `${entry.project.id}:${entry.provider}:${entry.os}`,
    ),
  );
  for (const exclusion of exclusions) {
    if (!available.has(exclusion)) {
      throw new Error(`Unknown excluded case: ${exclusion}`);
    }
  }
  const excluded = new Set(exclusions);
  return entries.filter(
    (entry) =>
      !excluded.has(`${entry.project.id}:${entry.provider}:${entry.os}`),
  );
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function selectValues(requested, allValues, label) {
  if (requested === "all") {
    return allValues;
  }
  if (!allValues.includes(requested)) {
    throw new Error(`Unknown ${label}: ${requested}`);
  }
  return [requested];
}

function appendOutput(file, name, value) {
  fs.appendFileSync(file, `${name}=${JSON.stringify(value)}\n`);
}

function main() {
  const projects = loadProjects();
  if (process.argv.includes("--validate")) {
    console.log(`Validated ${projects.length} T1 project entries.`);
    return;
  }

  const requestedProject = argument("--project", "all");
  const requestedProvider = argument("--provider", "all");
  const requestedOs = argument("--os", "all");
  const requestedBatch = Number(argument("--batch", "1"));
  const requestedExclusions = argument("--exclude", "");
  const outputFile = argument("--github-output", process.env.GITHUB_OUTPUT);
  const summaryFile = argument("--summary", process.env.GITHUB_STEP_SUMMARY);

  if (!Number.isInteger(requestedBatch) || requestedBatch < 1 || requestedBatch > 4) {
    throw new Error(`Unknown batch: ${requestedBatch}`);
  }
  const selectedProjects = requestedProject === "all"
    ? projects.filter(
        (project) =>
          project.t1Eligible &&
          project.projectSetup &&
          project.batch === requestedBatch,
      )
    : projects.filter((project) => project.id === requestedProject);
  if (selectedProjects.length === 0) {
    throw new Error(`Unknown project: ${requestedProject}`);
  }

  const matrixProjects = selectedProjects.map((project) => ({
    id: project.id,
    javaVersion: project.javaVersion ?? "21",
  }));
  const providers = selectValues(requestedProvider, ["jdtls", "intellij"], "provider");
  const operatingSystems = selectValues(
    requestedOs,
    ["windows-latest", "macos-latest"],
    "OS",
  );

  if (!outputFile) {
    throw new Error("GitHub output path was not provided.");
  }
  appendOutput(outputFile, "projects", matrixProjects);
  appendOutput(outputFile, "providers", providers);
  appendOutput(outputFile, "operating_systems", operatingSystems);
  appendOutput(outputFile, "batch", requestedBatch);
  const allEntries = createMatrixEntries(
    selectedProjects,
    providers,
    operatingSystems,
  );
  const matrixEntries = excludeMatrixEntries(
    allEntries,
    requestedExclusions,
  );
  appendOutput(outputFile, "matrix", {
    include: matrixEntries,
  });

  if (summaryFile) {
    const notApplicable = projects.filter((project) => !project.t1Eligible);
    const lines = [
      "## T1 project selection",
      "",
      `Selected batch ${requestedBatch}: ${matrixProjects.length} project(s), ${providers.length} provider(s), and ${operatingSystems.length} OS image(s).`,
      `Generated ${matrixEntries.length} case(s); excluded ${allEntries.length - matrixEntries.length}.`,
      "",
      "Projects without Java source are retained in `lab/t1-projects.json` but excluded from the default matrix:",
      ...notApplicable.map((project) => `- \`${project.id}\`: ${project.reason}`),
      "",
    ];
    fs.appendFileSync(summaryFile, lines.join("\n"));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
