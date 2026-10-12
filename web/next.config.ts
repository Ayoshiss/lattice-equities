import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The app lives inside the program repo, which has its own lockfile.
  turbopack: {
    root: path.join(__dirname),
    // @arcium-hq/client imports Node's crypto and fs at the top level; the
    // browser build gets small stand-ins (see lib/shims).
    resolveAlias: {
      crypto: { browser: "./lib/shims/crypto.ts" },
      fs: { browser: "./lib/shims/fs.ts" },
      // ...and imports Anchor as a default export, which Anchor's ESM builds lack.
      "@anchor-lang/core": { browser: "./lib/shims/anchor-browser.ts", default: "./lib/shims/anchor-esm.ts" },
    },
  },
};

export default nextConfig;
