import type { Plugin } from "vite";

/** Vite plugin for the repository's comment-bearing JSON configuration files. */
export function jsoncPlugin(): Plugin {
  return {
    name: "vite-plugin-jsonc",
    transform(code: string, id: string) {
      if (!id.endsWith(".jsonc")) return;

      const stripped = code.replace(
        /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
        (match, comment) => (comment ? "" : match),
      );
      return {
        code: `export default ${stripped.trim()};`,
        map: null,
      };
    },
  };
}
