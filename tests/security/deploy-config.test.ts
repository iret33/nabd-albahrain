import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Cheap regression guards for the deployment files. Docker is not available in
 * CI-less environments, so these assert on the text of the files that the
 * audit's container findings were about; they do not replace `docker build`
 * (the CI `docker` job does that).
 */

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
/** File content without full-line comments, so explanatory comments cannot satisfy or trip an assertion. */
const code = (file: string) =>
  read(file)
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

describe("Dockerfile", () => {
  const dockerfile = code("Dockerfile");

  it("pins pnpm via packageManager instead of floating on latest", () => {
    expect(dockerfile).not.toMatch(/pnpm@latest/);
    expect(dockerfile).toMatch(/corepack prepare --activate/);
    expect(JSON.parse(read("package.json")).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("creates public/ before the runner copies it", () => {
    expect(dockerfile).toMatch(/RUN mkdir -p public/);
    expect(dockerfile.indexOf("mkdir -p public")).toBeLessThan(dockerfile.indexOf("COPY --from=builder /app/public"));
  });

  it("builds the CLI bundle and ships dist/ to the runner", () => {
    expect(dockerfile).toMatch(/RUN pnpm build:cli/);
    expect(dockerfile).toMatch(/COPY --from=builder \/app\/dist \.\/dist/);
  });

  it("does not hand the whole application tree to the runtime user", () => {
    expect(dockerfile).not.toMatch(/chown\s+-R\s+nextjs:nodejs\s+\/app\b/);
    expect(dockerfile).toMatch(/chown -R nextjs:nodejs \.next\/cache/);
    expect(dockerfile).toMatch(/^USER nextjs$/m);
  });

  it("has a healthcheck and takes the public site URL as a build arg", () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(dockerfile).toMatch(/\/api\/health/);
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_SITE_URL/m);
  });

  // R6-08: /api/health/ready reported `version: null` in every container because nothing set GIT_SHA.
  it("bakes GIT_SHA into the runner stage only, after the heavy layers", () => {
    expect(dockerfile).toMatch(/^ARG GIT_SHA=?$/m);
    expect(dockerfile).toMatch(/^ENV GIT_SHA=\$GIT_SHA$/m);
    const runner = dockerfile.indexOf("FROM base AS runner");
    expect(runner).toBeGreaterThan(0);
    const arg = dockerfile.indexOf("ARG GIT_SHA");
    // Not in deps/builder: a per-commit value there would bust the pnpm install / build cache.
    expect(arg).toBeGreaterThan(runner);
    // After the node_modules overlay and the chown layer, so only metadata layers follow it.
    expect(arg).toBeGreaterThan(dockerfile.indexOf("COPY --from=builder /app/node_modules"));
    expect(arg).toBeGreaterThan(dockerfile.indexOf("chown -R nextjs:nodejs .next/cache"));
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.revision="\$GIT_SHA"/);
  });
});

