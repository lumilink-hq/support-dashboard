// Builds the Wave Rewards block scripts: src/*.js -> extensions/wave-rewards/assets/*.js,
// minified. App block JS must stay under 10 KB (Shopify theme check), so before
// minifying, the indentation BETWEEN HTML tags inside the H`…` templates is
// collapsed (">\n   <" -> "><", ">\n   ${" -> ">${", "}\n   <" -> "}<").
// Those sequences don't occur in plain JS here, and whitespace between tags
// doesn't render, so the page is unchanged.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";

const collapse = {
  name: "collapse-template-whitespace",
  setup(b) {
    // esbuild's filter runs in Go's regex engine; match broadly, check the folder in JS.
    b.onLoad({ filter: /\.js$/ }, async (args) => {
      if (!/[\\/]src[\\/][^\\/]+\.js$/.test(args.path)) return undefined;
      const src = await readFile(args.path, "utf8");
      return { contents: src.replace(/([>}])\s*\n\s*(<|\$\{)/g, "$1$2"), loader: "js" };
    });
  },
};

const out = "extensions/wave-rewards/assets";
await build({
  entryPoints: ["src/wave-rewards.js", "src/wave-rewards-member.js", "src/wave-rewards-ref.js", "src/wave-rewards-ach.js"],
  outdir: out,
  minify: true,
  target: "es2019",
  plugins: [collapse],
  logLevel: "warning",
});
for (const f of ["wave-rewards.js", "wave-rewards-member.js", "wave-rewards-ref.js", "wave-rewards-ach.js"]) {
  const size = statSync(`${out}/${f}`).size;
  console.log(`${f.padEnd(22)} ${size} bytes${f === "wave-rewards.js" && size >= 10000 ? "  OVER the 10 KB block limit" : ""}`);
}
