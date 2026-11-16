import { build } from "esbuild";
import { statSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const plugin of ['codex', 'claude-code']) {
  writeFileSync(
    new URL(`../plugins/${plugin}/scripts/git_blame.mjs`, import.meta.url),
    readFileSync(new URL('./git-blame.mjs', import.meta.url), 'utf8')
      .replace('./git-provenance.mjs', './git_provenance.mjs'),
  );
  writeFileSync(
    new URL(`../plugins/${plugin}/scripts/git_provenance.mjs`, import.meta.url),
    readFileSync(new URL('./git-provenance.mjs', import.meta.url), 'utf8')
      .replace('./shell-commands.mjs', './shell_commands.mjs'),
  );
  writeFileSync(
    new URL(`../plugins/${plugin}/scripts/shell_commands.mjs`, import.meta.url),
    readFileSync(new URL('./shell-commands.mjs', import.meta.url), 'utf8')
      .replace('from "unbash"', 'from "./vendor/unbash.mjs"'),
  );
  const vendor = new URL(`../plugins/${plugin}/scripts/vendor/`, import.meta.url);
  mkdirSync(vendor, { recursive: true });
  await build({
    stdin: { contents: 'export { parse, forEachChild } from "unbash";', resolveDir: root },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    outfile: fileURLToPath(new URL('unbash.mjs', vendor)),
  });
  copyFileSync(new URL('../node_modules/unbash/LICENSE', import.meta.url), new URL('unbash.LICENSE', vendor));
}
const output = new URL("../dist/jieli-sync.mjs", import.meta.url);
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/history-sync.mjs"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  outfile: fileURLToPath(output),
  banner: { js: `/*! unbash 6.0.4\n${readFileSync(new URL('../node_modules/unbash/LICENSE', import.meta.url), 'utf8')}*/` },
  // Both standalone plugins carry a parser; the combined history tool needs one.
  plugins: [{
    name: "shared-shell-parser",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/vendor\/unbash\.mjs$/ }, () => ({
        path: fileURLToPath(import.meta.resolve("unbash")),
      }));
    },
  }],
  define: {
    JIELI_HISTORY_BUNDLE: "true",
  },
});
console.log(`Built dist/jieli-sync.mjs (${statSync(output).size} bytes)`);
