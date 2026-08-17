const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function normalizePath(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/\\/g, "/")
    .toLowerCase();
}

function writeResult(resultFile, result) {
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
}

async function runT1() {
  const resultFile = process.env.IMPORT_RESULT;
  const caseJson = process.env.IMPORT_CASE_JSON;
  if (!resultFile || !caseJson) {
    return;
  }

  const importCase = JSON.parse(caseJson);
  const product = process.env.IMPORT_PRODUCT;
  const timeoutMs = Number(process.env.IMPORT_TIMEOUT_MS || "570000");
  const processStartedAt = process.env.IMPORT_PROCESS_STARTED_AT || null;
  const activatedAt = Date.now();
  const result = {
    schemaVersion: 1,
    runId: process.env.IMPORT_RUN_ID,
    product,
    project: importCase.id,
    case: importCase,
    dependencyCacheMode: "warm-shared",
    dependencyCacheKind: "unknown",
    dependencyCachePath: null,
    targetPhase: "source-ready",
    extensionInventory: JSON.parse(
      process.env.IMPORT_EXTENSION_INVENTORY || "[]",
    ),
    processStartedAt,
    activatedAt: new Date(activatedAt).toISOString(),
    documentOpenedAt: null,
    sourceReadyAt: null,
    modelReadyAt: null,
    externalDependencyUsableAt: null,
    diagnosticsStableAt: null,
    strictReadyAt: null,
    completedAt: null,
    languageId: null,
    sourceReadyMs: null,
    modelReadyMs: null,
    externalDependencyUsableMs: null,
    strictReadyMs: null,
    processToSourceReadyMs: null,
    processToExternalDependencyUsableMs: null,
    processToStrictReadyMs: null,
    sourceAttempts: 0,
    modelAttempts: 0,
    lastModelProbe: null,
    blockingDiagnostics: [],
    status: "failure",
    failureCategory: "",
    failedPhase: "",
    error: null,
    semanticApi: null,
    diagnosticLatency: null,
  };

  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder is open");
    }

    const fileUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      ...importCase.relativeFile.split("/"),
    );
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
    result.documentOpenedAt = new Date().toISOString();
    result.languageId = document.languageId;
    if (document.languageId === "plaintext") {
      result.failureCategory = "unsupported-language";
      result.failedPhase = "document-open";
      throw new Error(`Unsupported language for ${importCase.relativeFile}`);
    }

    const started = performance.now();
    const expectedFile = normalizePath(importCase.relativeFile);
    while (performance.now() - started < timeoutMs) {
      result.sourceAttempts += 1;
      try {
        const symbols = await withTimeout(
          vscode.commands.executeCommand(
            "vscode.executeWorkspaceSymbolProvider",
            importCase.sourceSymbol,
          ),
          30000,
          "Workspace symbol request",
        );
        const matched = Array.isArray(symbols)
          ? symbols.some((item) => {
              const uri = item?.location?.uri;
              return (
                item.name === importCase.sourceSymbol &&
                uri &&
                normalizePath(uri.toString()).endsWith(expectedFile)
              );
            })
          : false;
        if (matched) {
          result.sourceReadyMs = round(performance.now() - started);
          result.sourceReadyAt = new Date().toISOString();
          result.processToSourceReadyMs = processStartedAt
            ? Date.now() - Date.parse(processStartedAt)
            : null;
          result.status = "source-ready";
          return;
        }
      } catch (error) {
        result.sourceLastError = String(error);
      }
      await sleep(1000);
    }

    result.failureCategory = "source-readiness-timeout";
    result.failedPhase = "source-index";
    throw new Error(`Source readiness timed out after ${timeoutMs}ms`);
  } catch (error) {
    result.error = String(error);
    result.failureCategory ||= "language-provider-error";
    result.failedPhase ||= "provider";
  } finally {
    result.completedAt = new Date().toISOString();
    writeResult(resultFile, result);
  }
}

function activate() {
  setTimeout(() => {
    runT1();
  }, 1500);
}

function deactivate() {}

module.exports = { activate, deactivate };