describe("docker-compose.yml", () => {
  const compose = code("docker-compose.yml");

  it("hardens the app container", () => {
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/);
  });

  it("publishes only the app, on loopback; the database publishes nothing", () => {
    const ports = [...compose.matchAll(/^\s*-\s*"([^"]*:\d+:\d+)"/gm)].map((m) => m[1]);
    expect(ports).toEqual(["127.0.0.1:3000:3000"]);
    const dbSection = compose.slice(compose.indexOf("\n  db:"));
    expect(dbSection).not.toMatch(/\bports:/);
  });

  it("takes the database password from one overridable knob and passes the build arg", () => {
    expect(compose).toMatch(/POSTGRES_PASSWORD:-nabd/);
    expect(compose).toMatch(/NEXT_PUBLIC_SITE_URL: \$\{NEXT_PUBLIC_SITE_URL:-/);
  });

  // R6-08 (compose side): the deploy path is `docker compose up -d --build`, so the SHA must come in as a build arg.
  it("passes GIT_SHA as a build arg (empty default) and never as a runtime variable", () => {
    expect(compose).toMatch(/GIT_SHA: \$\{GIT_SHA:-\}/);
    // A bare/explicit runtime GIT_SHA (or one from env_file) could override the baked value with an empty one.
    const environment = compose.slice(compose.indexOf("environment:"), compose.indexOf("ports:"));
    expect(environment).not.toMatch(/GIT_SHA/);
  });

  // r1-09 (compose side): Prisma's default pool is 2*vCPU+1 = 3 on a 1-vCPU VPS; a heavy sync pins one
  // connection per dataset being written, so /api/freshness and the pages starve (P2024 -> HTTP 500).
  it("sets an explicit Prisma pool size of at least SYNC_CONCURRENCY + 6, from one overridable knob", () => {
    const url = compose.match(/- DATABASE_URL=(\S+)/)?.[1] ?? "";
    expect(url).toMatch(
      /^postgresql:\/\/nabd:\$\{POSTGRES_PASSWORD:-nabd\}@db:5432\/nabd\?connection_limit=\$\{DB_POOL_SIZE:-(\d+)\}$/,
    );
    const poolDefault = Number(url.match(/DB_POOL_SIZE:-(\d+)/)![1]);
    const SYNC_CONCURRENCY_DEFAULT = 3; // src/lib/sync/config.ts
    expect(poolDefault).toBeGreaterThanOrEqual(SYNC_CONCURRENCY_DEFAULT + 6);
    // pool_timeout is deliberately left alone: a longer wait only delays the P2024.
    expect(url).not.toMatch(/pool_timeout/);
  });

  it("offers memory guidance as opt-in knobs (no hard cap that could OOM-kill a sync), namespaced from the host shell", () => {
    expect(compose).toMatch(/mem_limit: \$\{APP_MEM_LIMIT:-0\}/);
    // A bare NODE_OPTIONS would inherit the HOST shell's value into the container.
    expect(compose).toMatch(/- NODE_OPTIONS=\$\{APP_NODE_OPTIONS:-\}/);
    expect(compose).not.toMatch(/^\s*- NODE_OPTIONS\s*$/m);
    // The app service only: nothing under `db:` sets a limit.
    const dbSection = compose.slice(compose.indexOf("\n  db:"));
    expect(dbSection).not.toMatch(/mem_limit|memory/);
  });

  it("documents the new knobs and the HTTPS requirement for operators", () => {
    const example = read(".env.example");
    for (const name of ["DB_POOL_SIZE", "APP_NODE_OPTIONS", "APP_MEM_LIMIT", "GIT_SHA"]) {
      expect(example, name).toContain(name);
    }
    expect(example).toMatch(/\/admin needs HTTPS/);
  });

  it("keeps the dev-only database publish in the override example", () => {
    expect(read("docker-compose.override.example.yml")).toMatch(/127\.0\.0\.1:5432:5432/);
  });
});

/**
 * Docker's `.dockerignore` semantics (moby/patternmatcher, the matcher Docker and BuildKit use), which
 * differ from .gitignore: a pattern WITHOUT a leading `**` is matched against the root-relative path
 * only, so `.env*` does not match `prisma/.env`. Ported rather than imported (no new dependency); the
 * port was cross-checked against the real Go matcher on the cases pinned below.
 */
function parseIgnoreFile(content: string): Array<{ exclusion: boolean; regex: RegExp }> {
  const rules: Array<{ exclusion: boolean; regex: RegExp }> = [];
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const exclusion = line.startsWith("!");
    if (exclusion) line = line.slice(1).trim();
    line = path.posix.normalize(line).replace(/^\/+/, "");
    if (!line || line === ".") continue;
    let re = "^";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "*") {
        if (line[i + 1] === "*") {
          i++;
          if (line[i + 1] === "/") i++; // `**/` is treated as `**`
          re += i + 1 >= line.length ? ".*" : "(.*/)?";
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else if (".+()|{}$".includes(ch)) {
        re += `\\${ch}`;
      } else {
        re += ch;
      }
    }
    rules.push({ exclusion, regex: new RegExp(`${re}$`) });
  }
  return rules;
}

