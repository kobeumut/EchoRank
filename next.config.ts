import type { NextConfig } from "next";

// Baseline hardening headers for every response. A strict Content-Security-Policy needs per-request nonces
// with the inline theme script; `frame-ancestors` already covers clickjacking without them.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Preserve native __dirname resolution for pdfmake’s bundled Unicode fonts; load undici (the DNS-pinned
  // outbound dispatcher in src/lib/distribution/net.ts) from node_modules instead of bundling it.
  serverExternalPackages: ["pdfmake", "undici"],
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
