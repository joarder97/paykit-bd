import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/bkash/index.ts",
    "src/bkash/adapters/next.ts",
    "src/bkash/adapters/express.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
  splitting: false,
  treeshake: true,
});
