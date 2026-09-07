import path from "node:path";

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
