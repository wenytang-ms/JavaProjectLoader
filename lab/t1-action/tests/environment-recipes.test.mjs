import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const readJson = (relative) =>
  JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), "utf8"));
const document = readJson("../../t1-environment-recipes.json");
const projects = readJson("../../t1-projects.json");
const environments = readJson("../../t1-project-environments.json").projects;
const recipes = document.projects;
const version = /^\d+(?:\.\d+)*$/;
const sha = /^[0-9a-f]{40}$/;
const syntheticIds = [
  "nativescript", "leetcode", "jdk", "playframework",
  "the-complete-faang-preparation", "semgrep", "curlconverter", "aws-doc-sdk-examples",
];

function keysAre(value, allowed, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  for (const key of Object.keys(value)) {
    assert.ok(allowed.includes(key), `${label}: unsupported field ${key}`);
  }
}

function relativePath(value, label) {
  assert.equal(typeof value, "string", label);
  assert.ok(value.length > 0, label);
  assert.ok(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value), label);
  assert.ok(!value.split(/[\\/]/).includes(".."), label);
  assert.ok(!/[:\0\r\n]/.test(value), label);
}

function evidenceRecord(record, label) {
  keysAre(record, ["path", "url", "line", "reason"], label);
  assert.equal(typeof record.reason, "string", label);
  assert.ok(record.reason.trim().length > 0, label);
  assert.ok(record.path || record.url, `${label}: missing source locator`);
  if (record.path !== undefined) relativePath(record.path, label);
  if (record.line !== undefined) {
    assert.ok(Number.isInteger(record.line) && record.line > 0, label);
  }
  if (record.url !== undefined) {
    const url = new URL(record.url);
    assert.equal(url.protocol, "https:", label);
    if (url.hostname === "github.com") {
      assert.match(url.pathname, /^\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\//, label);
    } else {
      assert.equal(url.hostname, "repo.maven.apache.org", label);
      assert.match(url.pathname, /^\/maven2\/.+\/\d[^/]*\/[^/]+\.pom$/, label);
      assert.ok(!url.pathname.includes("SNAPSHOT"), `${label}: mutable external parent`);
    }
  }
}

test("recipes cover exactly the 100 immutable manifest identities", () => {
  assert.deepEqual(Object.keys(document).sort(), ["projects", "schemaVersion"]);
  assert.equal(document.schemaVersion, 1);
  assert.equal(projects.length, 100);
  assert.equal(Object.keys(recipes).length, 100);
  const ids = projects.map((project) => project.id).sort();
  assert.equal(new Set(ids).size, 100);
  assert.deepEqual(Object.keys(recipes).sort(), ids);
  assert.deepEqual(environments.map((project) => project.id).sort(), ids);
  const environmentById = new Map(environments.map((project) => [project.id, project]));
  for (const project of projects) {
    assert.match(recipes[project.id].commit, sha, project.id);
    assert.equal(recipes[project.id].commit, project.commit, project.id);
    assert.equal(recipes[project.id].commit, environmentById.get(project.id).commit, project.id);
  }
});

test("recipes contain only bounded structured requirements and pinned source evidence", () => {
  for (const [id, recipe] of Object.entries(recipes)) {
    keysAre(recipe, [
      "commit", "scope", "buildRoot", "buildTool", "constraints",
      "android", "evidence", "blockedReasons", "unresolvedHints",
    ], id);
    assert.ok(["native", "java-subproject", "synthetic"].includes(recipe.scope), id);
    relativePath(recipe.buildRoot, id);
    if (recipe.buildTool !== undefined) {
      assert.ok(["maven", "gradle"].includes(recipe.buildTool), id);
    }
    keysAre(recipe.constraints, [
      "projectJavaMin", "buildJavaMin", "runtimeJavaMin", "toolchainJavaVersions",
      "mavenExact", "mavenMin", "gradleVersion",
    ], id);
    assert.ok(!(recipe.constraints.mavenExact && recipe.constraints.mavenMin), id);
    for (const [key, value] of Object.entries(recipe.constraints)) {
      if (key === "toolchainJavaVersions") {
        assert.ok(Array.isArray(value) && value.length > 0, id);
        assert.equal(new Set(value).size, value.length, id);
        value.forEach((item) => assert.match(item, version, id));
      } else {
        assert.match(value, version, `${id}.${key}`);
      }
    }
    assert.ok(Array.isArray(recipe.evidence) && recipe.evidence.length > 0, id);
    recipe.evidence.forEach((record) => evidenceRecord(record, id));
    assert.ok(recipe.evidence.some((record) => record.path ||
      record.url.includes(`/blob/${recipe.commit}/`)), `${id}: no evidence at project SHA`);
    assert.ok(Array.isArray(recipe.blockedReasons), id);
    for (const reason of recipe.blockedReasons) {
      keysAre(reason, ["code", "message", "evidence"], id);
      assert.match(reason.code, /^[A-Z][A-Z0-9_]+$/, id);
      assert.equal(typeof reason.message, "string", id);
      assert.ok(reason.message.trim().length > 0, id);
      if (reason.evidence) {
        (Array.isArray(reason.evidence) ? reason.evidence : [reason.evidence])
          .forEach((record) => evidenceRecord(record, id));
      }
    }
    if (recipe.unresolvedHints !== undefined) {
      assert.ok(Array.isArray(recipe.unresolvedHints), id);
      recipe.unresolvedHints.forEach((hint) => {
        assert.equal(typeof hint, "string", id);
        assert.ok(hint.trim().length > 0, id);
      });
    }
    if (recipe.android !== undefined) {
      keysAre(recipe.android, ["platforms", "buildTools", "ndkVersions"], id);
      for (const key of ["platforms", "buildTools", ...("ndkVersions" in recipe.android ? ["ndkVersions"] : [])]) {
        const values = recipe.android[key];
        assert.ok(Array.isArray(values), `${id}.android.${key}`);
        assert.equal(new Set(values).size, values.length, id);
        values.forEach((value) => assert.match(value, key === "platforms" ? /^android-\d+$/ : version, id));
      }
      assert.ok(recipe.android.platforms.length > 0, id);
    }
  }
});

test("every native build root contains its fixed probe without escaping checkout", () => {
  for (const project of projects) {
    const root = recipes[project.id].buildRoot.replaceAll("\\", "/");
    const probe = project.relativeFile.replaceAll("\\", "/");
    relativePath(probe, project.id);
    assert.ok(root === "." || probe.startsWith(`${root}/`), project.id);
  }
  for (const [id, root] of Object.entries({
    appsmith: "app/server",
    jeecgboot: "jeecg-boot",
    tiled: "util/java",
    ip2region: "maker/java",
    beam: "plugins/beam-code-completion-plugin",
  })) {
    assert.equal(recipes[id].scope, "java-subproject", id);
    assert.equal(recipes[id].buildRoot, root, id);
  }
  assert.equal(recipes["analysis-ik"].buildRoot, ".");
  assert.equal(recipes.quarkus.buildRoot, ".");
  assert.equal(recipes.quarkus.buildTool, "maven");
  assert.ok(recipes.quarkus.evidence.some((record) => record.path === "core/runtime/pom.xml"));
});

test("audited inherited and dependency compiler floors are retained", () => {
  for (const [id, minimum] of Object.entries({
    appsmith: "25", cryptomator: "26", activiti: "25", storm: "25",
    thingsboard: "25", questdb: "25", trino: "25.0.1",
    jenkins: "21", openrefine: "21", checkstyle: "21", mapstruct: "21",
    "analysis-ik": "21", redisson: "25", "mybatis-3": "21",
    "spring-cloud-alibaba": "21.0.8",
  })) {
    assert.equal(recipes[id].constraints.buildJavaMin, minimum, id);
  }
  assert.equal(recipes.spark.constraints.mavenMin, "3.9.16");
  assert.equal(recipes.flink.constraints.mavenExact, "3.8.6");
  assert.equal(recipes["mybatis-3"].constraints.mavenMin, "3.9.16");
  assert.equal(recipes["mybatis-3"].constraints.projectJavaMin, "11");
  assert.ok(recipes["mybatis-3"].evidence.some((record) => record.reason.includes("test Java 17")));
});

test("compiler toolchains are explicit and do not conflate release or language-server JVM", () => {
  for (const [id, versions] of Object.entries({
    "spring-boot": ["25"], elasticsearch: ["21"], rxjava: ["26"], guava: ["26"],
    okhttp: ["21"], retrofit: ["8", "14", "16"], mockito: ["21"],
    feign: ["8", "11", "17", "25"], "spring-security": ["25"],
    "supertokens-core": ["21"], jmeter: ["21"], "testcontainers-java": ["17"],
    paper: ["25"], "error-prone": ["25"], "graphql-java": ["25"],
    minecraftforge: ["25"], "micronaut-core": ["25"],
    "junit-framework": ["25"], btrace: ["8", "11", "17", "24"],
  })) {
    assert.deepEqual(recipes[id].constraints.toolchainJavaVersions, versions, id);
  }
  assert.equal(recipes["spring-security"].constraints.projectJavaMin, "17");
  assert.ok(Number(recipes["spring-security"].constraints.buildJavaMin ?? 0) <= 21);
  assert.ok(Number(recipes["spring-security"].constraints.runtimeJavaMin ?? 0) <= 21);
  assert.equal(recipes["error-prone"].constraints.projectJavaMin, "21");
  assert.equal(recipes["error-prone"].constraints.runtimeJavaMin, "25");
  assert.equal(recipes.redisson.constraints.runtimeJavaMin, "25");
  assert.equal(recipes.jjwt.constraints.toolchainJavaVersions, undefined);
});

test("old Gradle launch compatibility and scoped wrappers are not overwritten", () => {
  assert.equal(recipes.jib.constraints.gradleVersion, "6.9.2");
  assert.equal(recipes.jib.constraints.projectJavaMin, "8");
  assert.equal(recipes.jib.constraints.buildJavaMin, "11");
  assert.equal(recipes.grasscutter.constraints.gradleVersion, "7.4.2");
  assert.equal(recipes.grasscutter.constraints.buildJavaMin, "17");
  assert.equal(recipes.beam.constraints.gradleVersion, "7.5.1");
});

test("synthetic and unsafe native models are explicitly ineligible without hiding existing preparation", () => {
  assert.deepEqual(Object.keys(recipes).filter((id) => recipes[id].scope === "synthetic").sort(), syntheticIds.sort());
  for (const id of syntheticIds) {
    assert.ok(recipes[id].blockedReasons.some((reason) => reason.code === "SYNTHETIC_NATIVE_SCOPE"), id);
  }
  for (const id of ["dbeaver", "ray", "flutter-examples", "ultimaterecyclerview", "graal", "retrofit"]) {
    assert.ok(recipes[id].blockedReasons.length > 0, id);
  }
  assert.ok(recipes.retrofit.blockedReasons.some((reason) =>
    reason.code === "TOOLCHAIN_VENDOR_UNSUPPORTED" &&
    reason.evidence.some((record) => record.path === "retrofit/build.gradle")));
  assert.equal(recipes.logstash.blockedReasons.length, 0);
  assert.ok(recipes.logstash.unresolvedHints.some((hint) =>
    hint.includes("vendor/jruby/lib/jruby.jar") && hint.includes("content hash")));
  for (const id of ["smarttube", "supertokens-core", "btrace", "beam", "tiled"]) {
    assert.equal(recipes[id].blockedReasons.length, 0, id);
    assert.equal(recipes[id].unresolvedHints, undefined, id);
  }
});

test("known Android package versions are structured and unknown defaults remain visible", () => {
  for (const [id, platform] of Object.entries({
    okhttp: "37", retrofit: "36", leakcanary: "36", libgdx: "36",
    nativescript: "36", smarttube: "34", ultimaterecyclerview: "34",
    "the-complete-faang-preparation": "33",
  })) {
    assert.deepEqual(recipes[id].android.platforms, [`android-${platform}`], id);
    if (recipes[id].android.buildTools.length === 0) {
      assert.ok(recipes[id].blockedReasons.length || recipes[id].unresolvedHints?.length, id);
    }
  }
  assert.deepEqual(recipes.smarttube.android.buildTools, ["30.0.3"]);
  assert.deepEqual(recipes.nativescript.android.buildTools, ["36.0.0"]);
  assert.equal(recipes["flutter-examples"].android, undefined);
});
