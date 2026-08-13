import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Serverless bundling: the case bank is read from disk at runtime via fs,
  // which Vercel's file tracing can't infer — include it for every route.
  outputFileTracingIncludes: {
    "/**": ["./cases/**/*"],
  },
};

export default nextConfig;
