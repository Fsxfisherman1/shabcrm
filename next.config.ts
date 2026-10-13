import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every CRM page is per-user and per-account, so we render on each request
  // instead of using Cache Components' static shells.
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
