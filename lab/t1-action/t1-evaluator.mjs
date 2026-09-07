import { analyzeStatusProblemCounts } from "./provider-evidence.mjs";

export const T1_RULE_VERSION = "t1-v4";
export const T1_COLLECTOR_VERSION = "t1-v4";
export const T1_ENVIRONMENT_RULE_VERSION = "t1-v5";
export const T1_ENVIRONMENT_COLLECTOR_VERSION = "t1-v5";
export const T1_EVIDENCE_SCHEMA_VERSION = 1;

const environmentStates = new Set([
  "ENV_READY",
  "ENV_BLOCKED",
  "ENV_UNVERIFIED",
  "PROJECT_BASELINE_FAILED",
]);

function environmentReason(value) {
  return typeof value === "string"
    ? value
    : value?.code ?? value?.reason ?? value?.message ?? JSON.stringify(value);
}

export function createEnvironmentEvidence({
  environmentRequired = false,
  environment = null,
} = {}) {
  const required = environmentRequired === true;
  const state = environmentStates.has(environment?.state)
    ? environment.state
    : "ENV_UNVERIFIED";
  const blockers = Array.isArray(environment?.blockers) ? environment.blockers : [];
  const unresolved = Array.isArray(environment?.unresolved) ? environment.unresolved : [];
  const category = {
    ENV_BLOCKED: "environment-blocked",
    ENV_UNVERIFIED: "environment-unverified",
    PROJECT_BASELINE_FAILED: "project-baseline-failed",
  }[state];
  const reasonCodes = unique([
    ...(required && category ? [category] : []),
    ...(required && !environment ? ["environment-evidence-missing"] : []),
    ...(required && environment && !environment.state
      ? ["environment-state-missing"]
      : []),
    ...(required && environment?.state && !environmentStates.has(environment.state)
      ? ["environment-state-invalid"]
      : []),
    ...(Array.isArray(environment?.reasonCodes) ? environment.reasonCodes : []),
    ...(Array.isArray(environment?.reasons) ? environment.reasons.map(environmentReason) : []),
    ...blockers.map((value) => `environment-blocker:${environmentReason(value)}`),
    ...unresolved.map((value) => `environment-unresolved:${environmentReason(value)}`),
  ]);
  const provenance = { ...environment?.provenance };
  for (const field of ["project", "commit", "operatingSystem", "planHash", "lockHash"]) {
    provenance[field] = environment?.[field] ?? provenance[field] ?? null;
  }
  return {
    ...environment,
    required,
    state,
    eligible: !required || state === "ENV_READY",
    ruleVersion: required ? T1_ENVIRONMENT_RULE_VERSION : T1_RULE_VERSION,
    provenance,
    blockers,
    unresolved,
    reasonCodes,
    reasons: reasonCodes,
  };
}

