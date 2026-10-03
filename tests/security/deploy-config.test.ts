import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("keeps the dev-only database publish in the override example", () => {
    expect(read("docker-compose.override.example.yml")).toMatch(/127\.0\.0\.1:5432:5432/);
  });
});

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
});

describe("CI workflow", () => {
  const ci = read(".github/workflows/ci.yml");

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
});
