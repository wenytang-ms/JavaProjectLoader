import assert from "node:assert/strict";
import test from "node:test";
import {
  clickWebviewElement,
  isTransientWebviewError,
  statIfPresent,
} from "../run-t1-autotest.mjs";

test("IntelliJ onboarding retries detached and replaced webview elements", async () => {
  for (const message of [
    "locator.evaluate: Frame was detached",
    "locator.waitFor: Timeout 15000ms exceeded.",
    "Execution context was destroyed",
  ]) {
    const locator = {
      waitFor: async () => {},
      evaluate: async () => {
        throw new Error(message);
      },
    };
    assert.equal(await clickWebviewElement(locator), false);
    assert.equal(isTransientWebviewError(new Error(message)), true);
  }
});

test("IntelliJ onboarding still surfaces non-transient click failures", async () => {
  const locator = {
    waitFor: async () => {},
    evaluate: async () => {
      throw new Error("EULA control is disabled");
    },
  };
  await assert.rejects(
    clickWebviewElement(locator),
    /EULA control is disabled/,
  );
});

test("provider log scans ignore files removed during stat", () => {
  const missing = new Error("temporary file disappeared");
  missing.code = "ENOENT";
  assert.equal(
    statIfPresent("staged.tmp", {
      statSync: () => {
        throw missing;
      },
    }),
    null,
  );
});

test("provider log scans still surface non-race filesystem errors", () => {
  const denied = new Error("permission denied");
  denied.code = "EACCES";
  assert.throws(
    () =>
      statIfPresent("provider.log", {
        statSync: () => {
          throw denied;
        },
      }),
    /permission denied/,
  );
});
