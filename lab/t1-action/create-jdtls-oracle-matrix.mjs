import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMatrixEntries,
  excludeMatrixEntries,
  loadProjects,
} from "./create-matrix.mjs";

const comparisonProviders = ["jdtls", "oracle"];
const supportedOperatingSystems = ["windows-latest", "macos-latest"];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function appendOutput(file, name, value) {
  fs.appendFileSync(file, `${name}=${JSON.stringify(value)}\n`);
}

function javaFileCount(project) {
  const value = Number(project.projectSetup?.corpusEvidence?.javaFileCount);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function selectComparisonProjects(
  projects,
  requestedProjects = "",
  projectCount = 10,
) {
  if (!Number.isInteger(projectCount) || projectCount < 1 || projectCount > 100) {
    throw new Error(`Project count must be from 1 through 100: ${projectCount}`);
  }
  const eligible = projects.filter((project) => project.t1Eligible);
  const requestedIds = requestedProjects
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requestedIds.length > 0) {
    const byId = new Map(eligible.map((project) => [project.id, project]));
    const unknown = requestedIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown comparison project(s): ${unknown.join(", ")}`);
    }
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new Error("Comparison project ids must be unique.");
    }
    return requestedIds.map((id) => byId.get(id));
  }
  return eligible
    .sort((left, right) => {
      const dismissedDifference =
        Number(left.projectSetup?.csvBaseline?.dismissed === true) -
        Number(right.projectSetup?.csvBaseline?.dismissed === true);
      return dismissedDifference ||
        javaFileCount(left) - javaFileCount(right) ||
        left.id.localeCompare(right.id);
    })
    .slice(0, projectCount);
}

export function createComparisonMatrix({
  projects,
  requestedProjects = "",
  projectCount = 10,
  operatingSystem = "windows-latest",
  exclusions = "",
}) {
  const selectedProjects = selectComparisonProjects(
    projects,
    requestedProjects,
    projectCount,
  );
  const operatingSystems = operatingSystem === "all"
    ? supportedOperatingSystems
    : [operatingSystem];
  if (
    operatingSystem !== "all" &&
    !supportedOperatingSystems.includes(operatingSystem)
  ) {
    throw new Error(`Unknown OS: ${operatingSystem}`);
  }
  const allEntries = createMatrixEntries(
    selectedProjects,
    comparisonProviders,
    operatingSystems,
  );
  return {
    selectedProjects,
    allEntries,
    matrixEntries: excludeMatrixEntries(allEntries, exclusions),
  };
}

function main() {
  const projectCount = Number(argument("--project-count", "10"));
  const requestedProjects = argument("--projects", "");
  const operatingSystem = argument("--os", "windows-latest");
  const exclusions = argument("--exclude", "");
  const outputFile = argument("--github-output", process.env.GITHUB_OUTPUT);
  const summaryFile = argument("--summary", process.env.GITHUB_STEP_SUMMARY);
  const result = createComparisonMatrix({
    projects: loadProjects(),
    requestedProjects,
    projectCount,
    operatingSystem,
    exclusions,
  });
  if (!outputFile) {
    throw new Error("GitHub output path was not provided.");
  }
  appendOutput(
    outputFile,
    "projects",
    result.selectedProjects.map((project) => ({
      id: project.id,
      javaFiles: javaFileCount(project),
    })),
  );
  appendOutput(outputFile, "matrix", { include: result.matrixEntries });
  if (summaryFile) {
    fs.appendFileSync(
      summaryFile,
      [
        "## JDT LS and Oracle comparison selection",
        "",
        `Selected ${result.selectedProjects.length} project(s), ` +
          `${comparisonProviders.length} provider(s), and ` +
          `${new Set(result.matrixEntries.map((entry) => entry.os)).size} OS image(s).`,
        `Generated ${result.matrixEntries.length} run(s); ` +
          `${result.allEntries.length - result.matrixEntries.length} excluded.`,
        "",
        "| Project | Java files |",
        "|---|---:|",
        ...result.selectedProjects.map(
          (project) => `| ${project.id} | ${javaFileCount(project)} |`,
        ),
        "",
      ].join("\n"),
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
