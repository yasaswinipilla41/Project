import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** Flat config — eslint-config-next 16 ships flat arrays directly. */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "prisma/migrations/**",
      // Inert archive of the removed marketing site. It is kept verbatim for
      // restoration, so it must never be linted or edited to satisfy a rule.
      "landing page/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
