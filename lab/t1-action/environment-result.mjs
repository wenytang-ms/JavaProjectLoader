import { createNormalizedEvidence, evaluateT1 } from "./t1-evaluator.mjs";

export function createEnvironmentBlockedResult({
  project,
  provider,
  operatingSystem,
  environment,
  harnessCommit = null,
}) {
  const normalizedEvidence = createNormalizedEvidence({
    project: typeof project === "string" ? project : project.id,
    provider,
    operatingSystem,
    environmentRequired: true,
    environment,
    harnessCommit,
    collectionMode: "environment-preflight",
  });
  const judgment = evaluateT1(normalizedEvidence);
  if (judgment.verdict !== "NOT_EVALUATED") {
    throw new Error("Cannot create an environment-blocked result for ENV_READY.");
  }
  return {
    schemaVersion: 2,
    project: normalizedEvidence.project,
    product: provider,
    provider,
    operatingSystem,
    ruleVersion: normalizedEvidence.ruleVersion,
    collectorVersion: normalizedEvidence.collectorVersion,
    harnessCommit,
    completedAt: normalizedEvidence.collectedAt,
    ...judgment,
    environmentRequired: true,
    environmentState: normalizedEvidence.environmentEvidence.state,
    environmentEligible: false,
    evaluationEligible: false,
    eligibility: "environment-ineligible",
    environmentEvidence: normalizedEvidence.environmentEvidence,
    providerState: "unknown",
    providerLoaded: false,
    providerImportCompleted: false,
    providerImportStatus: "not-run",
    providerTerminalState: null,
    projectHealth: "unknown",
    semanticState: "not-run",
    sourceReady: false,
    sourceAttempts: 0,
    diagnosticState: "not-captured",
    diagnosticsCaptured: false,
    diagnosticsStable: false,
    diagnosticScope: "unknown",
    errorCount: null,
    warningCount: null,
    informationCount: null,
    hintCount: null,
    totalDurationMs: null,
    normalizedEvidence,
  };
}
