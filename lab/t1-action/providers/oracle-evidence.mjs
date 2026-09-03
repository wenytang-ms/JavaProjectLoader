export const ORACLE_EVIDENCE_VERSION = "2-pilot";

export const oracleStatusFatalPatterns = [
  ["java-support-initialization-failed", /Cannot initialize Java support/i],
  ["language-server-not-enabled", /Oracle Java SE Language Server not enabled/i],
];

const fatalPatterns = [
  ["java-runtime-not-found", /Cannot find java/i],
  [
    "language-server-module-missing",
    /Cannot find org\.netbeans\.modules\.java\.lsp\.server/i,
  ],
  ["language-server-not-enabled", /Oracle Java SE Language Server not enabled/i],
  ["language-client-start-failed", /Language Client:[^\r\n]*(?:failed|error)/i],
  ["language-server-exited", /LSP server \d+ terminated with [1-9]\d*/i],
];

function matchingNames(content, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}

export function analyzeOracleLog(content = "") {
  const text = String(content);
  const serverLaunching = /LSP server launching:\s*\d+/i.test(text);
  const languageClientStarting = /Language Client:\s*Starting/i.test(text);
  const languageClientReady = /Language Client:\s*Ready/i.test(text);
  const projectsOpened = /\b\d+\s+projects opened in\s+[\d,]+ms\b/i.test(text);
  const indexingFinished = /\bIndexing finished, indexing took\s+[\d,]+\s*ms\b/i
    .test(text);
  const projectModelReady = projectsOpened && indexingFinished;
  const fatalLogMatches = matchingNames(text, fatalPatterns);
  const nativeCompletionMatches = [];
  if (languageClientReady) {
    nativeCompletionMatches.push("language-client-ready");
  }
  if (projectsOpened) {
    nativeCompletionMatches.push("projects-opened");
  }
  if (indexingFinished) {
    nativeCompletionMatches.push("indexing-finished");
  }
  return {
    adapterVersion: ORACLE_EVIDENCE_VERSION,
    fatalLogMatches,
    nativeCompletionMatches,
    nativeCompleted: languageClientReady && projectModelReady,
    initializationCompleted: languageClientReady,
    buildJobsFinished: false,
    bspClasspathsUpdated: false,
    updatedFileCount: 0,
    importStarted: serverLaunching || languageClientStarting || projectsOpened,
    functionalCandidate: false,
    lastObservation: projectModelReady
      ? "project-model-ready"
      : projectsOpened
        ? "projects-opened"
        : languageClientReady
          ? "language-client-ready"
      : languageClientStarting
        ? "language-client-starting"
        : serverLaunching
          ? "language-server-launching"
          : "waiting-for-language-server",
  };
}
