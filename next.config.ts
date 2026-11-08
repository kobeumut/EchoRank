import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Preserve native __dirname resolution for pdfmake’s bundled Unicode fonts.
  serverExternalPackages: ["pdfmake"],
  outputFileTracingIncludes: {
    "/api/sites/*/reports/runs/*": ["./node_modules/pdfmake/fonts/Roboto/*.ttf"],
  },
  cacheComponents: true,
  partialPrefetching: true,
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
