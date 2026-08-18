export function detectProviderTerminalState(provider, statusBarText, busy) {
  if (busy) {
    return null;
  }
  if (provider !== "jdtls") {
    return "ready";
  }
  const match = statusBarText.match(/Java:\s*(Ready|Warning|Error)/i);
  return match ? match[1].toLowerCase() : null;
}

export function buildProviderLoadResult(log, ui) {
  if (!log.loaded) {
    const importFailed =
      log.failed || log.failureCategory === "provider-import-failed";
    return {
      loaded: false,
      importCompleted: importFailed,
      importStatus: importFailed ? "import-failed" : "not-loaded",
      terminalState: importFailed ? "error" : null,
      failureCategory:
        log.failureCategory ??
        (importFailed ? "provider-import-failed" : "provider-log-timeout"),
      log,
      ui: null,
    };
  }

  if (!ui?.settled || !ui.terminalState) {
    return {
      loaded: false,
      importCompleted: false,
      importStatus: "not-loaded",
      terminalState: null,
      failureCategory: "provider-ui-timeout",
      log,
      ui,
    };
  }

  if (ui.terminalState === "warning") {
    return {
      loaded: true,
      importCompleted: true,
      importStatus: "loaded-with-project-errors",
      terminalState: "warning",
      failureCategory: "provider-project-errors",
      log,
      ui,
    };
  }

  if (ui.terminalState === "error") {
    return {
      loaded: false,
      importCompleted: true,
      importStatus: "import-failed",
      terminalState: "error",
      failureCategory: "provider-import-failed",
      log,
      ui,
    };
  }

  return {
    loaded: true,
    importCompleted: true,
    importStatus: "ready",
    terminalState: "ready",
    failureCategory: "",
    log,
    ui,
  };
}

export function classifyLoadResult({
  sourceReady,
  sourceFailureCategory,
  providerLoad,
  diagnosticsStable,
  errorCount,
}) {
  if (providerLoad.importStatus === "loaded-with-project-errors") {
    return {
      successful: false,
      loadStatus: "loaded-with-project-errors",
      failureCategory: "provider-project-errors",
      failedPhase: "provider-load",
    };
  }
  if (providerLoad.importStatus === "import-failed") {
    return {
      successful: false,
      loadStatus: "import-failed",
      failureCategory: "provider-import-failed",
      failedPhase: "provider-load",
    };
  }
  if (providerLoad.importStatus !== "ready") {
    return {
      successful: false,
      loadStatus: "not-loaded",
      failureCategory: providerLoad.failureCategory || "provider-load-failed",
      failedPhase: "provider-load",
    };
  }
  if (!sourceReady) {
    return {
      successful: false,
      loadStatus: "loaded-source-not-ready",
      failureCategory: sourceFailureCategory || "source-readiness-failed",
      failedPhase: "source-index",
    };
  }
  if (!diagnosticsStable) {
    return {
      successful: false,
      loadStatus: "loaded-diagnostics-unstable",
      failureCategory: "diagnostics-unstable",
      failedPhase: "diagnostics",
    };
  }
  if (errorCount > 0) {
    return {
      successful: false,
      loadStatus: "loaded-with-diagnostics-errors",
      failureCategory: "diagnostics-errors",
      failedPhase: "diagnostics",
    };
  }
  return {
    successful: true,
    loadStatus: "success",
    failureCategory: "",
    failedPhase: "",
  };
}
