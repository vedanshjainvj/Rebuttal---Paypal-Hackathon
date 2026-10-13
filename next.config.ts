import type { NextConfig } from "next";

// ---------- NEXT CONFIG ----------
// Cache Components is off. It forces every params read behind a Suspense
// boundary, which buys nothing here: the docket is a small client-filtered
// list and the case route is prerendered from generateStaticParams.

const nextConfig: NextConfig = {
  cacheComponents: false,
};

export default nextConfig;
