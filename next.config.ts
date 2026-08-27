import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: [
    "@prisma/client",
    "bullmq",
    "ioredis",
    "nodemailer",
    "exceljs",
  ],
};

export default nextConfig;
