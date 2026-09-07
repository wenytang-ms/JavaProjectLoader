import path from "node:path";

export function applyJavaPlatformPolicy(plan, { platform = process.platform, architecture = process.arch } = {}) {
  if (platform !== "darwin" || architecture !== "arm64") return plan;
  const result = structuredClone(plan);
  for (const role of ["project", "build"]) {
    const java = result.java[role];
    if (java.version !== "8" || java.distribution !== "temurin") continue;
    java.distribution = "zulu";
    result.requirements.push({
      name: "java.platformDistribution",
      value: { role, version: "8", distribution: "zulu", platform, architecture },
      evidence: [{
        path: "jdk-platform-policy",
        reason: "Temurin 8 has no macOS ARM64 package. Use native Zulu 8 without changing Java requirements; compilation and binary-lock checks still apply.",
      }],
    });
  }
  return result;
}

export function setupJavaPackageVersion(home, toolCacheRoot, platform = process.platform) {
  if (!home || !toolCacheRoot) throw new Error("The setup-java installation cache was not recorded.");
  const paths = platform === "win32" ? path.win32 : path.posix;
  const parts = paths.relative(toolCacheRoot, home).split(paths.sep);
  if (!/^Java_.+_jdk$/.test(parts[0]) || !/^(?:x64|arm64|x86)$/.test(parts[2]) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(parts[1])) {
    throw new Error(`Java home is not an identifiable setup-java package: ${home}`);
  }
  // setup-java stores its package SemVer with "+" replaced by "-" in the tool cache.
  // This is not java.version: e.g. package 21.0.12+101.0 can report runtime 21.0.12.1.
  const cached = parts[1];
  if (cached.endsWith("-ea")) return cached;
  return cached.includes("-ea.")
    ? `${cached.replace("-ea.", "+")}-ea`
    : cached.replace("-", "+");
}

export function lockedSetupJavaVersion(installation) {
  const version = installation?.setupJavaVersion;
  if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error(`Missing valid setup-java package version for locked ${installation?.role ?? "unknown"} JDK.`);
  }
  return version;
}

export function verifyJavaHomeSelectors(installations, environment = process.env) {
  const normalize = (home) => {
    const resolved = path.resolve(home);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const errors = [];
  const selectors = {
    project: "T1_PROJECT_JAVA_HOME",
    build: "T1_BUILD_JAVA_HOME",
    runtime: "T1_LANGUAGE_SERVER_JAVA_HOME",
    sdk: "T1_ANDROID_SDK_JAVA_HOME",
  };
  for (const [role, selector] of Object.entries(selectors)) {
    const expected = installations.find((item) => item.role === role);
    if (!expected) continue;
    if (!environment[selector] || normalize(environment[selector]) !== normalize(expected.home)) {
      errors.push({ selector, reason: "selected-jdk-home-mismatch" });
    }
  }
  const homes = new Set(installations.map((item) => normalize(item.home)));
  const configured = new Set((environment.T1_TOOLCHAIN_JAVA_HOMES ?? "")
    .split(";").filter(Boolean).map(normalize));
  if (homes.size !== configured.size || [...configured].some((home) => !homes.has(home))) {
    errors.push({ selector: "T1_TOOLCHAIN_JAVA_HOMES", reason: "compiler-homes-mismatch" });
  }
  for (const version of new Set(installations.map((item) => item.version))) {
    const selector = `JDK${version}`;
    const selected = environment[selector];
    if (!selected || !installations.some((item) =>
      item.version === version && normalize(item.home) === normalize(selected))) {
      errors.push({ selector, reason: "compiler-alias-mismatch" });
    }
  }
  return errors;
}

export function activateBuildJava(environment = process.env, platform = process.platform) {
  const home = environment.T1_BUILD_JAVA_HOME ?? environment.T1_PROJECT_JAVA_HOME;
  if (!home) throw new Error("The planned build JVM has not been provisioned.");
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const bin = implementation.join(home, "bin");
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const normalize = (entry) => platform === "win32" ? entry.toLowerCase() : entry;
  const rest = (environment[key] ?? "").split(implementation.delimiter)
    .filter((entry) => entry && normalize(entry) !== normalize(bin));
  environment.JAVA_HOME = home;
  environment[key] = [bin, ...rest].join(implementation.delimiter);
  return home;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function createMavenToolchainsXml(installations) {
  const entries = new Map();
  for (const installation of installations) {
    const major = String(installation.expectedVersion ?? installation.version);
    if (!/^\d+$/.test(major) || !installation.home || !installation.distribution) {
      throw new Error("A Maven toolchain requires a verified major version, home and distribution.");
    }
    // Maven projects use both 8 and 1.8 when requesting the same Java 8 toolchain.
    const versions = new Set([
      major,
      installation.exactVersion,
      ...(major === "8" ? ["1.8"] : []),
    ].filter(Boolean));
    for (const version of versions) {
      const key = `${version}|${installation.distribution}|${installation.home}`;
      entries.set(key, [
        "  <toolchain>",
        "    <type>jdk</type>",
        `    <provides><version>${xml(version)}</version><vendor>${xml(installation.distribution)}</vendor></provides>`,
        `    <configuration><jdkHome>${xml(installation.home)}</jdkHome></configuration>`,
        "  </toolchain>",
      ].join("\n"));
    }
  }
  if (!entries.size) throw new Error("No verified Maven compiler toolchains are available.");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<toolchains>\n${[...entries.values()].join("\n")}\n</toolchains>\n`;
}
