const intellijFatalPatterns = [
  ["gradle-build-failed", /\bBUILD FAILED\b/i],
  ["maven-build-failure", /\bBUILD FAILURE\b/i],
  ["import-error", /\[IMPORT ERR\]/i],
  ["failed-to-import", /Failed to import/i],
  ["initialization-failed", /Initialization failed/i],
  ["maven-goal-failed", /Failed to execute goal/i],
  ["dependency-resolution-failed", /Could not resolve dependencies/i],
  ["artifact-missing", /Could not find artifact/i],
];

const jdtlsFatalPatterns = [
  ["initialization-failed", /Initialization failed/i],
  ["failed-to-import", /Failed to import projects?/i],
  [
    "buildship-import-exception",
    /Buildship[^\r\n]*(?:terminated|failed|exception)/i,
  ],
];

function matchingNames(content, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}

function updatedFileCount(content) {
  return [...content.matchAll(/Updated\s+(\d+)\s+files?/gi)]
    .map((match) => Number(match[1]))
    .reduce((maximum, count) => Math.max(maximum, count), 0);
}

export function analyzeProviderLog(provider, content = "") {
  const text = String(content);
  if (provider === "jdtls") {
    const initializationCompleted =
      text.includes(">> initialization job finished") ||
      text.includes("Workspace initialized");
    const buildJobsFinished = text.includes(">> build jobs finished");
    const bspClasspathsUpdated =
      /Updating classpaths for \d+ projects? \(\d+ build targets?\) using batched BSP calls\./
        .test(text);
    const fatalLogMatches = matchingNames(text, jdtlsFatalPatterns);
    const nativeCompletionMatches = [
      ...(initializationCompleted ? ["initialization-completed"] : []),
      ...(buildJobsFinished ? ["build-jobs-finished"] : []),
    ];
    return {
      fatalLogMatches,
      nativeCompletionMatches,
      nativeCompleted: initializationCompleted && buildJobsFinished,
      initializationCompleted,
      buildJobsFinished,
      bspClasspathsUpdated,
      updatedFileCount: 0,
      importStarted: initializationCompleted || bspClasspathsUpdated,
      functionalCandidate: false,
      lastObservation: buildJobsFinished
        ? "build-jobs-finished"
        : initializationCompleted
          ? "initialization-finished"
          : bspClasspathsUpdated
            ? "bsp-classpaths-updated"
            : "waiting-for-workspace",
    };
  }

  const fatalLogMatches = matchingNames(text, intellijFatalPatterns);
  const successfullyImported = /Successfully imported\s+/i.test(text);
  const workspaceModelSaved = /Workspace model cache saved/i.test(text);
  const filesUpdated = updatedFileCount(text);
  const importStarted = /\[IMPORT (?:STD|PROGRESS|ERR)\]/i.test(text);
  const nativeCompletionMatches = [
    ...(successfullyImported ? ["successfully-imported"] : []),
    ...(workspaceModelSaved ? ["workspace-model-cache-saved"] : []),
  ];
  return {
    fatalLogMatches,
    nativeCompletionMatches,
    nativeCompleted: successfullyImported && workspaceModelSaved,
    initializationCompleted: false,
    buildJobsFinished: false,
    bspClasspathsUpdated: false,
    updatedFileCount: filesUpdated,
    importStarted,
    functionalCandidate: filesUpdated > 0 && !importStarted,
    lastObservation: successfullyImported && workspaceModelSaved
      ? "workspace-import-completed"
      : workspaceModelSaved
        ? "workspace-model-saved"
        : successfullyImported
          ? "workspace-imported"
          : filesUpdated > 0
            ? "analyzer-files-updated"
            : importStarted
              ? "import-in-progress"
              : "waiting-for-project-import",
  };
}
