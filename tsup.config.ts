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
  // Off deliberately. Sourcemaps were 60% of the published tarball, and the
  // original TypeScript they point at is on GitHub under the matching tag, so
  // they bought nothing an installer could not already read. Emitting them
  // without shipping them would be worse than either: the //# sourceMappingURL
  // comment would survive into dist and resolve to nothing.
  sourcemap: false,
  clean: true,
  target: "node20",
  platform: "node",
  splitting: false,
  treeshake: true,
});
