// Bundle the sync CLI into one self-contained file the production image can
// run without the TypeScript sources or tsx:
//
//   pnpm build:cli                      ->  dist/sync-cli.cjs
//   node dist/sync-cli.cjs --help
//   node dist/sync-cli.cjs --dataset <id> --force
//
// The "@/..." import alias is resolved from tsconfig.json by esbuild. Prisma
// stays EXTERNAL: its native query engine lives in node_modules/.prisma and
// cannot be inlined, so the runtime image must keep node_modules (the
// Dockerfile already overlays the full node_modules).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [path.join(root, "src/lib/sync/cli.ts")],
  outfile: path.join(root, "dist/sync-cli.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  tsconfig: path.join(root, "tsconfig.json"),
  external: ["@prisma/client", "prisma", ".prisma/client"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs);
for (const [file, info] of outputs) {
  console.log(`built ${path.relative(root, file)} (${(info.bytes / 1024).toFixed(1)} KiB)`);
}
