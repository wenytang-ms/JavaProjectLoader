export const INTELLIJ_EVIDENCE_VERSION = "1";

export const intellijStatusFatalPatterns = [
  ["gradle-build-error", /Gradle:\s*Build Error/i],
  ["maven-build-error", /Maven:\s*Build Error/i],
];

const fatalPatterns = [
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

export function analyzeIntellijLog(content = "") {
  const text = String(content);
  const fatalLogMatches = matchingNames(text, fatalPatterns);
  const successfullyImported = /Successfully imported\s+/i.test(text);
  const workspaceModelSaved = /Workspace model cache saved/i.test(text);
  const filesUpdated = updatedFileCount(text);
  const importStarted = /\[IMPORT (?:STD|PROGRESS|ERR)\]/i.test(text);
  const nativeCompletionMatches = [
    ...(successfullyImported ? ["successfully-imported"] : []),
    ...(workspaceModelSaved ? ["workspace-model-cache-saved"] : []),
  ];
  return {
    adapterVersion: INTELLIJ_EVIDENCE_VERSION,
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
