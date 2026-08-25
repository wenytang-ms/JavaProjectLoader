import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  assertIntellijWorkspacePathEvidence,
  createIntellijWorkspacePathEvidence,
  createT1Driver,
} from "../workspace-driver.mjs";

test("IntelliJ opens the disposable T1 workspace in place", async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "t1-intellij-driver-"),
  );
  try {
    const driver = createT1Driver("intellij", { workspacePath });
    assert.equal(
      await driver.createWorktree(workspacePath),
      path.resolve(workspacePath),
    );
    assert.equal(driver.getWorkspacePath(), path.resolve(workspacePath));

    const evidence = createIntellijWorkspacePathEvidence({
      requestedWorkspacePath: workspacePath,
      openedWorkspacePath: driver.getWorkspacePath(),
      settings: {
        "intellij.projects": [{
          type: "maven",
          path: pathToFileURL(workspacePath).href,
        }],
      },
    });
    assert.equal(evidence.matches, true);
    assert.doesNotThrow(() =>
      assertIntellijWorkspacePathEvidence(evidence),
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("IntelliJ rejects a configured project outside the opened workspace", () => {
  const requestedWorkspacePath = path.join(os.tmpdir(), "t1-requested");
  const openedWorkspacePath = path.join(os.tmpdir(), "t1-opened");
  const evidence = createIntellijWorkspacePathEvidence({
    requestedWorkspacePath,
    openedWorkspacePath,
    settings: {
      "intellij.projects": [{
        type: "gradle",
        path: pathToFileURL(requestedWorkspacePath).href,
      }],
    },
  });

  assert.equal(evidence.matches, false);
  assert.throws(
    () => assertIntellijWorkspacePathEvidence(evidence),
    /does not match the opened VS Code workspace/,
  );
});
