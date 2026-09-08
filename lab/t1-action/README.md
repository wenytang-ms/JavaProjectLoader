# JDT LS / Oracle environment modes

The comparison workflow retains `prebuilt-workspace` as its default.
`configured-source` is an opt-in MVP for reviewed entries marked
`configuredSource: true` in `lab/t1-project-environments.json`.

Configured-source uses explicit project, build, server and compiler-toolchain
JDKs from each case. It checks pinned descriptors, wrapper versions, required
files and actual installed tools, then opens the original prepared checkout.
It does not run automatic Maven/Gradle model discovery, native compilation, or
the identical-JDK annotation-processor proof. Existing checkout preparation and
provider isolation are retained. Failed preparation prevents IDE startup and
remains `NOT_EVALUATED`; provider and diagnostic failures are not suppressed.

For the ten-case pilot, dispatch `t1-jdtls-oracle.yml` with:

- `environment_mode`: `configured-source`
- `projects`: `guava,arthas,jjwt,javalin,mybatis-3,mockito,jadx,btrace,junit-framework,okhttp`
- `operating_system`: `windows-latest` or `macos-latest`
- `vscode_version`: `1.136.1`

Each dispatch schedules 10 environment jobs and 20 isolated provider jobs.
Records retain `comparisonMode: configured-source`; do not merge them with
historical out-of-box or prebuilt results. Provider Ready, Semantic Ready and
Workspace Diagnostics continue to use the existing collectors.
