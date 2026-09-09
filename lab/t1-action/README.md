# JDT LS / Oracle environment modes

The comparison workflow defaults to `configured-source`. All 100 case entries
are in the existing `lab/t1-project-environments.json`; no separate YAML files
or new configuration parser are needed. `prebuilt-workspace` remains available
as an explicit legacy choice.

Each matrix job selects its entry by project ID through the existing loader.
`providers.jdtls.projectJava`, `buildJava`, and `runtimeJava` are the fixed
project, build, and server JDK inputs applied to both comparison providers.
`toolchainJava` lists additional compiler SDKs and OS-specific distributions.
`buildTool` and `buildToolVersion` select Maven or the pinned Gradle distribution;
`maven` supplies the archive checksum and `gradleWrapper` identifies the wrapper.
`sdkVersionSource`, `buildToolVersionSource`, and `environmentNotes` record
requirement evidence, baseline choices, and caveats. Case definitions and
workspace selection are unchanged.

Maven/Gradle selection remains required, and declared real descriptors are checked.
Legacy synthetic cases use their original source paths in configured-source mode;
no generated Maven descriptor is required or created for those cases.
`providers.intellij` is optional for JDT LS / Oracle comparisons; when supplied,
its settings are still validated.

Server JDK choices are retained, including BTrace Java 24. This configuration
update does not change provider JVM arguments, import logic,
or semantic probes. Environment preparation is not a promise of provider success.

Configured-source uses explicit project, build, server and compiler-toolchain
JDKs from each case. It checks pinned descriptors, wrapper versions, required
files and actual installed tools, then opens the original prepared checkout.
It does not run automatic Maven/Gradle model discovery, native compilation, or
the identical-JDK annotation-processor proof. Existing checkout preparation and
provider isolation are retained. Failed preparation prevents IDE startup and
remains `NOT_EVALUATED`; provider and diagnostic failures are not suppressed.
Configured-source does not require a root `gradlew` or `gradlew.bat` launcher and
does not copy `native-image` or other tools inside the JDK. Missing launchers and
provider-specific tool layout requirements are left to the actual import.

BTrace retains its pre-existing Windows `common.gradle` adaptation for
`javac.exe` and `javadoc.exe`. This does not change its configured JDK versions
or provider JVM arguments.

To select all 100 cases, dispatch `t1-jdtls-oracle.yml` with:

- `environment_mode`: `configured-source`
- `project_count`: `100`
- `projects`: leave empty
- `operating_system`: `windows-latest` or `macos-latest`
- `vscode_version`: `1.136.1`

The configuration change does not dispatch the workflow. In configured-source,
`nativescript`, `leetcode`, `jdk`, `playframework`,
`the-complete-faang-preparation`, `semgrep`, `curlconverter`, and
`aws-doc-sdk-examples` open their original checkout and original probe file.
Their historical synthetic mappings remain available to legacy execution only.
Their listed Maven/JDK values remain the existing baselines, not claims that the
upstream repositories are native Maven projects. Case identities, revisions,
probe symbols and the three observations are unchanged.

For the original ten-case pilot, use:

- `environment_mode`: `configured-source`
- `projects`: `guava,arthas,jjwt,javalin,mybatis-3,mockito,jadx,btrace,junit-framework,metrics`
- `operating_system`: `windows-latest` or `macos-latest`
- `vscode_version`: `1.136.1`

The ten-case selection schedules 10 environment jobs and 20 isolated provider jobs.
Records retain `comparisonMode: configured-source`; do not merge them with
historical out-of-box or prebuilt results. Provider Ready, Semantic Ready and
Workspace Diagnostics continue to use the existing collectors.

OkHttp was deferred from that pilot because its fixed probe belongs to the
default-disabled `module-tests`. It remains in the 100-case configuration list;
the project flags and fixed probe are unchanged.