/** True when the Docker build context would NOT contain `file` (the file or any parent directory matches; the last matching rule wins). */
function dockerIgnored(content: string, file: string): boolean {
  const parents = file.split("/").slice(0, -1);
  let ignored = false;
  for (const rule of parseIgnoreFile(content)) {
    if (rule.exclusion !== ignored) continue; // an exclusion only matters once ignored; a re-include only before
    let match = rule.regex.test(file);
    for (let i = 0; !match && i < parents.length; i++) match = rule.regex.test(parents.slice(0, i + 1).join("/"));
    if (match) ignored = !rule.exclusion;
  }
  return ignored;
}

describe("ignore files", () => {
  it.each([".gitignore", ".dockerignore"])("%s ignores every .env* except the template", (file) => {
    const lines = read(file).split("\n").map((l) => l.trim());
    expect(lines).toContain(".env*");
    expect(lines).toContain("!.env.example");
  });

  it("git ignores build output and the local compose override", () => {
    const lines = read(".gitignore").split("\n").map((l) => l.trim());
    expect(lines).toContain("/dist");
    expect(lines).toContain("docker-compose.override.yml");
  });

  it("the Docker context still contains what the image build needs", () => {
    const lines = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const needed of ["public", "prisma", "scripts", "docker", "src", "package.json", "pnpm-lock.yaml"]) {
      expect(lines, `${needed} must not be dockerignored`).not.toContain(needed);
    }
  });

  // dockerignore-nested-env-files: `COPY . .` and `COPY --from=builder /app/prisma|public` carried a
  // developer's git-ignored prisma/.env (Prisma reads it) into the image layers.
  describe(".dockerignore, evaluated with Docker semantics", () => {
    const dockerignore = read(".dockerignore");

    it("the matcher port itself behaves like Docker's (root-only patterns miss nested files)", () => {
      const rootOnly = ".env*\n!.env.example\nnode_modules\n";
      expect(dockerIgnored(rootOnly, ".env.local")).toBe(true);
      expect(dockerIgnored(rootOnly, "prisma/.env")).toBe(false);
      expect(dockerIgnored(rootOnly, "src/node_modules/x/index.js")).toBe(false);
      expect(dockerIgnored(rootOnly, "node_modules/x/index.js")).toBe(true);
      expect(dockerIgnored(rootOnly, ".env.example")).toBe(false);
      // order matters: the last matching rule wins
      expect(dockerIgnored("!.env.example\n.env*\n", ".env.example")).toBe(true);
    });

    it.each([
      ".env",
      ".env.local",
      ".env.production",
      "prisma/.env",
      "prisma/.env.local",
      "prisma/.env.example", // only the ROOT template is kept
      "public/.env",
      "public/.env.local",
      "src/.env",
      "src/lib/.env.production",
      "deep/er/nested/.env",
      "prisma/server.pem",
      "prisma/nested/ca.key",
      "public/id_rsa.key",
      ".npmrc",
      "src/.npmrc",
      "node_modules/x/index.js",
      "src/node_modules/x/index.js",
      "prisma/node_modules/.bin/prisma",
      ".git/config",
      "sub/.git/config",
      ".claude/settings.json",
      "tests/security/deploy-config.test.ts",
      "README.md",
      "docker-compose.yml",
    ])("keeps %s OUT of the build context", (file) => {
      expect(dockerIgnored(dockerignore, file)).toBe(true);
    });

    it.each([
      ".env.example",
      "prisma/schema.prisma",
      "prisma/migrations/20260101000000_init/migration.sql",
      "src/app/page.tsx",
      "src/middleware.ts",
      "docker/entrypoint.sh",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "next.config.ts",
      "tsconfig.json",
      "postcss.config.mjs",
      "eslint.config.mjs",
      "scripts/build-cli.mjs",
      "public/icon.svg",
      "Dockerfile",
    ])("keeps %s IN the build context", (file) => {
      expect(dockerIgnored(dockerignore, file)).toBe(false);
    });

    it("lists `!.env.example` after the `**/.env*` line (the last match wins)", () => {
      const lines = dockerignore.split("\n").map((l) => l.trim());
      expect(lines).toContain("**/.env*");
      expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf("**/.env*"));
    });
  });

  // R6-10: local tooling state must not be committable; no duplicate entries.
  it("git ignores .claude, dist and coverage, and lists no pattern twice", () => {
    const gitignore = read(".gitignore");
    const lines = gitignore
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines).toContain("/.claude/");
    expect(lines).toContain("/dist");
    expect(lines).toContain("/coverage");
    const dupes = lines.filter((l, i) => lines.indexOf(l) !== i);
    expect(dupes).toEqual([]);
  });
});

