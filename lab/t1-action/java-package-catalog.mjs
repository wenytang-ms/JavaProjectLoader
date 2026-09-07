export function comparableJavaPackageVersion(version) {
  return version.replace(/\.LTS(?=-ea$|$)/, "");
}

export async function canonicalJavaPackageVersion({
  version,
  distribution,
  platform = process.platform,
  architecture = process.arch,
  fetchCatalog = fetch,
}) {
  if (distribution !== "temurin") return version;
  const feature = version.match(/^(\d+)\./)?.[1];
  const os = { win32: "windows", darwin: "mac", linux: "linux" }[platform];
  const arch = { x64: "x64", arm64: "aarch64", ia32: "x86" }[architecture];
  if (!feature || !os || !arch) throw new Error("Unsupported Java package catalog request.");
  const earlyAccess = version.endsWith("-ea");
  const wanted = comparableJavaPackageVersion(version);
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({
      architecture: arch, os, image_type: "jdk", jvm_impl: "hotspot",
      heap_size: "normal", project: "jdk", vendor: "adoptium",
      page: String(page), page_size: "100", sort_order: "DESC",
    });
    const response = await fetchCatalog(
      `https://api.adoptium.net/v3/assets/feature_releases/${feature}/${earlyAccess ? "ea" : "ga"}?${query}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Temurin package catalog returned HTTP ${response.status}.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("Temurin package catalog is not an array.");
    const matches = new Set(releases.filter((release) => release.binaries?.some((binary) =>
      binary.architecture === arch && binary.os === os && binary.image_type === "jdk"))
      .map((release) => release.version_data?.semver)
      .filter((candidate) => typeof candidate === "string")
      .map((candidate) => earlyAccess ? `${candidate.replace("-beta+", "+")}-ea` : candidate)
      .filter((candidate) => comparableJavaPackageVersion(candidate) === wanted));
    if (matches.size > 1) throw new Error(`Ambiguous Temurin package identity for ${version}.`);
    if (matches.size === 1) return [...matches][0];
    if (releases.length < 100) break;
  }
  throw new Error(`No catalog package matches installed Temurin ${version} on ${os}/${arch}.`);
}
