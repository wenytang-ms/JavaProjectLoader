import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value) => typeof value === "object" && value !== null ? String(value["#text"] ?? "") : String(value ?? "");
const slash = (value) => String(value).replaceAll("\\", "/");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const numericVersion = (value) => /^\d+(?:\.\d+)*$/.test(String(value));
const javaMajor = (value) => {
  const match = String(value).trim().match(/^(?:1\.)?(\d+)(?:\.0(?:[._]\d+)*)?$/);
  return match ? Number(match[1]) : null;
};

function compare(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function versionRange(value, exact = false) {
  const source = String(value).trim().replace(/\s*,\s*/g, ",");
  if (numericVersion(source)) {
    return exact ? { min: source, max: source, minInclusive: true, maxInclusive: true }
      : { min: source, minInclusive: true };
  }
  const single = source.match(/^\[(\d+(?:\.\d+)*)\]$/);
  if (single) return versionRange(single[1], true);
  const alternatives = source.match(/\[\d+(?:\.\d+)*\]|[[(](?:\d+(?:\.\d+)*)?,(?:\d+(?:\.\d+)*)?[\])]/g);
  if (alternatives?.length > 1 && alternatives.join(",") === source) {
    const options = alternatives.map((item) => versionRange(item, exact));
    return options.every(Boolean) ? { alternatives: options } : null;
  }
  const range = source.match(/^([[(])(\d+(?:\.\d+)*)?,(\d+(?:\.\d+)*)?([\])])$/);
  if (!range || (!range[2] && !range[3])) return null;
  return {
    min: range[2], max: range[3],
    minInclusive: range[1] === "[", maxInclusive: range[4] === "]",
  };
}

const rangeOptions = (range) => range.alternatives ?? [range];
const rangeBounds = (range) => rangeOptions(range).flatMap((item) => [item.min, item.max]).filter(Boolean);
const hasJavaPatchConstraint = (range) => rangeBounds(range).some((bound) => !/^(?:1\.)?\d+(?:\.0)?$/.test(bound));

function asJavaRange(range) {
  const normalized = [];
  for (const option of rangeOptions(range)) {
    const min = option.min === undefined ? undefined : javaMajor(option.min);
    const max = option.max === undefined ? undefined : javaMajor(option.max);
    if ((option.min && !min) || (option.max && !max)) return null;
    normalized.push({
      ...option,
      min: min === undefined ? undefined : String(min),
      max: max === undefined ? undefined : String(max),
    });
  }
  return normalized.length === 1 ? normalized[0] : { alternatives: normalized };
}

function accepts(version, range) {
  if (range.alternatives) return range.alternatives.some((option) => accepts(version, option));
  return (!range.min || compare(version, range.min) > 0 ||
    (range.minInclusive && compare(version, range.min) === 0)) &&
    (!range.max || compare(version, range.max) < 0 ||
      (range.maxInclusive && compare(version, range.max) === 0));
}

function incompatibleRanges(ranges) {
  let possible = [{}];
  for (const range of ranges) {
    const intersections = new Map();
    for (const left of possible) for (const right of rangeOptions(range)) {
      const intersection = {};
      for (const bound of ["min", "max"]) {
        const inclusive = `${bound}Inclusive`;
        const selected = !left[bound] ? right : !right[bound] ? left :
          compare(left[bound], right[bound]) * (bound === "min" ? 1 : -1) >= 0 ? left : right;
        intersection[bound] = selected[bound];
        intersection[inclusive] = left[bound] && right[bound] && compare(left[bound], right[bound]) === 0 ?
          left[inclusive] && right[inclusive] : selected[inclusive];
      }
      const order = intersection.min && intersection.max ? compare(intersection.min, intersection.max) : -1;
      if (order > 0 || (order === 0 && (!intersection.minInclusive || !intersection.maxInclusive))) continue;
      intersections.set(JSON.stringify(intersection), intersection);
    }
    possible = [...intersections.values()];
    if (!possible.length) return true;
  }
  return false;
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mergeObjects(parent, child) {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return child;
  if (!child || typeof child !== "object" || Array.isArray(child)) return child ?? parent;
  if (child["@_combine.self"] === "override") return child;
  const result = { ...parent };
  for (const [key, value] of Object.entries(child)) result[key] = mergeObjects(parent[key], value);
  return result;
}

function plugins(model) {
  return array(model.build?.plugins?.plugin);
}

function managedPlugins(model) {
  return array(model.build?.pluginManagement?.plugins?.plugin);
}

function selectPlugins(managed, active) {
  return mergePlugins(managed.filter((plugin) => text(plugin.artifactId) === "maven-compiler-plugin" ||
    active.some((entry) => text(entry.artifactId) === text(plugin.artifactId) &&
      (text(entry.groupId) || "org.apache.maven.plugins") === (text(plugin.groupId) || "org.apache.maven.plugins"))), active);
}

function mergePlugins(parent, child) {
  const result = new Map();
  for (const plugin of [...parent, ...child]) {
    const key = `${text(plugin.groupId) || "org.apache.maven.plugins"}:${text(plugin.artifactId)}`;
    const inherited = result.get(key);
    const merged = mergeObjects(inherited, plugin);
    if (inherited?.executions && plugin.executions) {
      const executions = new Map();
      for (const execution of [...array(inherited.executions.execution), ...array(plugin.executions.execution)]) {
        const id = text(execution.id) || "default";
        executions.set(id, mergeObjects(executions.get(id), execution));
      }
      merged.executions = { ...merged.executions, execution: [...executions.values()] };
    }
    result.set(key, merged);
  }
  return [...result.values()];
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    for (const entry of array(item)) {
      visit(key, entry);
      walk(entry, visit);
    }
  }
}

// Runtime support, not bytecode or compiler-toolchain support.
const gradleJavaSupport = [
  [8, "2.0"], [9, "4.3"], [10, "4.7"], [11, "5.0"], [12, "5.4"],
  [13, "6.0"], [14, "6.3"], [15, "6.7"], [16, "7.0"], [17, "7.3"],
  [18, "7.5"], [19, "7.6"], [20, "8.3"], [21, "8.5"], [22, "8.8"],
  [23, "8.10"], [24, "8.14"], [25, "9.1"], [26, "9.4"],
];

/**
 * Read-only discovery. Effective Maven models must be captured by a separate native
 * model invocation at this checkout/commit; this function never executes build code.
 * Gradle extension metadata refines only corresponding per-project requirements.
 * Bare Maven XML does not establish its generating JVM, profiles or environment;
 * downstream qualification must regenerate the model under the selected launcher.
 */
export function discoverEnvironmentPlan(project, {
  checkoutPath, operatingSystem, recipe = null, effectiveMavenModels = [],
  effectiveGradleModel = null,
} = {}) {
  if (!checkoutPath || !operatingSystem || !project?.id || !project.commit) {
    throw new Error("Environment discovery requires checkoutPath, operatingSystem, project.id and commit.");
  }
  const checkout = path.resolve(checkoutPath);
  const setup = project.projectSetup ?? {};
  const oldJava = setup.providers?.jdtls?.projectJava ?? {};
  const plan = {
    schemaVersion: 1, project: project.id, commit: project.commit, operatingSystem,
    scope: "native", buildRoot: ".", state: "PLANNED",
    java: {
      project: { version: "", distribution: oldJava.distribution ?? "temurin" },
      build: { version: "", distribution: "temurin" },
      runtime: { version: "", distribution: "temurin" },
      toolchains: {
        versions: [], distribution: setup.toolchainJava?.distribution ?? oldJava.distribution ?? "temurin",
        ...(setup.toolchainJava?.distributionsByOs
          ? { distributionsByOs: structuredClone(setup.toolchainJava.distributionsByOs) } : {}),
      },
    },
    build: { tool: setup.buildTool === "gradle" ? "gradle" : "maven", version: "" },
    requirements: [], inputHashes: [], blockers: [], unresolved: [],
  };
  const hashes = new Map();
  hashes.set("lab/t1-project-environments.json#selected-project", digest(JSON.stringify({
    project: project.id, commit: project.commit, relativeFile: project.relativeFile,
    javaVersion: project.javaVersion, projectSetup: setup,
  })));
  const requirements = new Set();
  const addIssue = (collection, code, message, evidence = []) => {
    if (!collection.some((item) => item.code === code && item.message === message)) {
      collection.push({ code, message, ...(evidence.length ? { evidence } : {}) });
    }
  };
  const block = (code, message, evidence) => addIssue(plan.blockers, code, message, evidence);
  const uncertain = (code, message, evidence) => addIssue(plan.unresolved, code, message, evidence);
  const requirement = (name, value, evidence) => {
    const item = { name, value: String(value), evidence };
    const key = JSON.stringify(item);
    if (!requirements.has(key)) {
      requirements.add(key);
      plan.requirements.push(item);
    }
  };
  let audited = recipe;
  if (recipe && recipe.commit !== project.commit) {
    block("RECIPE_COMMIT_MISMATCH", `Recipe commit ${recipe.commit} does not match ${project.commit}.`);
    audited = null;
  }
  const constraints = audited?.constraints ?? {};
  const nativeGradle = effectiveGradleModel && typeof effectiveGradleModel === "object" &&
    numericVersion(effectiveGradleModel.gradleVersion) && Array.isArray(effectiveGradleModel.projects) &&
    effectiveGradleModel.projects.length > 0 && effectiveGradleModel.projects.every((item) =>
      item && typeof item.path === "string" && /^:(?:[\w.-]+(?::[\w.-]+)*)?$/.test(item.path)) &&
    new Set(effectiveGradleModel.projects.map((item) => item.path)).size === effectiveGradleModel.projects.length &&
    (effectiveGradleModel.compilers === undefined || (Array.isArray(effectiveGradleModel.compilers) &&
      effectiveGradleModel.compilers.every((item) => item && typeof item.task === "string")))
    ? effectiveGradleModel : null;
  if (effectiveGradleModel && !nativeGradle) block("INVALID_GRADLE_MODEL", "Native Gradle evidence requires a numeric version and an identified project graph.");
  if (nativeGradle) hashes.set("gradle-native-model#effective-model", digest(JSON.stringify(nativeGradle)));
  const recipeEvidence = (audited?.evidence ?? []).map((item) => ({
    ...item, path: item.path ?? "lab/t1-environment-recipes.json",
  }));
  if (audited?.android !== undefined) {
    const android = audited.android;
    const packagePatterns = {
      platforms: /^(?:android-)?\d+$/,
      buildTools: /^\d+(?:\.\d+){1,2}$/,
      ndkVersions: /^\d+(?:\.\d+){1,3}$/,
    };
    if (!android || typeof android !== "object" || Array.isArray(android) ||
      Object.entries(packagePatterns).some(([key, pattern]) => android[key] !== undefined &&
        (!Array.isArray(android[key]) || android[key].some((value) => typeof value !== "string" || !pattern.test(value))))) {
      block("INVALID_ANDROID_RECIPE", "Android recipes require concrete platform, build-tools and NDK package version arrays.", recipeEvidence);
    } else {
      plan.android = structuredClone(android);
      if (plan.android.platforms) {
        plan.android.platforms = plan.android.platforms.map((platform) =>
          platform.startsWith("android-") ? platform : `android-${platform}`);
      }
      for (const key of Object.keys(packagePatterns)) {
        for (const version of plan.android[key] ?? []) requirement(`android.${key}`, version, recipeEvidence);
      }
    }
  }
  const supplements = (kind, evidence) => {
    const keys = kind === "maven" ? ["mavenExact", "mavenMin"] :
      kind === "build" ? ["buildJavaMin"] : ["projectJavaMin", "toolchainJavaVersions"];
    return keys.some((key) => constraints[key] !== undefined) && recipeEvidence.some((item) =>
      evidence.some((source) => item.path === source.path || (item.url && item.url === source.url)));
  };
  const repositoryFile = (relative, label = "Input") => {
    if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
      block("PATH_OUTSIDE_CHECKOUT", `${label} is not repository-relative: ${relative}.`);
      return null;
    }
    const absolute = path.resolve(checkout, ...slash(relative).split("/"));
    if (!contained(checkout, absolute) ||
      (fs.existsSync(absolute) && !contained(fs.realpathSync(checkout), fs.realpathSync(absolute)))) {
      block("PATH_OUTSIDE_CHECKOUT", `${label} escapes checkout: ${relative}.`);
      return null;
    }
    return absolute;
  };
  const read = (relative, required = false) => {
    const absolute = repositoryFile(relative);
    if (!absolute) return null;
    if (!fs.existsSync(absolute)) {
      if (required) block("MISSING_INPUT", `Required environment input is missing: ${relative}.`, [{ path: relative }]);
      return null;
    }
    if (!fs.statSync(absolute).isFile()) {
      block("INVALID_INPUT", `Environment input is not a file: ${relative}.`, [{ path: relative }]);
      return null;
    }
    const bytes = fs.readFileSync(absolute);
    const file = { path: slash(path.relative(checkout, absolute)), content: bytes.toString("utf8").replace(/^\uFEFF/, "") };
    hashes.set(file.path, digest(bytes));
    return file;
  };
  const evidence = (file, marker, reason) => {
    const index = marker ? file.content.indexOf(marker) : -1;
    return [{
      path: file.path,
      ...(index >= 0 ? { line: file.content.slice(0, index).split("\n").length } : {}),
      ...(reason ? { reason } : {}),
    }];
  };
  const exists = (relative) => {
    const absolute = repositoryFile(relative);
    return absolute && fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  };
  const descriptorsAt = (directory) => ({
    maven: exists(path.posix.join(directory, "pom.xml")),
    gradle: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"]
      .some((file) => exists(path.posix.join(directory, file))),
  });
  let buildRoot = slash(audited?.buildRoot ?? project.workspaceRoot ?? ".");
  if (!audited?.buildRoot && !project.workspaceRoot && project.relativeFile &&
    !Object.values(descriptorsAt(".")).some(Boolean)) {
    let directory = path.posix.dirname(slash(project.relativeFile));
    while (directory !== "." && directory !== "/" && !directory.startsWith("..")) {
      if (Object.values(descriptorsAt(directory)).some(Boolean)) buildRoot = directory;
      directory = path.posix.dirname(directory);
    }
  }
  const root = repositoryFile(buildRoot, "Build root");
  plan.buildRoot = root ? slash(path.relative(checkout, root)) || "." : buildRoot;
  plan.scope = audited?.scope ?? (plan.buildRoot === "." ? "native" : "java-subproject");
  if (!["native", "java-subproject", "synthetic"].includes(plan.scope)) {
    block("INVALID_SCOPE", `Unknown environment scope: ${plan.scope}.`);
  }
  if (project.syntheticMavenTargetFile || setup.buildDescriptorRoot === "workspace" || plan.scope === "synthetic") {
    plan.scope = "synthetic";
    block("SYNTHETIC_NATIVE_COMPARISON", "A generated single-file Maven fixture is not a native repository import.");
  }
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    block("MISSING_BUILD_ROOT", `Native build root does not exist: ${buildRoot}.`);
  }
  if (!project.relativeFile) {
    block("MISSING_PROBE", "A repository-relative Java probe is required.");
  } else {
    const probe = repositoryFile(project.relativeFile, "Probe");
    if (probe && root && !contained(root, probe)) {
      block("PROBE_OUTSIDE_BUILD_ROOT", `Probe ${project.relativeFile} is outside ${plan.buildRoot}.`,
        [{ path: slash(project.relativeFile) }]);
    }
    if (probe) read(project.relativeFile, true);
  }
  for (const item of audited?.blockedReasons ?? []) {
    block(item.code, item.message, item.evidence ?? recipeEvidence);
  }
  for (const hint of audited?.unresolvedHints ?? []) {
    uncertain("RECIPE_UNRESOLVED", hint, recipeEvidence);
  }
  if (audited) hashes.set("lab/t1-environment-recipes.json#selected-recipe", digest(JSON.stringify(audited)));

  const projectVersions = [];
  const compilerVersions = new Set();
  const configuredToolchains = new Set();
  const buildRanges = [];
  const mavenRanges = [];
  let mavenWrapperRecommendation = null;
  let mavenWrapperEvidence = [];
  let buildCompilerMinimum = 0;
  let runtimeMinimum = 21;
  const addJava = (value, role, source, exact = false, preferredMinimum = 0) => {
    let range = versionRange(text(value), exact);
    if (range) {
      if (hasJavaPatchConstraint(range)) {
        uncertain("JAVA_PATCH_CONSTRAINT", `Java patch-level constraint ${text(value)} needs exact installation qualification.`, source);
      }
      range = asJavaRange(range);
    }
    if (!range) {
      uncertain("UNRESOLVED_JAVA_VERSION", `Cannot resolve ${role} Java requirement: ${text(value)}.`, source);
      return null;
    }
    requirement(`java.${role}`, text(value), source);
    if (role === "build") {
      buildRanges.push({ ...range, evidence: source });
      return null;
    }
    const candidates = Array.from({ length: 26 }, (_, i) => i + 1).filter((version) => accepts(version, range));
    let version = candidates.find((candidate) => candidate >= preferredMinimum) ?? candidates[0];
    if (!version) {
      uncertain("UNSUPPORTED_JAVA_VERSION", `No supported Java major satisfies ${text(value)}.`, source);
      return null;
    }
    if (role === "project" && version < 8) {
      version = 8;
      requirement("java.legacyCompilerFloor", "8", [{
        path: "java-compiler-compatibility",
        reason: "Legacy source/bytecode levels are not exact compiler toolchains; Java 8 is the oldest configured modern JDK baseline.",
      }]);
    }
    if (role === "toolchain" && version < 8) {
      uncertain("LEGACY_EXACT_TOOLCHAIN", `Exact Java ${version} compiler provisioning needs an audited supported vendor.`, source);
    }
    if (role === "toolchain") compilerVersions.add(version);
    if (role === "runtime") runtimeMinimum = Math.max(runtimeMinimum, version);
    else projectVersions.push(version);
    return version;
  };
  const addMaven = (value, source, exact = false) => {
    const range = versionRange(value, exact);
    if (!range) {
      uncertain("UNRESOLVED_MAVEN_VERSION", `Cannot resolve Maven version constraint: ${value}.`, source);
      return;
    }
    requirement("maven.version", value, source);
    mavenRanges.push({ ...range, evidence: source });
  };
  for (const [key, role] of [["projectJavaMin", "project"], ["buildJavaMin", "build"], ["runtimeJavaMin", "runtime"]]) {
    if (constraints[key] !== undefined) addJava(constraints[key], role, recipeEvidence);
  }
  for (const version of constraints.toolchainJavaVersions ?? []) addJava(version, "toolchain", recipeEvidence, true);
  if (constraints.mavenExact !== undefined) addMaven(constraints.mavenExact, recipeEvidence, true);
  if (constraints.mavenMin !== undefined) addMaven(constraints.mavenMin, recipeEvidence);
  for (const version of setup.toolchainJava?.versions ?? []) {
    const major = javaMajor(version);
    const source = [{ path: "lab/t1-project-environments.json", reason: "Preserved explicit installed toolchain/vendor contract; not a source compiler requirement." }];
    if (!major || major > 26) uncertain("UNSUPPORTED_CONFIGURED_TOOLCHAIN", `Cannot resolve configured toolchain ${version}.`, source);
    else {
      configuredToolchains.add(major);
      requirement("java.configuredToolchain", version, source);
    }
  }

  const descriptors = root && fs.existsSync(root) ? descriptorsAt(plan.buildRoot) : { maven: false, gradle: false };
  const available = Object.keys(descriptors).filter((tool) => descriptors[tool]);
  if (!available.length) {
    block("NO_NATIVE_BUILD", `No native Maven or Gradle descriptor exists at ${plan.buildRoot}.`);
  } else {
    plan.build.tool = available.includes(setup.buildTool) ? setup.buildTool : available[0];
  }
  if (audited?.buildTool !== undefined) {
    if (!["maven", "gradle"].includes(audited.buildTool)) {
      block("INVALID_RECIPE_BUILD_TOOL", `Unsupported audited build tool: ${audited.buildTool}.`, recipeEvidence);
    } else {
      plan.build.tool = audited.buildTool;
      requirement("build.tool", audited.buildTool, recipeEvidence);
      if (!available.includes(audited.buildTool)) {
        block("RECIPE_BUILD_TOOL_UNAVAILABLE", `Audited ${audited.buildTool} descriptor is absent from ${plan.buildRoot}.`, recipeEvidence);
      }
    }
  }

  const effective = new Map();
  const effectiveReactor = [];
  for (const item of effectiveMavenModels) {
    if (typeof item.path !== "string" || typeof item.xml !== "string" || !repositoryFile(item.path)) {
      block("INVALID_EFFECTIVE_MODEL", "Effective Maven models require repository-relative path and XML.");
      continue;
    }
    const modelPath = slash(path.relative(checkout, repositoryFile(item.path)));
    if (effective.has(modelPath)) block("DUPLICATE_EFFECTIVE_MODEL", `Multiple effective models supplied for ${modelPath}.`);
    const validation = XMLValidator.validate(item.xml);
    if (validation !== true) {
      block("INVALID_MAVEN_XML", `Invalid effective Maven XML for ${modelPath}: ${validation.err.msg}.`,
        [{ path: modelPath, line: validation.err.line }]);
      continue;
    }
    const supplied = xmlParser.parse(item.xml);
    if (supplied.projects?.project) {
      hashes.set(`${modelPath}#effective-reactor`, digest(item.xml));
      const builder = new XMLBuilder({ ignoreAttributes: false });
      for (const model of array(supplied.projects.project)) {
        effectiveReactor.push({ model, xml: builder.build({ project: model }), origin: modelPath });
      }
    } else effective.set(modelPath, item.xml);
  }
  const parsePom = (file) => {
    const validation = XMLValidator.validate(file.content);
    if (validation !== true) {
      block("INVALID_MAVEN_XML", `Invalid Maven XML in ${file.path}: ${validation.err.msg}.`,
        [{ path: file.path, line: validation.err.line }]);
      return null;
    }
    const model = xmlParser.parse(file.content)?.project;
    if (!model || typeof model !== "object") {
      block("INVALID_MAVEN_MODEL", `Missing Maven project element in ${file.path}.`, [{ path: file.path }]);
      return null;
    }
    return model;
  };
  const contexts = new Map();
  const loading = new Set();
  const mavenProfiles = [];
  const interpolate = (value, properties) => {
    let result = text(value);
    const seen = new Set();
    while (/\$\{[^}]+\}/.test(result) && !seen.has(result)) {
      seen.add(result);
      result = result.replace(/\$\{([^}]+)\}/g, (original, key) =>
        Object.hasOwn(properties, key) ? text(properties[key]) : original);
    }
    return result;
  };
  const sameMavenIdentity = (model, raw) => ["artifactId", "groupId", "version"].every((key) => {
    const value = text(raw[key] ?? (key !== "artifactId" ? raw.parent?.[key] : undefined));
    return (!value || value.includes("${")) ? key !== "artifactId" : text(model[key]) === value;
  });
  const loadPom = (relative) => {
    relative = slash(path.posix.normalize(slash(relative)));
    if (contexts.has(relative)) return contexts.get(relative);
    if (loading.has(relative)) {
      block("MAVEN_PARENT_CYCLE", `Maven parent cycle at ${relative}.`, [{ path: relative }]);
      return null;
    }
    const source = read(relative, true);
    if (!source) return null;
    loading.add(relative);
    const raw = parsePom(source);
    if (!raw) { loading.delete(relative); return null; }
    if (!effective.has(relative) && effectiveReactor.length) {
      const candidates = effectiveReactor.filter(({ model }) => sameMavenIdentity(model, raw));
      if (candidates.length === 1) effective.set(relative, candidates[0].xml);
      else if (candidates.length > 1) {
        block("AMBIGUOUS_EFFECTIVE_MODEL", `Multiple native reactor models match ${relative}.`, [{ path: relative }]);
      }
    }
    let model = raw;
    let file = source;
    let parent = null;
    if (effective.has(relative)) {
      const xml = effective.get(relative);
      hashes.set(`${relative}#effective-model`, digest(xml));
      file = { path: relative, content: xml };
      model = parsePom(file);
      requirement("maven.effectiveModel", digest(xml), [{
        path: relative,
        reason: "Requirements read from supplied effective Maven XML; raw source is independently hashed. The XML hash alone does not prove applicability to the planned Maven JVM, profiles or environment.",
      }]);
      requirement("maven.modelApplicability", "launcher-qualification-required", [{
        path: relative,
        reason: "Qualify with the actual selected Maven/JVM, prepared descriptor hashes, active profiles and relevant properties/environment; supplied XML is not that execution proof.",
      }]);
      if (!model) { loading.delete(relative); return null; }
      if (!sameMavenIdentity(model, raw)) {
        block("MAVEN_EFFECTIVE_IDENTITY_CONFLICT", `Native effective model does not identify the source project at ${relative}.`, [{ path: relative }]);
      }
    } else if (raw.parent) {
      const parentPath = raw.parent.relativePath === undefined ? "../pom.xml" : text(raw.parent.relativePath);
      const candidate = parentPath ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), slash(parentPath))) : null;
      const parentEvidence = evidence(source, "<parent", "Maven parent inheritance.");
      if (candidate && !candidate.startsWith("../") && exists(candidate)) {
        parent = loadPom(candidate);
        if (parent) {
          for (const key of ["groupId", "artifactId", "version"]) {
            const expected = interpolate(raw.parent[key], raw.properties ?? {});
            const actual = interpolate(parent.model[key] ?? parent.model.parent?.[key], parent.properties);
            if (expected && actual && !expected.includes("${") && expected !== actual) {
              uncertain("MAVEN_PARENT_COORDINATES", `Local parent ${candidate} does not match ${key}=${expected}.`, parentEvidence);
              parent = null;
              break;
            }
          }
        }
      }
      if (!parent) {
        const coordinates = ["groupId", "artifactId", "version"].map((key) => text(raw.parent[key])).join(":");
        requirement("maven.externalParent", coordinates, parentEvidence);
        if (!supplements("project", parentEvidence)) {
          uncertain("EXTERNAL_MAVEN_PARENT", `Effective Maven model required for external parent ${coordinates} of ${relative}.`, parentEvidence);
        }
      }
    }
    const properties = {
      ...(parent?.properties ?? {}), ...(model.properties ?? {}),
      "project.version": text(model.version ?? model.parent?.version),
      "pom.version": text(model.version ?? model.parent?.version),
      "project.groupId": text(model.groupId ?? model.parent?.groupId),
      "project.artifactId": text(model.artifactId),
    };
    if (parent && !parent.effective && array(parent.model.profiles?.profile).some((profile) =>
      Object.keys(profile.properties ?? {}).some((key) => javaProperty.test(key)) ||
      [...plugins(profile), ...managedPlugins(profile)].some((plugin) =>
        ["maven-compiler-plugin", "maven-enforcer-plugin", "maven-toolchains-plugin"].includes(text(plugin.artifactId))))) {
      uncertain("INHERITED_MAVEN_PROFILE",
        `${relative} inherits profile-sensitive compiler/tool requirements from ${parent.file.path}; a native effective model is required.`,
        evidence(parent.file, "<profiles"));
    }
    const managed = mergePlugins(parent?.managed ?? [], managedPlugins(model));
    const active = mergePlugins((parent?.active ?? []).filter((plugin) => text(plugin.inherited) !== "false"), plugins(model));
    const context = {
      file, source, model, properties,
      managed, active, plugins: selectPlugins(managed, active),
      effective: effective.has(relative),
    };
    contexts.set(relative, context);
    loading.delete(relative);
    return context;
  };
  const javaProperty = /^(?:maven\.compiler\.(?:release|source|target|testRelease|testSource|testTarget)|java\.version|jdk\.version|javaVersion|jdkVersion|java\.source\.version|java\.target\.version|java\.minimum\.version)$/i;
  const inspectMaven = (context, fragment = context.model, props = context.properties, selectedPlugins = context.plugins) => {
    const { file } = context;
    const localReleases = [];
    const localToolchains = [];
    const toolchainRequests = [];
    const resolve = (value) => interpolate(value, props);
    const record = (value, role, marker, exact = false) => {
      if (role === "toolchain") {
        toolchainRequests.push({ value: resolve(value), source: evidence(file, marker), exact });
        return null;
      }
      const version = addJava(resolve(value), role,
        evidence(file, marker, context.effective ? "Resolved native Maven model." : "Maven source/property requirement."), exact);
      if (version && role === "project") localReleases.push(version);
      return version;
    };
    for (const [key, value] of Object.entries(props)) {
      if (javaProperty.test(key)) record(value, "project", `<${key}>`);
      if (/^(?:buildJdk|build\.jdk|build\.java\.version|java\.version\.required)$/i.test(key)) record(value, "build", `<${key}>`);
      if (/^(?:maven\.version|maven\.minimum\.version|mavenVersion)$/i.test(key)) {
        addMaven(resolve(value), evidence(file, `<${key}>`));
      }
    }
    if (fragment.prerequisites?.maven) addMaven(resolve(fragment.prerequisites.maven), evidence(file, "<prerequisites"));
    for (const plugin of selectedPlugins) {
      const artifact = text(plugin.artifactId);
      if (artifact === "maven-compiler-plugin") {
        walk(plugin, (key, value) => {
          if (/^(?:release|source|target|testRelease|testSource|testTarget)$/.test(key)) record(value, "project", `<${key}>`);
          if (key === "jdkToolchain" && value?.version) record(value.version, "toolchain", "<jdkToolchain", true);
          if (key === "compilerVersion") record(value, "toolchain", "<compilerVersion", true);
          if (key === "executable") uncertain("MAVEN_COMPILER_EXECUTABLE", `Explicit compiler executable ${resolve(value)} requires native JDK identity evidence.`, evidence(file, "<executable>"));
          if (key === "annotationProcessorPaths" || key === "annotationProcessors") {
            const source = evidence(file, `<${key}>`, "Processor coordinates or class names do not establish their minimum executable JDK.");
            const processors = key === "annotationProcessorPaths" ? array(value?.path) : array(value?.annotationProcessor);
            if (!processors.length && (value === "" || value === null ||
              (typeof value === "object" && Object.keys(value).every((name) => name.startsWith("@_"))))) return;
            for (const processor of processors) {
              const identifier = key === "annotationProcessorPaths" ?
                ["groupId", "artifactId", "version"].map((part) => resolve(processor?.[part])).join(":") :
                resolve(processor);
              requirement("maven.annotationProcessor", identifier, source);
            }
            const processorEvidence = recipeEvidence.some((item) =>
              /annotation|processor|dependenc(?:y|ies).*(?:classfile|bytecode|jdk|java)/i.test(item.reason ?? ""));
            if (!processorEvidence || (!supplements("project", source) && !supplements("build", source))) {
              uncertain("ANNOTATION_PROCESSOR_JAVA_UNVERIFIED",
                `Annotation processors in ${file.path} need dependency-bytecode/source evidence or an audited compiler-JDK constraint.`, source);
            }
          }
        });
      }
      if (artifact === "maven-toolchains-plugin") {
        walk(plugin, (key, value) => {
          if (key === "jdk" && value?.version) record(value.version, "toolchain", "<jdk>", true);
          if (key === "version" && typeof value === "string" && plugin.configuration?.version === value) {
            record(value, "toolchain", "<configuration", true);
          }
          if (key === "vendor") {
            const vendor = resolve(value);
            requirement("java.toolchainVendor", vendor, evidence(file, "<vendor>"));
            const configured = new Set([plan.java.toolchains.distribution, ...Object.values(plan.java.toolchains.distributionsByOs ?? {})]);
            if (!configured.has(vendor) && !/^(?:eclipse|adoptium|temurin)$/i.test(vendor)) {
              uncertain("TOOLCHAIN_VENDOR_UNVERIFIED", `Maven toolchain vendor ${vendor} needs an explicit installed vendor mapping.`, evidence(file, "<vendor>"));
            }
          }
        });
      }
      if (artifact === "maven-enforcer-plugin") {
        walk(plugin, (key, value) => {
          if (key === "requireJavaVersion" && value?.version) record(value.version, "build", "<requireJavaVersion");
          if (key === "requireMavenVersion" && value?.version) addMaven(resolve(value.version), evidence(file, "<requireMavenVersion"));
        });
      }
    }
    for (const request of toolchainRequests) {
      const version = addJava(request.value, "toolchain", request.source, request.exact,
        Math.max(javaMajor(constraints.projectJavaMin) ?? 0, ...localReleases));
      if (version) localToolchains.push(version);
    }
    if (text(context.model.packaging) !== "pom" && localReleases.length) {
      const needed = Math.max(...localReleases);
      if (!localToolchains.length) buildCompilerMinimum = Math.max(buildCompilerMinimum, needed);
      else if (Math.max(...localToolchains) < needed) {
        block("COMPILER_TOOLCHAIN_CONFLICT", `Compiler toolchains in ${file.path} cannot compile its required Java ${needed}.`,
          evidence(file, "<configuration"));
      }
    }
  };
  const visitedModules = new Set();
  const visitReactor = (relative, moduleEvidence = []) => {
    if (visitedModules.has(relative)) return;
    visitedModules.add(relative);
    if (moduleEvidence.length && !exists(relative)) {
      requirement("maven.missingModule", relative, moduleEvidence);
      uncertain("MISSING_MAVEN_MODULE",
        `Declared Maven module ${relative} is absent; checkout/bootstrap or a generated native model is required.`, moduleEvidence);
      return;
    }
    const context = loadPom(relative);
    if (!context) return;
    inspectMaven(context);
    const visitModules = (fragment, properties) => {
      for (const entry of array(fragment.modules?.module)) {
        const module = interpolate(entry, properties);
        if (module.includes("${")) {
          uncertain("UNRESOLVED_MAVEN_MODULE", `Unresolved module ${module} in ${relative}.`, evidence(context.file, "<module>"));
          continue;
        }
        const modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(relative), slash(module)));
        const modulePom = modulePath.endsWith(".xml") ? modulePath : path.posix.join(modulePath, "pom.xml");
        visitReactor(modulePom, evidence(context.file, "<module>", `Declared reactor module ${module}.`));
      }
    };
    visitModules(context.model, context.properties);
    if (!context.effective) for (const profile of array(context.model.profiles?.profile)) {
      const activation = profile.activation ?? {};
      const activeDefault = text(activation.activeByDefault) === "true";
      if (activation.jdk && (activation.property || activation.os || activation.file)) {
        uncertain("CONDITIONAL_MAVEN_PROFILE",
          `Profile ${text(profile.id)} combines JDK and other activation conditions; native activation evidence is required.`,
          evidence(context.file, "<profiles"));
      } else if (activation.jdk) {
        mavenProfiles.push({ context, profile, visitModules });
      } else if (activeDefault && !activation.property && !activation.os && !activation.file) {
        const properties = { ...context.properties, ...(profile.properties ?? {}) };
        inspectMaven(context, profile, properties, selectPlugins(mergePlugins(context.managed, managedPlugins(profile)), mergePlugins(context.active, plugins(profile))));
        visitModules(profile, properties);
      } else if ((activation.property || activation.os || activation.file) &&
        /(?:java|jdk|maven-compiler|maven-toolchains|maven-enforcer|"modules")/i.test(JSON.stringify(profile))) {
        uncertain("CONDITIONAL_MAVEN_PROFILE", `Profile ${text(profile.id)} requires native activation evidence.`, evidence(context.file, "<profiles"));
      }
    }
  };

  const gradleProperties = {};
  const ambiguousGradleProperties = new Set();
  const gradleFileProperties = new Map();
  const gradleProjectDirectories = new Map([[":", plan.buildRoot]]);
  const gradleConcerns = new Map();
  let gradleFiles = [];
  let gradleToolchainDeclared = false;
  let observedGradleBuildJava = null;
  const gradleCode = (content) => content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\r\n]*/gm, "$1");
  const scanGradle = () => {
    const pending = [root];
    const candidates = [];
    const moduleDirectories = new Set([slash(path.relative(checkout, root)) || "."]);
    for (const item of nativeGradle?.projects ?? []) {
      const directory = path.posix.join(plan.buildRoot, item.path.slice(1).replaceAll(":", "/"));
      moduleDirectories.add(directory);
      gradleProjectDirectories.set(item.path, directory);
    }
    const sharedDirectories = ["gradle", "buildSrc", "build-logic", "conventions"]
      .map((directory) => path.posix.join(plan.buildRoot, directory));
    const appliedScripts = new Set();
    let dynamicIncludes = false;
    const skip = new Set([".git", ".gradle", ".idea", "node_modules", "target", "build", "out", ".next"]);
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const relative = slash(path.relative(checkout, absolute));
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) pending.push(absolute);
        } else if (entry.isFile() && (/\.(?:gradle(?:\.kts)?|versions\.toml)$/.test(entry.name) ||
          entry.name === "gradle.properties" ||
          (/(?:^|\/)(?:buildSrc|build-logic|conventions)(?:\/|$)/.test(relative) && /\.(?:kt|java|groovy)$/.test(entry.name)))) {
          candidates.push(relative);
        }
      }
    }
    const selected = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const relative of candidates) {
        if (selected.has(relative)) continue;
        const shared = sharedDirectories.some((directory) => relative.startsWith(`${directory}/`)) &&
          !/(?:^|\/)src\/(?:test|testFixtures)\//.test(relative);
        if (!dynamicIncludes && !moduleDirectories.has(path.posix.dirname(relative)) && !shared && !appliedScripts.has(relative)) continue;
        selected.add(relative);
        changed = true;
        const file = read(relative);
        if (!file) continue;
        gradleFiles.push(file);
        const content = gradleCode(file.content);
        if (/settings\.gradle(?:\.kts)?$/.test(relative)) {
          const relocated = new Map();
          for (const match of content.matchAll(/project\s*\(\s*["']([^"']+)["']\s*\)\.projectDir\s*=\s*file\s*\(\s*["']([^"']+)["']/g)) {
            const directory = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[2]));
            relocated.set(match[1].replace(/^:/, ""), directory);
            moduleDirectories.add(directory);
            if (path.posix.dirname(relative) === plan.buildRoot) {
              gradleProjectDirectories.set(`:${match[1].replace(/^:/, "")}`, directory);
            }
          }
          for (const match of content.matchAll(/\b(includeBuild|include)\s*(?:\(([^)]*)\)|([^\r\n]+))/g)) {
            const expression = match[2] ?? match[3];
            const names = [...expression.matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
            if (!names.length || /[$+]/.test(expression) || expression.replace(/["'][^"']+["']/g, "").replace(/[,\s]/g, "")) {
              dynamicIncludes = !nativeGradle;
              const message = `Settings include expression ${expression} needs native project graph evidence.`;
              uncertain("DYNAMIC_GRADLE_MODULES", message, evidence(file, match[0]));
              gradleConcerns.set(message, { file: relative, kind: match[1] === "includeBuild" ? "includedBuild" : "projectGraph" });
              continue;
            }
            for (const name of names) {
              const directory = relocated.get(name.replace(/^:/, "")) ??
                path.posix.normalize(path.posix.join(path.posix.dirname(relative), name.replace(/^:/, "").replaceAll(":", "/")));
              const absolute = repositoryFile(directory, "Gradle included project");
              if (match[1] === "include" && path.posix.dirname(relative) === plan.buildRoot) {
                gradleProjectDirectories.set(`:${name.replace(/^:/, "")}`, directory);
              }
              if (absolute && contained(root, absolute) && fs.existsSync(absolute)) moduleDirectories.add(directory);
              else uncertain("GRADLE_INCLUDED_BUILD", `Included project ${directory} needs native checkout/model evidence.`, evidence(file, match[0]));
            }
          }
          for (const match of content.matchAll(/\.projectDir\s*=\s*(?:file|File)\s*\(\s*["']([^"']+)["']/g)) {
            moduleDirectories.add(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
          }
        }
        for (const match of content.matchAll(/\bapply\s*(?:\(\s*from\s*=\s*|from\s*:\s*)["']([^"']+)["']/g)) {
          if (/[$]/.test(match[1])) {
            uncertain("DYNAMIC_GRADLE_SCRIPT", `Applied Gradle script ${match[1]} needs native resolution.`, evidence(file, match[0]));
          } else {
            const script = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
            if (!candidates.includes(script)) uncertain("DYNAMIC_GRADLE_SCRIPT", `Applied Gradle script ${match[1]} is external, missing, or not a supported local script.`, evidence(file, match[0]));
            else appliedScripts.add(script);
          }
        }
      }
    }
    gradleFiles.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of gradleFiles) {
      const local = {};
      for (const match of gradleCode(file.content).matchAll(/^\s*(?:def |val |var |(?:public |private |static |final )*(?:String|int|JavaVersion) )?([\w.-]+)\s*=\s*([^;\r\n]+)[;]?\s*$/gm)) {
        const key = match[1];
        const value = match[2].trim();
        local[key] = value;
        if (gradleProperties[key] !== undefined && gradleProperties[key] !== value) {
          ambiguousGradleProperties.add(key);
        } else gradleProperties[key] = value;
      }
      gradleFileProperties.set(file.path, local);
    }
  };
  const resolveGradle = (value, seen = new Set(), filePath) => {
    let expression = String(value).trim().replace(/[;,]$/, "").trim();
    expression = expression.replace(/^["'](.*)["']$/, "$1");
    if (numericVersion(expression)) return javaMajor(expression);
    const constant = expression.match(/^(?:JavaVersion\.)?VERSION_(1_\d+|\d+)$/);
    if (constant) return javaMajor(constant[1].replace("_", "."));
    const call = expression.match(/^(?:JavaLanguageVersion\.of|JavaVersion\.toVersion|JavaVersion\.valueOf)\((.*)\)$/);
    if (call) return resolveGradle(call[1], seen, filePath);
    expression = expression.replace(/^\$\{([^}]+)\}$/, "$1")
      .replace(/^(?:project|rootProject)\.(?:ext\.)?/, "")
      .replace(/^(?:providers\.)?gradleProperty\(["']([^"']+)["']\)(?:\.get\(\))?$/, "$1")
      .replace(/^(?:findProperty|property)\(["']([^"']+)["']\)$/, "$1")
      .replace(/^libs\.versions\.([\w.]+)\.get\(\)$/, "$1");
    const local = gradleFileProperties.get(filePath) ?? {};
    const inherited = gradleFileProperties.get(path.posix.join(path.posix.dirname(filePath ?? "."), "gradle.properties")) ?? {};
    const properties = { ...gradleProperties, ...inherited, ...local };
    if (ambiguousGradleProperties.has(expression) && !Object.hasOwn(local, expression) && !Object.hasOwn(inherited, expression)) return null;
    if (!seen.has(expression) && Object.hasOwn(properties, expression)) {
      seen.add(expression);
      return resolveGradle(properties[expression], seen, filePath);
    }
    return null;
  };
  const gradleRequirement = (expression, role, file, marker) => {
    const source = evidence(file, marker, "Statically resolved Gradle declaration; no DSL was executed.");
    const version = resolveGradle(expression, new Set(), file.path);
    if (version) addJava(version, role, source, role === "toolchain");
    else if (!supplements(role, source)) {
      const message = `Cannot statically resolve ${role} Java expression ${expression} in ${file.path}.`;
      uncertain("UNRESOLVED_GRADLE_JAVA", message, source);
      let kind = role === "toolchain" ? "javaToolchain" :
        /\bsourceCompatibility\b/.test(marker) ? "sourceCompatibility" :
          /\btargetCompatibility\b/.test(marker) ? "targetCompatibility" : role;
      const prefix = gradleCode(file.content).split(marker)[0];
      const scopes = [];
      for (const token of prefix.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(allprojects|subprojects|compilerFor)\s*\{|\b(?:tasks\.)?(?:named|register|create)(?:<\s*JavaCompile\s*>)?\(\s*["']([^"']+)["'][^)]*\)\s*\{|[{}]/g)) {
        if (token[1]) scopes.push(token[1]);
        else if (token[2]) scopes.push({ task: token[2] });
        else if (token[0] === "{") scopes.push(null);
        else if (token[0] === "}") scopes.pop();
      }
      if (kind === "javaToolchain" && scopes.includes("compilerFor")) kind = "taskCompiler";
      gradleConcerns.set(message, {
        file: file.path, kind,
        scope: scopes.filter((scope) => scope === "allprojects" || scope === "subprojects").at(-1) ?? "project",
        task: scopes.findLast((scope) => scope?.task)?.task ?? null,
      });
    } else requirement(`java.${role}.auditedExpression`, expression, [...source, ...recipeEvidence]);
  };
  let selectMavenVersion = () => {};
  if (descriptors.maven && plan.build.tool === "maven") {
    visitReactor(path.posix.join(plan.buildRoot, "pom.xml"));
    const wrapper = read(path.posix.join(plan.buildRoot, ".mvn", "wrapper", "maven-wrapper.properties"));
    if (wrapper) {
      const version = wrapper.content.match(/apache-maven-(\d+\.\d+\.\d+)-bin\.(?:zip|tar\.gz)/)?.[1];
      if (version) {
        mavenWrapperRecommendation = version;
        mavenWrapperEvidence = evidence(wrapper, "distributionUrl",
          "The harness uses its selected Maven executable; wrapper distribution is not an enforcer minimum.");
        requirement("maven.wrapperRecommendation", version, mavenWrapperEvidence);
      }
      else uncertain("UNRESOLVED_MAVEN_WRAPPER", "Cannot resolve the Maven wrapper distribution version.", evidence(wrapper));
    }
    for (const name of ["jvm.config", "maven.config"]) {
      const config = read(path.posix.join(plan.buildRoot, ".mvn", name));
      if (config && /--add-(?:opens|exports)/.test(config.content)) {
        addJava("9", "build", evidence(config, "--add-", "JVM module flags require Java 9 or newer."));
      }
      if (config && /--enable-preview/.test(config.content)) {
        const release = projectVersions.length ? Math.max(...projectVersions) : null;
        if (release) addJava(release, "build", evidence(config, "--enable-preview", "Preview features require the matching compiler/runtime major."), true);
        else uncertain("MAVEN_PREVIEW_VERSION", "Preview JVM flags require an evidenced matching Java release.", evidence(config));
      }
      if (config && [...contexts.values()].some((context) => !context.effective) &&
        /(?:^|\s)-P|(?:^|\s)-D(?:java|jdk|maven\.compiler)[.\w-]*=/m.test(config.content)) {
        uncertain("MAVEN_LAUNCH_CONFIGURATION", `${config.path} requires native launch/profile evaluation.`, evidence(config));
      }
      if (config && /(?:^|\s)(?:-f|--file)(?:[=\s]|$)/m.test(config.content)) {
        uncertain("MAVEN_DESCRIPTOR_OVERRIDE", `${config.path} changes the native descriptor; the selected import root must be audited.`, evidence(config));
      }
    }
    const extensions = read(path.posix.join(plan.buildRoot, ".mvn", "extensions.xml"));
    if (extensions) {
      requirement("maven.extensions", "native-build-extensions", evidence(extensions));
      if ([...contexts.values()].some((context) => !context.effective) && !supplements("build", evidence(extensions))) {
        uncertain("MAVEN_EXTENSION_REQUIREMENTS", "Maven build extensions require a successful native effective model or audited build-JDK evidence.", evidence(extensions));
      }
    }
    selectMavenVersion = () => {
      for (const item of plan.requirements.filter((entry) => entry.name === "maven.selectedVersion")) requirements.delete(JSON.stringify(item));
      plan.requirements = plan.requirements.filter((item) => item.name !== "maven.selectedVersion");
      delete plan.build.sha512;
      delete plan.build.downloadUrl;
      const validOld = numericVersion(setup.buildToolVersion) && setup.buildTool === "maven" ? setup.buildToolVersion : null;
      const candidateVersions = [...new Set([validOld, mavenWrapperRecommendation, ...mavenRanges.flatMap(rangeBounds)].filter(Boolean))];
      const compatible = candidateVersions.filter((version) => /^\d+\.\d+\.\d+$/.test(version) && mavenRanges.every((range) => accepts(version, range)));
      plan.build.version = compatible.includes(validOld) ? validOld :
        compatible.includes(mavenWrapperRecommendation) ? mavenWrapperRecommendation : compatible.sort(compare)[0] ?? "";
      if (!plan.build.version) {
        if (incompatibleRanges(mavenRanges)) {
          block("MAVEN_VERSION_CONFLICT", "Maven exact/range constraints have no compatible supplied version.", mavenRanges.flatMap((item) => item.evidence));
        } else {
          uncertain("AMBIGUOUS_MAVEN_VERSION", "No evidenced, fully specified Maven version satisfies all constraints.", mavenRanges.flatMap((item) => item.evidence));
        }
      }
      if (plan.build.version) {
        const major = Number(plan.build.version.split(".")[0]);
        if (![3, 4].includes(major)) uncertain("UNSUPPORTED_MAVEN_VERSION", `Maven ${plan.build.version} JVM compatibility is not supported.`);
        addJava(major >= 4 ? "17" : "8", "build", [{
          path: "maven-runtime-compatibility",
          url: "https://maven.apache.org/docs/history.html",
          reason: `Maven ${plan.build.version} minimum runtime JVM.`,
        }]);
        plan.build.downloadUrl = `https://archive.apache.org/dist/maven/maven-${major}/${plan.build.version}/binaries/apache-maven-${plan.build.version}-bin.zip`;
        if (plan.build.version === setup.buildToolVersion && setup.maven?.downloadUrl === plan.build.downloadUrl && setup.maven?.sha512) {
          plan.build.sha512 = setup.maven.sha512;
        }
        requirement("maven.selectedVersion", plan.build.version, [
          ...mavenRanges.flatMap((item) => item.evidence),
          ...(plan.build.version === validOld ?
            [{ path: "lab/t1-project-environments.json", reason: "Existing explicit Maven pin satisfies the discovered constraints." }] :
            plan.build.version === mavenWrapperRecommendation ? mavenWrapperEvidence : []),
        ]);
      }
    };
    selectMavenVersion();
  } else if (descriptors.gradle && plan.build.tool === "gradle") {
    scanGradle();
    const wrapperPath = path.posix.join(plan.buildRoot, "gradle", "wrapper", "gradle-wrapper.properties");
    const wrapper = read(wrapperPath);
    if (wrapper) {
      plan.build.wrapperPath = wrapper.path;
      const version = wrapper.content.match(/gradle-([0-9][0-9A-Za-z.-]*)-(?:bin|all)\.zip/)?.[1];
      if (version) {
        plan.build.version = version;
        requirement("gradle.wrapperVersion", version, evidence(wrapper, "distributionUrl"));
      } else uncertain("UNRESOLVED_GRADLE_WRAPPER", "Cannot resolve Gradle wrapper distribution version.", evidence(wrapper));
    } else if (constraints.gradleVersion) {
      plan.build.version = String(constraints.gradleVersion);
      requirement("gradle.version", plan.build.version, recipeEvidence);
    } else {
      plan.build.version = setup.buildTool === "gradle" ? setup.buildToolVersion ?? "" : "";
      uncertain("MISSING_GRADLE_WRAPPER", "Native Gradle version needs an audited pin or wrapper.");
    }
    if (constraints.gradleVersion && plan.build.version !== String(constraints.gradleVersion)) {
      block("GRADLE_VERSION_CONFLICT", `Wrapper Gradle ${plan.build.version} conflicts with audited ${constraints.gradleVersion}.`, recipeEvidence);
    }
    const daemonCriteria = read(path.posix.join(plan.buildRoot, "gradle", "gradle-daemon-jvm.properties"));
    if (daemonCriteria) {
      const properties = Object.fromEntries([...daemonCriteria.content.matchAll(/^\s*([\w.]+)\s*[=:]\s*(.*?)\s*$/gm)]
        .map((match) => [match[1], match[2]]));
      if (numericVersion(plan.build.version) && compare(plan.build.version, "8.8") >= 0) {
        if (properties.toolchainVersion) {
          addJava(properties.toolchainVersion, "build", evidence(daemonCriteria, "toolchainVersion",
            "Committed Gradle daemon JVM criteria select the build JVM, not the project compiler target."), true);
        } else {
          uncertain("GRADLE_DAEMON_CRITERIA_UNRESOLVED", "Gradle daemon JVM criteria do not identify a concrete Java version.", evidence(daemonCriteria));
        }
        if (properties.toolchainVendor) {
          requirement("gradle.daemonVendor", properties.toolchainVendor, evidence(daemonCriteria, "toolchainVendor"));
          if (!/^(?:ADOPTIUM|ECLIPSE_ADOPTIUM|TEMURIN)$/i.test(properties.toolchainVendor)) {
            uncertain("GRADLE_DAEMON_VENDOR_UNVERIFIED",
              `Daemon vendor ${properties.toolchainVendor} needs an audited build-JDK vendor mapping.`, evidence(daemonCriteria, "toolchainVendor"));
          }
        }
        if (properties.toolchainImplementation && !/^VENDOR[_-]SPECIFIC$/i.test(properties.toolchainImplementation)) {
          uncertain("GRADLE_DAEMON_IMPLEMENTATION_UNVERIFIED",
            `Daemon implementation ${properties.toolchainImplementation} needs native installation evidence.`, evidence(daemonCriteria, "toolchainImplementation"));
        }
      } else {
        requirement("gradle.inactiveDaemonCriteria", daemonCriteria.path, evidence(daemonCriteria, null,
          "Daemon JVM criteria are supported only from Gradle 8.8; they are not an older wrapper's JVM requirement."));
      }
    }
    for (const file of gradleFiles) {
      const content = gradleCode(file.content);
      for (const match of content.matchAll(/\b(?:sourceCompatibility|targetCompatibility)\s*(?:=\s*|\(\s*)([^\r\n;{}]+)|\b(?:options\.)?release\s*(?:\.set\s*\(\s*|=\s*)([^\r\n;{}]+)/g)) {
        let expression = (match[1] ?? match[2]).trim();
        if (expression.endsWith(")") && !/^(?:JavaVersion\.toVersion|JavaLanguageVersion\.of)\(/.test(expression)) expression = expression.slice(0, -1);
        gradleRequirement(expression, "project", file, match[0]);
      }
      for (const match of content.matchAll(/\b(?:languageVersion|jvmToolchain)\s*(?:\.set\s*\(\s*|=\s*|\(\s*)(JavaLanguageVersion\.of\([^)\r\n]+\)|[^)\r\n;{}]+)/g)) {
        gradleToolchainDeclared = true;
        gradleRequirement(match[1], "toolchain", file, match[0]);
      }
      for (const match of content.matchAll(/\b(?:javaVersion|jdkVersion|javaLanguageVersion|java\.version|jdk\.version)\s*=\s*([^\r\n;{}]+)/g)) {
        gradleRequirement(match[1], "project", file, match[0]);
      }
      for (const match of content.matchAll(/\b(?:buildJavaVersion|buildJdk|minimumJavaVersion|minJavaVersion)\s*=\s*([^\r\n;{}]+)/g)) {
        gradleRequirement(match[1], "build", file, match[0]);
      }
      for (const match of content.matchAll(/\bvendor\s*(?:\.set\s*\(\s*|=\s*)JvmVendorSpec\.([A-Z_]+)/g)) {
        const distributions = { ADOPTIUM: "temurin", AZUL: "zulu", BELLSOFT: "liberica", AMAZON: "corretto", ORACLE: "oracle", MICROSOFT: "microsoft", GRAAL_VM: "graalvm" };
        const vendor = distributions[match[1]];
        requirement("java.toolchainVendor", match[1], evidence(file, match[0]));
        const selected = plan.java.toolchains.distributionsByOs?.[operatingSystem] ?? plan.java.toolchains.distribution;
        if (!vendor || vendor !== selected) uncertain("TOOLCHAIN_VENDOR_UNVERIFIED", `Gradle vendor ${match[1]} does not match configured ${selected}.`, evidence(file, match[0]));
      }
      for (const match of content.matchAll(/\bincludeBuild\s*\(?\s*["']([^"']+)["']/g)) {
        const included = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
        const absolute = repositoryFile(included, "Gradle included build");
        if (absolute && (!contained(root, absolute) || !fs.existsSync(absolute))) {
          uncertain("GRADLE_INCLUDED_BUILD", `Included build ${included} needs separate native model evidence.`, evidence(file, match[0]));
        }
      }
    }
    if (nativeGradle && nativeGradle.gradleVersion !== plan.build.version) {
      block("GRADLE_NATIVE_VERSION_CONFLICT", `Native Gradle ${nativeGradle.gradleVersion} differs from wrapper/pin ${plan.build.version}.`);
    } else if (nativeGradle) {
      const nativeEvidence = (item) => [{
        path: "gradle-native-model",
        reason: `Native Gradle model for ${item.path ?? item.task}; source build inputs are independently hashed.`,
      }];
      const nativeProjects = new Map(nativeGradle.projects.map((item) => [item.path, item]));
      const javaFields = ["javaToolchain", "sourceCompatibility", "targetCompatibility"];
      const resolvedMajor = (value) => {
        const major = javaMajor(value);
        return major !== null && major > 0 && major <= 26;
      };
      requirement("gradle.observedVersion", nativeGradle.gradleVersion, nativeEvidence({ path: ":" }));
      if (nativeGradle.buildJavaVersion) {
        requirement("gradle.observedBuildJava", nativeGradle.buildJavaVersion, nativeEvidence({ path: ":" }));
        observedGradleBuildJava = javaMajor(nativeGradle.buildJavaVersion);
        if (!observedGradleBuildJava || observedGradleBuildJava > 26) {
          uncertain("GRADLE_OBSERVED_BUILD_UNVERIFIED",
            `Native Gradle build JVM ${nativeGradle.buildJavaVersion} is not a supported known Java major.`, nativeEvidence({ path: ":" }));
        }
      }
      for (const item of nativeGradle.projects) {
        for (const field of ["sourceCompatibility", "targetCompatibility"]) {
          if (item[field] !== undefined && item[field] !== null) addJava(item[field], "project", nativeEvidence(item));
        }
        if (item.javaToolchain !== undefined && item.javaToolchain !== null) {
          gradleToolchainDeclared = true;
          addJava(item.javaToolchain, "toolchain", nativeEvidence(item), true);
          const compiler = javaMajor(item.javaToolchain);
          const release = Math.max(javaMajor(item.sourceCompatibility) ?? 0, javaMajor(item.targetCompatibility) ?? 0);
          if (compiler && release > compiler) {
            uncertain("GRADLE_NATIVE_COMPILER_CONFLICT",
              `Project ${item.path} requests Java ${release} with a Java ${compiler} extension toolchain; per-task compiler evidence is required.`,
              nativeEvidence(item));
          }
        }
      }
      for (const item of nativeGradle.compilers ?? []) {
        for (const field of ["sourceCompatibility", "targetCompatibility"]) {
          if (item[field] !== undefined && item[field] !== null) addJava(item[field], "project", nativeEvidence(item));
        }
        if (item.compilerVersion !== undefined && item.compilerVersion !== null) {
          requirement("gradle.observedCompiler", item.compilerVersion, nativeEvidence(item));
          const compiler = javaMajor(item.compilerVersion);
          if (!compiler || compiler > 26) {
            uncertain("GRADLE_COMPILER_VERSION_UNVERIFIED",
              `Task ${item.task} does not identify a supported compiler Java version.`, nativeEvidence(item));
          } else {
            addJava(String(compiler), "runtime", nativeEvidence(item));
            if (compiler !== observedGradleBuildJava && !compilerVersions.has(compiler)) {
              gradleToolchainDeclared = true;
              addJava(String(compiler), "toolchain", nativeEvidence(item), true);
            }
            const release = Math.max(javaMajor(item.sourceCompatibility) ?? 0, javaMajor(item.targetCompatibility) ?? 0);
            if (release > compiler) {
              uncertain("GRADLE_TASK_COMPILER_CONFLICT",
                `Task ${item.task} requests Java ${release} with compiler Java ${compiler}.`, nativeEvidence(item));
            }
          }
        }
      }
      const completeKnownGraph = [...gradleProjectDirectories.keys()].every((name) => nativeProjects.has(name));
      // Extension fields do not prove task releases, build-JVM minima or included-build requirements.
      plan.unresolved = plan.unresolved.filter((item) => {
        const concern = gradleConcerns.get(item.message);
        if (!concern) return true;
        let covered = [];
        if (concern.kind === "projectGraph" && completeKnownGraph &&
          path.posix.dirname(concern.file) === plan.buildRoot) {
          covered = nativeGradle.projects;
        } else if (javaFields.includes(concern.kind) &&
          /(?:^|\/)(?:build\.gradle(?:\.kts)?|gradle\.properties)$/.test(concern.file)) {
          const projectPaths = [...gradleProjectDirectories].filter(([, directory]) =>
            directory === path.posix.dirname(concern.file)).map(([name]) => name);
          const affected = concern.scope === "project" ?
            projectPaths.every((name) => nativeProjects.has(name)) ? projectPaths.map((name) => nativeProjects.get(name)) : [] :
            completeKnownGraph && projectPaths.includes(":") ? nativeGradle.projects.filter((entry) =>
              (concern.scope !== "subprojects" || entry.path !== ":") &&
              javaFields.some((field) => entry[field] !== null && entry[field] !== undefined)) : [];
          if (affected.length && affected.every((entry) => resolvedMajor(entry[concern.kind]))) covered = affected;
        } else if (concern.kind === "taskCompiler" && concern.task &&
          /(?:^|\/)build\.gradle(?:\.kts)?$/.test(concern.file)) {
          const projectPaths = [...gradleProjectDirectories].filter(([, directory]) =>
            directory === path.posix.dirname(concern.file)).map(([name]) => name);
          const requested = projectPaths.map((name) => `${name === ":" ? "" : name}:${concern.task}`);
          const selected = (nativeGradle.compilers ?? []).filter((compiler) => requested.includes(compiler.task));
          if (requested.length && selected.length === requested.length &&
            selected.every((compiler) => resolvedMajor(compiler.compilerVersion))) covered = selected;
        }
        if (!covered.length) return true;
        requirement("gradle.nativeRefinement", item.message, [
          ...(item.evidence ?? []), ...covered.flatMap(nativeEvidence),
        ]);
        return false;
      });
    }
  }

  if (!projectVersions.length) {
    const configured = javaMajor(oldJava.version ?? project.javaVersion);
    if (configured) projectVersions.push(configured);
    uncertain("PROJECT_JAVA_UNVERIFIED", "No resolved source or audited compiler Java requirement; the old contract alone is not qualification evidence.");
  }
  let requiredJava = projectVersions.length ? Math.max(...projectVersions) : null;
  const chooseBuildJava = () => {
    let lower = 1;
    let upper = 26;
    if (plan.build.tool === "gradle") {
      const version = plan.build.version;
      if (!numericVersion(version) || compare(version, "2") < 0 || compare(version, "10") >= 0) {
        uncertain("UNSUPPORTED_GRADLE_COMPATIBILITY", `Gradle ${version || "(unknown)"} has no supported runtime compatibility bounds.`);
        return null;
      }
      lower = compare(version, "9") >= 0 ? 17 : 8;
      upper = gradleJavaSupport.filter(([, since]) => compare(version, since) >= 0).at(-1)?.[0] ?? 8;
      requirement("gradle.buildJvmRange", `[${lower},${upper}]`, [{
        path: plan.build.wrapperPath ?? "gradle-runtime-compatibility",
        url: "https://docs.gradle.org/current/userguide/compatibility.html",
        reason: "Conservative known Gradle runtime bounds, distinct from Java compiler toolchains.",
      }]);
    }
    if (plan.build.tool === "maven") {
      lower = Math.max(lower, buildCompilerMinimum,
        compilerVersions.size ? 0 : requiredJava ?? 0);
    } else {
      const unresolvedCompilers = plan.unresolved.filter((item) =>
        ["javaToolchain", "taskCompiler"].includes(gradleConcerns.get(item.message)?.kind));
      const compilerSelectionUnknown = gradleToolchainDeclared &&
        (!compilerVersions.size || unresolvedCompilers.length > 0);
      if (compilerSelectionUnknown) {
        uncertain("GRADLE_COMPILER_SELECTION_UNVERIFIED",
          "A separate compiler is declared but not fully resolved; the bootstrap JVM uses proven Gradle/build bounds pending native refinement.",
          unresolvedCompilers.flatMap((item) => item.evidence ?? []));
      }
      const compileOnBuild = !gradleToolchainDeclared || (!compilerSelectionUnknown &&
        (requiredJava && Math.max(...compilerVersions) < requiredJava));
      if (compileOnBuild && requiredJava) lower = Math.max(lower, requiredJava);
    }
    const candidates = Array.from({ length: 26 }, (_, i) => i + 1)
      .filter((version) => version >= lower && version <= upper && buildRanges.every((range) => accepts(version, range)));
    if (!candidates.length) {
      block("BUILD_JAVA_CONFLICT", `No supported build JVM satisfies compiler, enforcer and ${plan.build.tool} runtime bounds.`,
        buildRanges.flatMap((item) => item.evidence));
      return null;
    }
    if (plan.build.tool === "gradle" && observedGradleBuildJava) {
      // Prefer the observed daemon without turning the current JVM into a minimum.
      if (candidates.includes(observedGradleBuildJava)) return observedGradleBuildJava;
      uncertain("GRADLE_OBSERVED_BUILD_CONFLICT",
        `Observed Gradle JVM ${observedGradleBuildJava} does not satisfy the planned source/runtime constraints; reprovision and native refinement are required.`);
    }
    const explicit = javaMajor(setup.providers?.jdtls?.buildJava?.version);
    if (explicit && candidates.includes(explicit)) return explicit;
    if (plan.build.tool === "gradle") {
      const preferred = [21, 17, 11, 8].find((version) => candidates.includes(version));
      return preferred ?? candidates[0];
    }
    return candidates[0];
  };
  let buildJava = chooseBuildJava();
  for (const { context, profile, visitModules } of mavenProfiles) {
    const jdk = text(profile.activation.jdk);
    const negative = jdk.startsWith("!");
    const expression = negative ? jdk.slice(1) : jdk;
    let range = /^[[(]/.test(expression) ? versionRange(expression) : null;
    if (range && hasJavaPatchConstraint(range)) {
      uncertain("UNRESOLVED_JDK_PROFILE", `JDK profile activation ${jdk} requires exact installation-version evidence.`, evidence(context.file, "<jdk>"));
      continue;
    }
    if (range) range = asJavaRange(range);
    let active;
    if (range) active = buildJava !== null && accepts(buildJava, range);
    else if (/^(?:1\.)?\d+(?:\.0)?$/.test(expression) && javaMajor(expression)) active = buildJava === javaMajor(expression);
    else {
      uncertain("UNRESOLVED_JDK_PROFILE", `Cannot resolve JDK profile activation ${jdk}.`, evidence(context.file, "<jdk>"));
      continue;
    }
    if (negative) active = !active;
    if (active) {
      const props = { ...context.properties, ...(profile.properties ?? {}) };
      inspectMaven(context, profile, props, selectPlugins(mergePlugins(context.managed, managedPlugins(profile)), mergePlugins(context.active, plugins(profile))));
      visitModules(profile, props);
      requirement("maven.activeJdkProfile", text(profile.id), evidence(context.file, "<jdk>", `Activated by planned build JVM ${buildJava}.`));
    }
  }
  if (mavenProfiles.length) {
    selectMavenVersion();
    requiredJava = projectVersions.length ? Math.max(...projectVersions) : null;
    const refined = chooseBuildJava();
    if (refined !== buildJava) uncertain("MAVEN_PROFILE_REFINEMENT", "JDK-activated profiles changed the build JVM; a native effective model is required.");
    buildJava = refined;
  }
  if (plan.build.tool === "gradle" && gradleToolchainDeclared) {
    if (numericVersion(plan.build.version) && compare(plan.build.version, "6.7") < 0) {
      block("GRADLE_TOOLCHAIN_UNSUPPORTED", `Gradle ${plan.build.version} predates Java toolchains.`);
    }
    for (const version of compilerVersions) {
      const minimum = version === 20 ? "8.1" : version === 21 ? "8.4" : gradleJavaSupport.find(([java]) => java === version)?.[1];
      if (minimum && numericVersion(plan.build.version) && compare(plan.build.version, minimum) < 0) {
        uncertain("GRADLE_TOOLCHAIN_COMPATIBILITY", `Java ${version} toolchain support is not verified for Gradle ${plan.build.version}.`);
      }
    }
  }
  plan.java.project.version = requiredJava ? String(requiredJava) : "";
  plan.java.build.version = buildJava ? String(buildJava) : "";
  plan.java.runtime.version = String(Math.max(runtimeMinimum, requiredJava ?? 0, buildJava ?? 0, ...compilerVersions));
  plan.java.toolchains.versions = [...new Set([...compilerVersions, ...configuredToolchains])].sort((a, b) => a - b).map(String);
  requirement("java.runtimeBaseline", plan.java.runtime.version, [{
    path: "provider-runtime-policy",
    reason: "Identical Temurin provider runtimes: at least Java 21 and the required project/compiler/build-plugin Java.",
  }]);
  plan.inputHashes = [...hashes].map(([file, sha256]) => ({ path: file, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  plan.state = plan.blockers.length ? "ENV_BLOCKED" : plan.unresolved.length ? "ENV_UNVERIFIED" : "PLANNED";
  return plan;
}

export function applyEnvironmentPlan(project, plan) {
  if (plan.schemaVersion !== 1 || plan.project !== project.id || plan.commit !== project.commit) {
    throw new Error("Environment plan does not match this project and commit.");
  }
  const result = structuredClone(project);
  if (plan.comparisonMode === "configured-source") {
    result.comparisonMode = plan.comparisonMode;
    delete result.syntheticMavenTargetFile;
  }
  result.javaVersion = plan.java.project.version;
  result.workspaceRoot = plan.buildRoot;
  const setup = result.projectSetup ??= {};
  setup.buildTool = plan.build.tool;
  const originalVersion = setup.buildToolVersion;
  setup.buildToolVersion = plan.build.version;
  setup.buildToolVersionSource = plan.comparisonMode === "configured-source"
    ? "Reviewed explicit environment for the pinned checkout; no native compilation gate."
    : "Dynamic environment plan for the pinned checkout; qualification is recorded separately.";
  if (plan.build.tool === "gradle" && !plan.build.wrapperPath) {
    setup.bootstrapGradleVersion = plan.build.version;
  } else {
    delete setup.bootstrapGradleVersion;
  }
  const actualInputs = plan.inputHashes.filter((item) => !item.path.includes("#")).map((item) => item.path);
  setup.buildDescriptors = {
    maven: actualInputs.filter((file) => /(?:^|\/)pom\.xml$/.test(file)),
    gradle: actualInputs.filter((file) => /\.gradle(?:\.kts)?$/.test(file)),
  };
  setup.buildDescriptorRoot = "repository";
  setup.evidenceFiles = [...new Set([...actualInputs, project.relativeFile].filter(Boolean))];
  setup.providers ??= {};
  for (const provider of ["jdtls", "oracle"]) {
    const settings = setup.providers[provider] ??= { vscodeSettings: {} };
    settings.projectJava = structuredClone(plan.java.project);
    settings.buildJava = { source: "setup-java", ...structuredClone(plan.java.build) };
    settings.runtimeJava = { source: "setup-java", ...structuredClone(plan.java.runtime) };
    settings.vscodeSettings ??= {};
    if (provider === "jdtls") {
      settings.vscodeSettings["java.import.maven.enabled"] = plan.build.tool === "maven";
      settings.vscodeSettings["java.import.gradle.enabled"] = plan.build.tool === "gradle";
      settings.vscodeSettings["java.import.gradle.wrapper.enabled"] = plan.build.tool === "gradle";
      if (plan.build.tool === "gradle") {
        settings.vscodeSettings["java.import.gradle.version"] = plan.build.version;
      } else {
        delete settings.vscodeSettings["java.import.gradle.version"];
        delete settings.vscodeSettings["java.import.gradle.home"];
      }
    }
  }
  if (plan.java.toolchains.versions.length) setup.toolchainJava = structuredClone(plan.java.toolchains);
  else delete setup.toolchainJava;
  if (plan.build.tool === "maven") {
    const major = plan.build.version.split(".")[0];
    const downloadUrl = plan.build.downloadUrl ??
      `https://archive.apache.org/dist/maven/maven-${major}/${plan.build.version}/binaries/apache-maven-${plan.build.version}-bin.zip`;
    const oldMaven = setup.maven;
    setup.maven = { downloadUrl };
    if (plan.build.sha512) setup.maven.sha512 = plan.build.sha512;
    else if (originalVersion === plan.build.version && oldMaven?.downloadUrl === downloadUrl && oldMaven.sha512) setup.maven.sha512 = oldMaven.sha512;
    delete setup.gradleWrapper;
  } else {
    delete setup.maven;
    if (plan.build.wrapperPath) setup.gradleWrapper = { path: plan.build.wrapperPath, enabled: true };
    else delete setup.gradleWrapper;
  }
  return result;
}

export function environmentGithubOutputs(plan) {
  return {
    projectJavaVersion: String(plan.java.project.version),
    projectJavaDistribution: plan.java.project.distribution,
    buildJavaVersion: String(plan.java.build.version),
    buildJavaDistribution: plan.java.build.distribution,
    runtimeJavaVersion: String(plan.java.runtime.version),
    runtimeJavaDistribution: plan.java.runtime.distribution,
    toolchainJavaVersions: plan.java.toolchains.versions.join("\n"),
    toolchainJavaDistribution: plan.java.toolchains.distributionsByOs?.[plan.operatingSystem] ?? plan.java.toolchains.distribution,
    buildTool: plan.build.tool,
    buildToolVersion: String(plan.build.version),
    scope: plan.scope,
    buildRoot: plan.buildRoot,
    state: plan.state,
  };
}