describe("line endings (entrypoint-crlf-no-gitattributes)", () => {
  // Without these a Windows checkout with core.autocrlf=true produces `#!/bin/sh\r`, and the container
  // dies with "exec ./entrypoint.sh: no such file or directory".
  const attributes = read(".gitattributes")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("forces LF for shell scripts, the Dockerfile, compose/CI yaml, SQL migrations and the schema", () => {
    for (const rule of [
      "*.sh text eol=lf",
      "docker/entrypoint.sh text eol=lf",
      "Dockerfile text eol=lf",
      "*.yml text eol=lf",
      "*.sql text eol=lf",
      "*.prisma text eol=lf",
    ]) {
      expect(attributes, rule).toContain(rule);
    }
  });

  it("never uses a blanket eol=lf (binaries must not be converted) and marks the images binary", () => {
    expect(attributes).not.toContain("* text=auto eol=lf");
    expect(attributes).toContain("* text=auto");
    for (const ext of ["png", "jpg", "ico", "woff2"]) expect(attributes).toContain(`*.${ext} binary`);
  });

  it("the tracked entrypoint has no CR and (outside Windows) is executable", () => {
    const entrypoint = read("docker/entrypoint.sh");
    expect(entrypoint.startsWith("#!/bin/sh\n")).toBe(true);
    expect(entrypoint).not.toContain("\r");
    if (process.platform !== "win32") expect(statSync(path.join(root, "docker/entrypoint.sh")).mode & 0o111).not.toBe(0);
  });

  it("every other tracked script, Dockerfile and yaml is LF too", () => {
    for (const file of ["Dockerfile", "docker-compose.yml", ".github/workflows/ci.yml", ".github/dependabot.yml", ".dockerignore"]) {
      expect(read(file), file).not.toContain("\r");
    }
  });
});

