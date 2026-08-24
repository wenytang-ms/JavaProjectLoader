const intellijFatalPatterns = [
  ["gradle-build-failed", /\bBUILD FAILED\b/i],
  ["maven-build-failure", /\bBUILD FAILURE\b/i],
  [
    "import-stderr-failure",
    /\[IMPORT ERR\]\s*:\s*(?:(?:ERROR|FATAL)\b|[^\r\n]*(?:exception|non-zero exit))/i,
  ],
  ["failed-to-import", /Failed to import/i],
  ["initialization-failed", /Initialization failed/i],
  ["maven-goal-failed", /Failed to execute goal/i],
  ["dependency-resolution-failed", /Could not resolve dependencies/i],
  ["artifact-missing", /\[ERROR\][^\r\n]*Could not find artifact/i],
];

const jdtlsFatalPatterns = [
  ["initialization-failed", /Initialization failed/i],
  ["failed-to-import", /Failed to import projects?/i],
  [
    "buildship-import-exception",
    /Buildship[^\r\n]*(?:terminated|failed|exception)/i,
  ],
];

const buildOutputFatalPatterns = [
  [
    "gradle-build-failed",
    /(?:\bBUILD FAILED\b|\bCONFIGURE FAILED\b|FAILURE:\s*Build failed with an exception)/i,
  ],
  ["maven-build-failure", /\bBUILD FAILURE\b/i],
  ["maven-goal-failed", /\[ERROR\][^\r\n]*Failed to execute goal/i],
  [
    "dependency-resolution-failed",
    /\[ERROR\][^\r\n]*Could not resolve dependencies/i,
  ],
  [
    "build-action-failed",
    /\[error\][^\r\n]*(?:supplied build action|error getting build)[^\r\n]*failed with an exception/i,
  ],
];

const providerStatusFatalPatterns = {
  jdtls: [
    ["java-warning", /Java:\s*Warning/i],
    ["java-error", /Java:\s*Error/i],
    ["gradle-build-error", /Gradle:\s*Build Error/i],
    ["maven-build-error", /Maven:\s*Build Error/i],
  ],
  intellij: [
    ["gradle-build-error", /Gradle:\s*Build Error/i],
    ["maven-build-error", /Maven:\s*Build Error/i],
  ],
};

function matchingNames(content, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}

export function analyzeBuildOutput(content = "") {
  return matchingNames(String(content), buildOutputFatalPatterns);
}

export function analyzeProviderStatus(provider, statusBarText = "") {
  return matchingNames(
    String(statusBarText),
    providerStatusFatalPatterns[provider] ?? [],
  );
}

export function combinedFatalEvidence(evidence) {
  return [
    ...new Set([
      ...(evidence.fatalLogMatches ?? []),
      ...(evidence.fatalBuildOutputMatches ?? []),
      ...(evidence.fatalStatusMatches ?? []),
    ]),
  ];
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
