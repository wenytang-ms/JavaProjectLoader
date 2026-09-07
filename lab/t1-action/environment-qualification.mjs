import { XMLParser } from "fast-xml-parser";
import { hashValue } from "./environment-lock.mjs";

const processorConcern = "ANNOTATION_PROCESSOR_JAVA_UNVERIFIED";
const proofInput = "#native-compiler-compatibility";
const array = (value) => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

export function nativeCompilerCompatibility({
  nativeResult,
  nativeLog,
  javaInstallations,
  effectiveMavenModels,
}) {
  const unavailable = (reason) => ({ verified: false, reason });
  const compilations = [...(nativeLog ?? "").matchAll(/\bCompiling \d+ source files?([^\r\n]*)/g)];
  if (!nativeResult?.successful || !nativeResult.args?.includes("test-compile") ||
      !compilations.length || compilations.some((match) => !/\bwith javac\b/.test(match[1]))) {
    return unavailable("No successful native Maven compiler execution was observed.");
  }
  const roles = ["project", "build", "runtime"].map((role) =>
    javaInstallations?.find((entry) => entry.role === role));
  const fingerprint = (entry) => ({
    exactVersion: entry.exactVersion,
    releaseSha256: entry.releaseSha256,
    executableSha256: entry.executableSha256,
    compilerSha256: entry.compilerSha256,
  });
  if (roles.some((entry) => !entry || Object.values(fingerprint(entry)).some((value) => !value)) ||
      roles.some((entry) => hashValue(fingerprint(entry)) !== hashValue(fingerprint(roles[0])))) {
    return unavailable("Native compiler, project SDK and language server do not use identical verified JDK binaries.");
  }
  const projects = (effectiveMavenModels ?? []).flatMap(({ xml }) => {
    const parsed = parser.parse(xml);
    return array(parsed.projects?.project ?? parsed.project);
  });
  if (!projects.length) return unavailable("The effective reactor is missing.");
  const compilers = [];
  let processorsConfigured = false;
  for (const project of projects) {
    const properties = project.properties ?? {};
    if (properties["maven.compiler.fork"] && properties["maven.compiler.fork"] !== "false" ||
        properties["maven.compiler.executable"] ||
        properties["maven.compiler.compilerId"] && properties["maven.compiler.compilerId"] !== "javac" ||
        properties["maven.main.skip"] === "true" ||
        properties["maven.compiler.proc"] === "none") {
      return unavailable("Maven properties override or disable the verified in-process compiler.");
    }
    for (const plugin of array(project.build?.plugins?.plugin)) {
      if (plugin.artifactId === "maven-toolchains-plugin") {
        return unavailable("A Maven toolchain can select a different compiler JVM.");
      }
      if (plugin.artifactId !== "maven-compiler-plugin") continue;
      if (plugin.groupId && plugin.groupId !== "org.apache.maven.plugins") {
        return unavailable("The compiler plugin implementation is not the standard Maven compiler.");
      }
      const configurations = [plugin.configuration ?? {}, ...array(plugin.executions?.execution).map((execution) =>
        execution.configuration ?? {})];
      for (const configuration of configurations) {
        if (configuration.fork && configuration.fork !== "false" || configuration.executable ||
            configuration.jdkToolchain || configuration.proc === "none" || configuration.skipMain === "true" ||
            configuration.compilerId && configuration.compilerId !== "javac") {
          return unavailable("The effective compiler does not prove in-process annotation processor compatibility.");
        }
        const argumentsText = JSON.stringify([configuration.compilerArgs, configuration.compilerArgument]);
        if (argumentsText.includes("-proc:none")) return unavailable("Compiler arguments disable annotation processing.");
        processorsConfigured ||= Boolean(configuration.annotationProcessorPaths || configuration.annotationProcessors);
      }
      compilers.push({
        project: `${project.groupId}:${project.artifactId}:${project.version}`,
        version: plugin.version,
        configurations,
      });
    }
  }
  if (!processorsConfigured) return unavailable("No effective annotation processor configuration was observed.");
  return {
    verified: true,
    jdk: fingerprint(roles[0]),
    compilerConfigurationHash: hashValue(compilers),
    basis: "Native test-compile executed with the same JDK binaries used by both provider SDK/server roles.",
    minimumJavaVersionInferred: false,
  };
}

export function resolveNativeCompilerRequirements(plan, observation) {
  if (plan.build.tool !== "maven" || !plan.unresolved.some((item) => item.code === processorConcern)) return plan;
  const proof = nativeCompilerCompatibility(observation);
  if (!proof.verified) return plan;
  const result = structuredClone(plan);
  const resolved = result.unresolved.filter((item) => item.code === processorConcern);
  result.unresolved = result.unresolved.filter((item) => item.code !== processorConcern);
  result.requirements.push({
    name: "java.annotationProcessorCompatibility",
    value: proof,
    evidence: [
      { path: "native-baseline.log", reason: proof.basis },
      ...resolved.flatMap((item) => item.evidence ?? []),
    ],
  });
  result.inputHashes.push({ path: proofInput, sha256: hashValue(proof) });
  result.state = result.blockers.length ? "ENV_BLOCKED" : result.unresolved.length ? "ENV_UNVERIFIED" : "PLANNED";
  return result;
}

export function verifyNativeCompilerRequirements(plan, observation) {
  const expected = plan.inputHashes.find((entry) => entry.path === proofInput);
  if (!expected) return { verified: true };
  const proof = nativeCompilerCompatibility(observation);
  return proof.verified && expected.sha256 === hashValue(proof)
    ? proof : { verified: false, reason: proof.reason ?? "Native compiler configuration differs from qualification." };
}