describe("repo hygiene (R6-10)", () => {
  it("does not configure a coverage provider that is not installed", () => {
    const pkg = JSON.parse(read("package.json"));
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    const config = read("vitest.config.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    if (/coverage\s*:/.test(config)) expect(installed["@vitest/coverage-v8"]).toBeDefined();
    else expect(config).not.toMatch(/provider\s*:\s*["']v8["']/);
    expect(existsSync(path.join(root, "vitest.config.ts"))).toBe(true);
  });
});

describe("CI workflow", () => {
  const ci = read(".github/workflows/ci.yml");
  /** The workflow without full-line comments. */
  const ciCode = ci
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  it("runs the required steps with least privilege", () => {
    expect(ci).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(ci).toMatch(/cancel-in-progress: true/);
    for (const step of [
      "pnpm install --frozen-lockfile",
      "prisma generate",
      "prisma migrate deploy",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
      "pnpm audit --prod --audit-level=critical",
      "push: false",
    ]) {
      expect(ci, step).toContain(step);
    }
    expect(ci).toMatch(/RUN_INTEGRATION: "1"/);
    expect(ci).toMatch(/postgres:16/);
  });

  // ci-integration-guard-fails-ci / R6-01: the integration harness refuses a database named exactly
  // "nabd" (the production default) unless INTEGRATION_ALLOW_WIPE=1, so a CI database called "nabd"
  // failed every integration file and skipped Build and Audit. The invariant, not a literal:
  it("never points the integration tests at a database named exactly `nabd` without the explicit wipe flag", () => {
    const dbName = ciCode.match(/DATABASE_URL:\s*\S+\/([A-Za-z0-9_]+)\s*$/m)?.[1];
    expect(dbName, "job-level DATABASE_URL").toBeTruthy();
    const testStep = ciCode.slice(ciCode.indexOf("- name: Test"), ciCode.indexOf("- name: Build"));
    expect(testStep).toContain("RUN_INTEGRATION");
    if (dbName === "nabd") expect(testStep).toMatch(/INTEGRATION_ALLOW_WIPE: "1"/);
    // The flag must never be job-level (it would also reach Build/Audit and invite copy-paste elsewhere).
    expect(ciCode.slice(0, ciCode.indexOf("steps:"))).not.toContain("INTEGRATION_ALLOW_WIPE");
  });

  it("uses the same database name in POSTGRES_DB, the pg_isready health check and DATABASE_URL", () => {
    const dbName = ciCode.match(/DATABASE_URL:\s*\S+\/([A-Za-z0-9_]+)\s*$/m)![1];
    expect(ciCode.match(/POSTGRES_DB:\s*(\S+)/)?.[1]).toBe(dbName);
    expect(ciCode.match(/pg_isready -U nabd -d (\S+?)"/)?.[1]).toBe(dbName);
    // The superuser role is needed for `CREATE EXTENSION pg_trgm` in migration 2.
    expect(ciCode).toMatch(/POSTGRES_USER: nabd\b/);
    // The harness's own guard is still armed.
    expect(read("tests/integration/helpers.ts")).toMatch(/Refusing to wipe the database/);
  });

  // ci-supply-chain-hygiene
  it("does not commit look-alike production secrets", () => {
    expect(ciCode).not.toMatch(/ADMIN_TOKEN|SYNC_TOKEN/);
    expect(ciCode).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it("checks out without persisting the token and never needs more than read access", () => {
    // Everything from each checkout up to the next step (`- uses`/`- name`/`- run`/`jobs`) is its own block.
    const checkouts = ciCode.split("uses: actions/checkout@").slice(1);
    expect(checkouts.length).toBe(2); // the check job and the docker job
    for (const c of checkouts) {
      const block = c.split(/\n\s*- (?:uses|name|run)\b|\n\S/)[0];
      expect(block).toMatch(/persist-credentials: false/);
    }
    expect(ciCode).not.toMatch(/pull_request_target/);
    expect(ciCode).not.toMatch(/secrets\./);
    expect(ciCode).not.toMatch(/permissions:[\s\S]*?(write|admin)/);
  });

  it("references actions by a version tag or a full commit SHA, never a branch", () => {
    const uses = [...ciCode.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/);
  });

  it("keeps the audit gate honest: critical blocks, high is reported without blocking", () => {
    expect(ciCode).toContain("pnpm audit --prod --audit-level=critical");
    const high = ciCode.slice(ciCode.indexOf("Report high-severity advisories"));
    expect(high).toContain("pnpm audit --prod --audit-level=high");
    expect(high).toMatch(/::warning/);
    expect(high).toMatch(/if ! pnpm audit/); // a failing audit must not fail the step
  });

  // R6-08 (CI side)
  it("passes the commit SHA to the image build", () => {
    expect(ciCode).toMatch(/build-args:\s*\|\s*\n\s*GIT_SHA=\$\{\{ github\.sha \}\}/);
  });

  it("is triggered by push, pull_request and a weekly schedule (so new advisories surface)", () => {
    expect(ciCode).toMatch(/^on:\n\s+push:/m);
    expect(ciCode).toMatch(/^\s+pull_request:/m);
    expect(ciCode).toMatch(/schedule:\s*\n\s*- cron: "[^"]+"/);
  });
});

describe("dependabot", () => {
  const dependabot = read(".github/dependabot.yml");

  it("keeps github-actions, npm and docker up to date", () => {
    for (const eco of ["github-actions", "npm", "docker"]) {
      expect(dependabot, eco).toMatch(new RegExp(`package-ecosystem: ${eco}\\n\\s+directory: /\\n`));
    }
    expect(dependabot).toMatch(/^version: 2$/m);
  });

  it("does not auto-bump the deliberate major pins (Next, React, Prisma, Node)", () => {
    for (const name of ["next", "react", "react-dom", "prisma", "@prisma/client", "node"]) {
      expect(dependabot, name).toMatch(new RegExp(`dependency-name: "?${name.replace("/", "\\/")}"?\\n\\s+update-types: \\["version-update:semver-major"\\]`));
    }
  });
});
