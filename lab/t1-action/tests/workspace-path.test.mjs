import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  resolveWorkspaceMembership,
} = require("../../import-extension/workspace-path.cjs");

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "fixtures", "workspace-path-aliases.json"),
    "utf8",
  ),
);

function fixtureRealpath(platform) {
  return (value) => {
    if (platform === "win32") {
      return value.replace(
        /C:\\Users\\RUNNER~1/i,
        "C:\\Users\\runneradmin",
      );
    }
    return value.replace(/^\/var\//, "/private/var/");
  };
}

for (const fixture of fixtures) {
  test(`matches ${fixture.name}`, () => {
    const membership = resolveWorkspaceMembership(
      fixture.diagnosticPath,
      [{
        uri: "file:///workspace",
        path: fixture.workspacePath,
      }],
      {
        platform: fixture.platform,
        realpath: fixtureRealpath(fixture.platform),
      },
    );
    assert.equal(membership.included, true);
    assert.ok(membership.canonicalPath.startsWith(fixture.canonicalPrefix));
    assert.equal(membership.relativePath, fixture.relativePath);
    assert.equal(membership.exclusionReason, null);
  });
}

test("does not include an external JDK source", () => {
  const membership = resolveWorkspaceMembership(
    "C:\\jdks\\21\\src\\java.base\\java\\lang\\String.java",
    [{
      uri: "file:///workspace",
      path: "C:\\work\\project",
    }],
    {
      platform: "win32",
      realpath: (value) => value,
    },
  );
  assert.equal(membership.included, false);
  assert.equal(membership.exclusionReason, "outside-canonical-workspace");
});
