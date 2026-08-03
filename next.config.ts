import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to this project — the user's home directory
  // happens to contain an unrelated package.json/lockfile from other work,
  // which Next.js would otherwise mistake for the monorepo root.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