const buildEvidenceNames = new Set([
  "gradle-build-failed",
  "maven-build-failure",
  "maven-goal-failed",
  "dependency-resolution-failed",
  "artifact-missing",
  "build-action-failed",
  "gradle-build-error",
  "maven-build-error",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedCounts(counts = {}) {
  return {
    error: Number(counts.error ?? 0),
    warning: Number(counts.warning ?? 0),
    information: Number(counts.information ?? 0),
    hint: Number(counts.hint ?? 0),
  };
}

function providerState(providerLoad) {
  if (["ready", "warning", "error"].includes(providerLoad?.terminalState)) {
    return providerLoad.terminalState;
  }
  if (providerLoad?.importStatus === "ready") {
    return "ready";
  }
  if (
    ["loaded-indexing-timeout", "loaded-finalization-timeout"].includes(
      providerLoad?.importStatus,
    )
  ) {
    return "busy";
  }
  if (providerLoad?.importStatus === "import-failed") {
    return "error";
  }
  return providerLoad?.loaded ? "unknown" : "unknown";
}

function semanticState(sourceResult, sourceReady) {
  if (sourceReady) {
    return "ready";
  }
  if (!sourceResult || Number(sourceResult.sourceAttempts ?? 0) === 0) {
    return "not-run";
  }
  return /timeout/i.test(
    `${sourceResult.failureCategory ?? ""} ${sourceResult.error ?? ""}`,
  )
    ? "timeout"
    : "error";
}

function diagnosticState({ captured, stable, snapshotCounts, statusCounts }) {
  if (!captured) {
    return "not-captured";
  }
  if (!stable) {
    return "unstable";
  }
  if (
    snapshotCounts.error > 0 ||
    Number(statusCounts?.errorCount ?? 0) > 0
  ) {
    return "errors";
  }
  return "clean";
}

function projectHealth({
  buildEvidence,
  providerState: state,
  diagnosticsState,
}) {
  if (buildEvidence.length > 0) {
    return "build-errors";
  }
  if (diagnosticsState === "errors" || state === "warning") {
    return "project-errors";
  }
  if (state === "ready" && diagnosticsState === "clean") {
    return "clean";
  }
  return "unknown";
}

export function createNormalizedEvidence({
  project,
  provider,
  operatingSystem,
  effectiveTimeoutSeconds,
  providerLoad,
  sourceResult,
  sourceReady,
  diagnostics,
  environmentRequired = false,
  environment = null,
  harnessError = null,
  harnessCommit = null,
  collectorVersion,
  adapterVersion = null,
  collectionMode = "live",
  collectedAt = new Date().toISOString(),
}) {
  const environmentEvidence = createEnvironmentEvidence({
    environmentRequired,
    environment,
  });
  const log = providerLoad?.log ?? {};
  const finalStatusBarText =
    providerLoad?.ui?.finalStatusBarText ?? log.statusBarText ?? "";
  const statusProblemCounts =
    log.statusProblemCounts ??
    analyzeStatusProblemCounts(finalStatusBarText);
  const snapshotCounts = normalizedCounts(diagnostics?.counts);
  const statusMatches = unique(log.fatalStatusMatches ?? []);
  const logMatches = unique(log.fatalLogMatches ?? []);
  const buildOutputMatches = unique(log.fatalBuildOutputMatches ?? []);
  const buildEvidence = unique([
    ...buildOutputMatches,
    ...logMatches.filter((name) => buildEvidenceNames.has(name)),
    ...statusMatches.filter((name) => buildEvidenceNames.has(name)),
  ]);
  const providerFatalEvidence = unique([
    ...logMatches.filter((name) => !buildEvidenceNames.has(name)),
    ...statusMatches.filter(
      (name) =>
        !buildEvidenceNames.has(name) &&
        name !== "java-warning" &&
        name !== "workspace-problems-errors",
    ),
  ]);
  const state = providerState(providerLoad);
  const semantic = semanticState(sourceResult, sourceReady);
  const diagnosticsCaptured =
    diagnostics?.diagnosticsCaptured ??
    diagnostics?.captured ??
    Boolean(diagnostics);
  if (environmentEvidence.required && !diagnosticsCaptured) {
    for (const severity of Object.keys(snapshotCounts)) {
      snapshotCounts[severity] = null;
    }
  }
  const diagnosticsStable = diagnostics?.stable === true;
  const diagnosticsState = diagnosticState({
    captured: diagnosticsCaptured,
    stable: diagnosticsStable,
    snapshotCounts,
    statusCounts: statusProblemCounts,
  });
  return {
    schemaVersion: T1_EVIDENCE_SCHEMA_VERSION,
    ruleVersion: environmentEvidence.ruleVersion,
    collectorVersion: collectorVersion ?? (environmentEvidence.required
      ? T1_ENVIRONMENT_COLLECTOR_VERSION
      : T1_COLLECTOR_VERSION),
    collectionMode,
    collectedAt,
    harnessCommit,
    adapterVersion: adapterVersion ?? log.adapterVersion ?? "legacy",
    project,
    provider,
    operatingSystem,
    effectiveTimeoutSeconds: Number(effectiveTimeoutSeconds ?? 0),
    environmentEvidence,
    providerEvidence: {
      state,
      loaded: providerLoad?.loaded === true,
      importCompleted: providerLoad?.importCompleted === true,
      importStatus: providerLoad?.importStatus ?? "unknown",
      completionEvidence:
        providerLoad?.completionEvidence ??
        log.completionEvidence ??
        null,
      fatalLogMatches: logMatches,
      fatalBuildOutputMatches: buildOutputMatches,
      fatalStatusMatches: statusMatches.filter(
        (name) => name !== "workspace-problems-errors",
      ),
      buildEvidence,
      providerFatalEvidence,
      nativeCompletionMatches: unique(log.nativeCompletionMatches ?? []),
      finalStatusBarText,
    },
    projectEvidence: {
      health: projectHealth({
        buildEvidence,
        providerState: state,
        diagnosticsState,
      }),
      buildEvidence,
    },
    semanticEvidence: {
      state: semantic,
      sourceReady: sourceReady === true,
      documentSymbolReady: sourceResult?.documentSymbolReady === true,
      hoverReady: sourceResult?.hoverReady === true,
      sourceAttempts: Number(sourceResult?.sourceAttempts ?? 0),
      failureCategory: sourceResult?.failureCategory ?? "",
      error: sourceResult?.error ?? null,
      lastError: sourceResult?.sourceLastError ?? null,
    },
    diagnosticEvidence: {
      state: diagnosticsState,
      scope: diagnostics?.scope ?? "unknown",
      captured: diagnosticsCaptured,
      stable: diagnosticsStable,
      counts: snapshotCounts,
      excludedCounts: normalizedCounts(diagnostics?.excludedCounts),
      statusProblemCounts,
      discrepancy:
        diagnosticsCaptured &&
        statusProblemCounts !== null &&
        statusProblemCounts.errorCount !== snapshotCounts.error,
    },
    harnessEvidence: {
      state: harnessError ? "error" : "ok",
      error: harnessError,
    },
  };
}

function failure({
  loadStatus,
  failureCategory,
  failedPhase,
  reasonCodes,
}) {
  return {
    verdict: "FAIL",
    status: "failure",
    successful: false,
    loadSuccessful: false,
    loadStatus,
    failureCategory,
    failedPhase,
    reasonCodes: unique(reasonCodes),
  };
}

function hasProviderFailure(evidence) {
  return (evidence.providerEvidence?.providerFatalEvidence?.length ?? 0) > 0 ||
    evidence.providerEvidence?.importStatus === "import-failed" ||
    evidence.providerEvidence?.state === "error" ||
    (evidence.projectEvidence?.buildEvidence?.length ?? 0) > 0;
}

export function evaluateT1Eligibility(evidence) {
  const environment = createEnvironmentEvidence({
    environmentRequired: evidence.environmentEvidence?.required === true ||
      evidence.environmentRequired === true,
    environment: evidence.environmentEvidence ?? evidence.environment,
  });
  if (!environment.eligible) {
    const failureCategory = {
      ENV_BLOCKED: "environment-blocked",
      ENV_UNVERIFIED: "environment-unverified",
      PROJECT_BASELINE_FAILED: "project-baseline-failed",
    }[environment.state];
    return {
      verdict: "NOT_EVALUATED",
      status: "blocked",
      successful: false,
      loadSuccessful: false,
      loadStatus: failureCategory,
      failureCategory,
      failedPhase: "environment",
      reasonCodes: environment.reasonCodes,
      eligibility: "environment-ineligible",
    };
  }
  if (environment.required &&
      (evidence.harnessEvidence?.state === "error" || evidence.harnessEvidence?.error) &&
      !hasProviderFailure(evidence)) {
    return {
      verdict: "NOT_EVALUATED",
      status: "blocked",
      successful: false,
      loadSuccessful: false,
      loadStatus: "runner-error",
      failureCategory: "infrastructure-error",
      failedPhase: "runner",
      reasonCodes: ["harness-error", "infrastructure-error"],
      eligibility: "infrastructure-ineligible",
    };
  }
  return null;
}

export function evaluateT1(
  evidence,
  ruleVersion = evidence.ruleVersion ?? T1_RULE_VERSION,
) {
  if (![T1_RULE_VERSION, T1_ENVIRONMENT_RULE_VERSION].includes(ruleVersion)) {
    throw new Error(`Unsupported T1 rule version: ${ruleVersion}`);
  }
  if (evidence.schemaVersion !== T1_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported normalized evidence schema: ${evidence.schemaVersion}`,
    );
  }
  const ineligible = evaluateT1Eligibility(evidence);
  if (ineligible) {
    return ineligible;
  }
  const provider = evidence.providerEvidence;
  const project = evidence.projectEvidence;
  const semantic = evidence.semanticEvidence;
  const diagnostics = evidence.diagnosticEvidence;

  const environmentRequired = evidence.environmentEvidence?.required === true ||
    evidence.environmentRequired === true;
  if (evidence.harnessEvidence.state === "error" &&
      (!environmentRequired || !hasProviderFailure(evidence))) {
    return failure({
      loadStatus: "runner-error",
      failureCategory: "runner-error",
      failedPhase: "runner",
      reasonCodes: ["harness-error"],
    });
  }
  if (project.buildEvidence.length > 0) {
    return failure({
      loadStatus: "project-build-failed",
      failureCategory: "project-build-failure",
      failedPhase: "project-import",
      reasonCodes: [
        "project-build-failure",
        ...project.buildEvidence.map((name) => `build:${name}`),
      ],
    });
  }
  if (
    provider.providerFatalEvidence.length > 0 ||
    provider.importStatus === "import-failed" ||
    provider.state === "error"
  ) {
    return failure({
      loadStatus: "import-failed",
      failureCategory: "provider-import-failed",
      failedPhase: "provider-load",
      reasonCodes: [
        "provider-import-failure",
        ...provider.providerFatalEvidence.map(
          (name) => `provider:${name}`,
        ),
      ],
    });
  }
  if (
    provider.state === "warning" ||
    provider.fatalStatusMatches.includes("java-warning")
  ) {
    return failure({
      loadStatus: "loaded-with-project-errors",
      failureCategory: "provider-project-errors",
      failedPhase: "project-import",
      reasonCodes: ["provider-project-warning"],
    });
  }
  const providerTimeouts = {
    "loaded-finalization-timeout": [
      "provider-finalization-timeout",
      "provider-load",
    ],
    "loaded-indexing-timeout": [
      "provider-indexing-timeout",
      "source-index",
    ],
    "loaded-ui-timeout": ["provider-ui-timeout", "provider-load"],
  };
  if (providerTimeouts[provider.importStatus]) {
    const [category, phase] = providerTimeouts[provider.importStatus];
    return failure({
      loadStatus: provider.importStatus,
      failureCategory: category,
      failedPhase: phase,
      reasonCodes: [category],
    });
  }
  if (provider.state !== "ready" || provider.importStatus !== "ready") {
    return failure({
      loadStatus: "not-loaded",
      failureCategory: "provider-load-failed",
      failedPhase: "provider-load",
      reasonCodes: ["provider-not-ready"],
    });
  }
  if (semantic.state !== "ready") {
    const timedOut = semantic.state === "timeout";
    return failure({
      loadStatus: "loaded-source-not-ready",
      failureCategory: timedOut
        ? "source-readiness-timeout"
        : "source-readiness-failed",
      failedPhase: "source-index",
      reasonCodes: [
        timedOut ? "semantic-readiness-timeout" : "semantic-readiness-failure",
        ...(semantic.documentSymbolReady
          ? []
          : ["document-symbol-not-ready"]),
        ...(semantic.hoverReady ? [] : ["hover-not-ready"]),
      ],
    });
  }
  if (diagnostics.state === "not-captured") {
    return failure({
      loadStatus: "loaded-diagnostics-not-captured",
      failureCategory: "diagnostics-not-captured",
      failedPhase: "diagnostics",
      reasonCodes: ["diagnostics-not-captured"],
    });
  }
  if (diagnostics.state === "unstable") {
    return failure({
      loadStatus: "loaded-diagnostics-unstable",
      failureCategory: "diagnostics-unstable",
      failedPhase: "diagnostics",
      reasonCodes: ["diagnostics-unstable"],
    });
  }
  if (diagnostics.state === "errors") {
    const statusFallback =
      Number(diagnostics.statusProblemCounts?.errorCount ?? 0) > 0;
    return failure({
      loadStatus: "loaded-with-diagnostics-errors",
      failureCategory: "diagnostics-errors",
      failedPhase: "diagnostics",
      reasonCodes: [
        "workspace-diagnostics-errors",
        ...(statusFallback ? ["workspace-problems-errors"] : []),
        ...(diagnostics.discrepancy
          ? ["diagnostics-count-discrepancy"]
          : []),
      ],
    });
  }
  return {
    verdict: "PASS",
    status: "success",
    successful: true,
    loadSuccessful: true,
    loadStatus: "success",
    failureCategory: "",
    failedPhase: "",
    reasonCodes: [],
  };
}

export function normalizedEvidenceFromArtifacts({
  normalizedEvidence,
  result,
  ruleEvidence,
  diagnostics,
  runMetadata,
}) {
  const captured = normalizedEvidence ?? result.normalizedEvidence;
  const environmentRequired = captured?.environmentEvidence?.required === true ||
    captured?.environmentRequired === true ||
    result.environmentRequired === true ||
    result.environmentEvidence?.required === true ||
    runMetadata?.environmentRequired === true ||
    runMetadata?.environmentEvidence?.required === true;
  const environment = captured?.environmentEvidence ??
    result.environmentEvidence ?? result.environment ??
    runMetadata?.environmentEvidence ?? runMetadata?.environment ??
    (result.environmentState ? { state: result.environmentState } : null);
  if (captured) {
    // Historical evidence is returned untouched unless this run explicitly opted in.
    return environmentRequired ? {
      ...captured,
      ruleVersion: T1_ENVIRONMENT_RULE_VERSION,
      environmentEvidence: createEnvironmentEvidence({ environmentRequired, environment }),
    } : captured;
  }
  const finalStatusBarText =
    ruleEvidence?.finalStatusBarText ??
    result.providerLoad?.ui?.finalStatusBarText ??
    result.providerLoad?.log?.statusBarText ??
    "";
  const legacyFatalStatusMatches =
    ruleEvidence?.fatalStatusMatches ??
    result.providerLoad?.log?.fatalStatusMatches ??
    [];
  const legacyProblemsOnly =
    legacyFatalStatusMatches.length > 0 &&
    legacyFatalStatusMatches.every(
      (name) => name === "workspace-problems-errors",
    );
  const legacyTerminalState =
    result.providerTerminalState === "error" &&
    legacyProblemsOnly &&
    /Java:\s*Ready/i.test(finalStatusBarText)
      ? "ready"
      : result.providerTerminalState ?? null;
  const providerLoad = result.providerLoad
    ? {
        ...result.providerLoad,
        terminalState:
          result.providerLoad.terminalState === "error" &&
          legacyProblemsOnly &&
          /Java:\s*Ready/i.test(finalStatusBarText)
            ? "ready"
            : result.providerLoad.terminalState,
        importStatus:
          result.providerLoad.importStatus === "import-failed" &&
          legacyProblemsOnly &&
          /Java:\s*Ready/i.test(finalStatusBarText)
            ? "ready"
            : result.providerLoad.importStatus,
      }
    : {
    loaded: result.providerLoaded === true,
    importCompleted: result.providerImportCompleted === true,
    importStatus:
      result.providerImportStatus === "import-failed" &&
      legacyProblemsOnly &&
      /Java:\s*Ready/i.test(finalStatusBarText)
        ? "ready"
        : result.providerImportStatus ??
          (result.loadStatus === "success" ? "ready" : result.loadStatus),
    terminalState: legacyTerminalState,
    completionEvidence: ruleEvidence?.completionEvidence ?? null,
    log: {
      fatalLogMatches: ruleEvidence?.fatalLogMatches ?? [],
      fatalBuildOutputMatches:
        ruleEvidence?.fatalBuildOutputMatches ?? [],
      fatalStatusMatches: ruleEvidence?.fatalStatusMatches ?? [],
      nativeCompletionMatches:
        ruleEvidence?.nativeCompletionMatches ?? [],
      statusProblemCounts: ruleEvidence?.statusProblemCounts ?? null,
      statusBarText: finalStatusBarText,
    },
    ui: {
      finalStatusBarText,
    },
  };
  const sourceResult = {
    status: result.sourceReady ? "source-ready" : "failure",
    sourceAttempts: result.sourceAttempts ?? 0,
    documentSymbolReady: result.documentSymbolReady,
    hoverReady: result.hoverReady,
    failureCategory: result.failureCategory,
    error: result.error,
    sourceLastError: result.sourceLastError,
  };
  return createNormalizedEvidence({
    project: result.project,
    provider: result.product ?? result.provider,
    operatingSystem: result.operatingSystem ?? result.os,
    effectiveTimeoutSeconds: result.effectiveTimeoutSeconds,
    environmentRequired,
    environment,
    providerLoad,
    sourceResult,
    sourceReady: result.sourceReady === true,
    diagnostics: diagnostics
      ? {
          ...diagnostics,
          diagnosticsCaptured: result.diagnosticsCaptured !== false,
        }
      : {
          scope: result.diagnosticScope ?? "unknown",
          stable: result.diagnosticsStable === true,
          diagnosticsCaptured: result.diagnosticsCaptured === true,
          counts: {
            error: result.errorCount ?? 0,
            warning: result.warningCount ?? 0,
          },
        },
    harnessError:
      ["runner-error", "infrastructure-error"].includes(result.failureCategory)
        ? result.error ?? "runner-error"
        : null,
    harnessCommit: runMetadata?.harnessCommit ?? null,
    collectorVersion: result.collectorVersion ?? "legacy",
    adapterVersion: result.adapterVersion ?? "legacy",
    collectionMode: "replay",
    collectedAt: result.completedAt ?? new Date().toISOString(),
  });
}

export function evidenceSufficiency(evidence, judgment) {
  if (judgment.verdict === "NOT_EVALUATED") {
    return {
      sufficient: false,
      reason: judgment.eligibility ?? "environment-ineligible",
    };
  }
  const decisiveFailure = judgment.reasonCodes.some((reason) =>
    /^(?:project-build-failure|provider-import-failure|provider-project-warning|provider-|semantic-|workspace-diagnostics-errors|harness-error)/
      .test(reason),
  );
  const completePass =
    judgment.verdict === "PASS" &&
    [T1_COLLECTOR_VERSION, T1_ENVIRONMENT_COLLECTOR_VERSION].includes(evidence.collectorVersion) &&
    evidence.providerEvidence.state === "ready" &&
    evidence.semanticEvidence.state === "ready" &&
    evidence.diagnosticEvidence.scope === "workspace" &&
    evidence.diagnosticEvidence.state === "clean";
  return {
    sufficient: decisiveFailure || completePass,
    reason: decisiveFailure
      ? "decisive-failure-evidence"
      : completePass
        ? `complete-${evidence.collectorVersion.replace("t1-", "")}-pass-evidence`
        : "legacy-or-incomplete-pass-evidence",
  };
}
