import { build } from "esbuild";
import { statSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const plugin of ['codex', 'claude-code']) {
  writeFileSync(
    new URL(`../plugins/${plugin}/scripts/git_blame.mjs`, import.meta.url),
    readFileSync(new URL('./git-blame.mjs', import.meta.url), 'utf8')
      .replace('./git-provenance.mjs', './git_provenance.mjs'),
  );
  copyFileSync(new URL('./git-provenance.mjs', import.meta.url), new URL(`../plugins/${plugin}/scripts/git_provenance.mjs`, import.meta.url));
}
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
