import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    config.resolve.fallback = { fs: false, net: false, tls: false, crypto: false, stream: false, os: false };
    config.ignoreWarnings = [/Failed to parse source map/];
    return config;
  },
  turbopack: {}
};

export default nextConfig;
