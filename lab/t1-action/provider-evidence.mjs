import {
  analyzeIntellijLog,
  INTELLIJ_EVIDENCE_VERSION,
  intellijStatusFatalPatterns,
} from "./providers/intellij-evidence.mjs";
import {
  analyzeJdtlsLog,
  JDTLS_EVIDENCE_VERSION,
  jdtlsStatusFatalPatterns,
} from "./providers/jdtls-evidence.mjs";
import {
  analyzeOracleLog,
  ORACLE_EVIDENCE_VERSION,
  oracleStatusFatalPatterns,
} from "./providers/oracle-evidence.mjs";

export const providerEvidenceVersions = {
  jdtls: JDTLS_EVIDENCE_VERSION,
  intellij: INTELLIJ_EVIDENCE_VERSION,
  oracle: ORACLE_EVIDENCE_VERSION,
};

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
  jdtls: jdtlsStatusFatalPatterns,
  intellij: intellijStatusFatalPatterns,
  oracle: oracleStatusFatalPatterns,
};

function matchingNames(content, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => name);
}

export function analyzeBuildOutput(content = "") {
  return matchingNames(String(content), buildOutputFatalPatterns);
}

function parseAbbreviatedCount(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) {
    return null;
  }
  const multipliers = {
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
  };
  return Math.round(
    Number(match[1]) * (multipliers[match[2]?.toUpperCase()] ?? 1),
  );
}

export function analyzeStatusProblemCounts(statusBarText = "") {
  for (const segment of String(statusBarText).split("|")) {
    const normalized = segment.trim();
    const match = normalized.match(
      /^(\d+(?:\.\d+)?[KMG]?)\s+(\d+(?:\.\d+)?[KMG]?)(?:\s+(\d+(?:\.\d+)?[KMG]?))?$/i,
    );
    if (!match) {
      continue;
    }
    return {
      raw: normalized,
      errorCount: parseAbbreviatedCount(match[1]),
      warningCount: parseAbbreviatedCount(match[2]),
      informationCount: parseAbbreviatedCount(match[3] ?? "0"),
    };
  }
  return null;
}

export function analyzeProviderStatus(provider, statusBarText = "") {
  const text = String(statusBarText);
  return matchingNames(
    text,
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

export function analyzeProviderLog(provider, content = "") {
  if (provider === "jdtls") {
    return analyzeJdtlsLog(content);
  }
  if (provider === "intellij") {
    return analyzeIntellijLog(content);
  }
  if (provider === "oracle") {
    return analyzeOracleLog(content);
  }
  throw new Error(`Unknown provider: ${provider}`);
}
