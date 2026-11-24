// Colours for the code in an agent's reply. The highlighter and each
// language's grammar load the first time a code block needs them, so the
// window opens without them. It runs on JavaScript's own regular expressions,
// which the window's policy allows, where the usual engine needs WebAssembly.

import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";

/** One run of code in one colour. `style` holds the colour for light and for dark as `--shiki-light` and `--shiki-dark`. */
export type Token = { content: string; style?: Record<string, string> };

const THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighter: Promise<HighlighterCore> | null = null;
// Each language's grammar as it loads, by the name the code block gave it, and whether there was one.
const grammars = new Map<string, Promise<boolean>>();
// What the blocks coloured lately have come to, so a block drawn again shows its colours at once.
const done = new Map<string, Token[][] | null>();
const DONE_KEPT = 500;

function load(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes"),
    ]);
    return createHighlighterCore({ themes: [bundledThemes[THEMES.light](), bundledThemes[THEMES.dark]()], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

/** Loads a language's grammar, once. False when there is none by that name. */
function grammar(core: HighlighterCore, language: string): Promise<boolean> {
  let loading = grammars.get(language);
  if (!loading) {
    loading = import("shiki/langs").then(async ({ bundledLanguages }) => {
      const found = bundledLanguages[language as keyof typeof bundledLanguages];
      if (!found) return false;
      await core.loadLanguage(found);
      return true;
    });
    grammars.set(language, loading);
  }
  return loading;
}

async function highlight(code: string, language: string): Promise<Token[][] | null> {
  const core = await load();
  if (!(await grammar(core, language))) return null;
  return core.codeToTokens(code, { lang: language, themes: THEMES, defaultColor: false }).tokens.map((line) => line.map(({ content, htmlStyle }) => ({ content, style: htmlStyle as Record<string, string> | undefined })));
}

/**
 * The code's lines as coloured runs, once the highlighter has them, and null
 * until then, or for good when the language is none it knows or no language
 * was given.
 */
export function useHighlighted(code: string, language: string | undefined): Token[][] | null {
  const key = `${language}\n${code}`;
  const [tokens, setTokens] = useState(() => done.get(key) ?? null);
  useEffect(() => {
    if (!language) return;
    if (done.has(key)) return setTokens(done.get(key)!);
    setTokens(null);
    let showing = true;
    highlight(code, language.toLowerCase())
      .catch(() => null)
      .then((found) => {
        if (done.size >= DONE_KEPT) done.delete(done.keys().next().value!);
        done.set(key, found);
        if (showing) setTokens(found);
      });
    return () => {
      showing = false;
    };
  }, [key, code, language]);
  return language ? tokens : null;
}
