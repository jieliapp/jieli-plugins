import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/jieli-sync.mjs", import.meta.url);
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/history-sync.mjs"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: fileURLToPath(output),
  define: {
    JIELI_HISTORY_BUNDLE: "true",
  },
});
console.log(`Built dist/jieli-sync.mjs (${statSync(output).size} bytes)`);
