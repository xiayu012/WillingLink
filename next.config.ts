import type { NextConfig } from "next";
import withSerwist from "@serwist/next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {},
  // 大脑准则以 .md 形式存放并在运行时 fs 读取，需显式打进产物，
  // 否则 Vercel 上会因为文件缺失而报「读不到 doctrine 文件」。
  outputFileTracingIncludes: {
    "/**": ["./lib/ai/brains/**/doctrine/*.md"],
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        protocol: "https",
        //https://nextjs.org/docs/messages/next-image-unconfigured-host
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
};

export default withSerwist({
  swSrc: "sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
})(nextConfig);
