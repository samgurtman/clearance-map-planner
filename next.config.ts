import type { NextConfig } from "next";

const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";
const configuredBasePath = process.env.PAGES_BASE_PATH?.trim() ?? "";
const pagesBasePath =
  configuredBasePath === "/" ? "" : configuredBasePath.replace(/\/$/, "");

if (pagesBasePath && !/^\/[A-Za-z0-9._-]+$/.test(pagesBasePath)) {
  throw new Error(`Invalid PAGES_BASE_PATH: ${configuredBasePath}`);
}

const nextConfig: NextConfig = {
  ...(isGitHubPagesBuild
    ? {
        output: "export" as const,
        // Vinext beta currently fails to prerender `/` when basePath is set.
        // This is a single-route client app, so an asset prefix is sufficient
        // while the FAA data itself uses document-relative URLs.
        assetPrefix: pagesBasePath,
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
