import { analyzeProviderStatus } from "./provider-evidence.mjs";

export function isProviderBusy(provider, statusBarText) {
  const pattern =
    provider === "jdtls"
      ? /(?:Java:\s*(?:Activating|Importing|Building|Refreshing|Searching)|Gradle:\s*(?:Configure|Build(?! Error)|Import|Refresh|Download)|Maven:\s*(?:Import|Build(?! Error)|Download))/i
      : /(?:Indexing|Importing project|Just a few more moments)/i;
  return pattern.test(statusBarText);
}

export function detectProviderTerminalState(provider, statusBarText, busy) {
  if (busy) {
    return null;
  }
  if (provider === "jdtls") {
    const fatalStatusMatches = analyzeProviderStatus(provider, statusBarText);
    if (fatalStatusMatches.some((match) => match !== "java-warning")) {
      return "error";
    }
    if (fatalStatusMatches.includes("java-warning")) {
      return "warning";
    }
    const match = statusBarText.match(/Java:\s*(Ready|Warning|Error)/i);
    return match ? match[1].toLowerCase() : null;
  }
  if (analyzeProviderStatus(provider, statusBarText).length > 0) {
    return "error";
  }
  return /Java and Kotlin/i.test(statusBarText) ? "ready" : null;
}

export function buildProviderLoadResult(log, ui) {
  if (!log.loaded) {
    const importFailed =
      log.failed || log.failureCategory === "provider-import-failed";
    const initializationCompleted =
      log.initializationCompleted ||
      ["initialization-finished", "workspace-initialized"].includes(
        log.lastObservation,
      );
    if (!importFailed && initializationCompleted) {
      return {
        loaded: true,
        importCompleted: false,
        importStatus: "loaded-finalization-timeout",
        terminalState: null,
        failureCategory: "provider-finalization-timeout",
        log,
        ui: null,
      };
    }
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
    const indexing =
      /(?:Indexing|Importing project|Just a few more moments|Java:\s*(?:Searching|Refreshing|Building|Importing))/i.test(
      ui?.finalStatusBarText ?? "",
    );
    return {
      loaded: true,
      importCompleted: true,
      importStatus: indexing
        ? "loaded-indexing-timeout"
        : "loaded-ui-timeout",
      terminalState: null,
      failureCategory: indexing
        ? "provider-indexing-timeout"
        : "provider-ui-timeout",
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
