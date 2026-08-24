export const JDTLS_EVIDENCE_VERSION = "1";

export const jdtlsStatusFatalPatterns = [
  ["java-warning", /Java:\s*Warning/i],
  ["java-error", /Java:\s*Error/i],
  ["gradle-build-error", /Gradle:\s*Build Error/i],
  ["maven-build-error", /Maven:\s*Build Error/i],
];

const fatalPatterns = [
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

export function analyzeJdtlsLog(content = "") {
  const text = String(content);
  const initializationCompleted =
    text.includes(">> initialization job finished") ||
    text.includes("Workspace initialized");
  const buildJobsFinished = text.includes(">> build jobs finished");
  const bspClasspathsUpdated =
    /Updating classpaths for \d+ projects? \(\d+ build targets?\) using batched BSP calls\./
      .test(text);
  const fatalLogMatches = matchingNames(text, fatalPatterns);
  const nativeCompletionMatches = [
    ...(initializationCompleted ? ["initialization-completed"] : []),
    ...(buildJobsFinished ? ["build-jobs-finished"] : []),
  ];
  return {
    adapterVersion: JDTLS_EVIDENCE_VERSION,
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
