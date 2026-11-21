import { useEffect, useMemo, useState, type ComponentProps, type MouseEvent, type ReactElement } from "react";
import readMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { isSecureWeb, isWeb } from "../../main/links.ts";
import { cn } from "../lib/cn.ts";
import { IconButton } from "../ui/Button.tsx";
import { useHighlighted } from "./highlight.ts";

// How long a code block's copy button shows that it copied.
const COPIED_MS = 1500;

/**
 * An agent's reply as rich text, as T3 Code draws one: GitHub's markdown,
 * with headings, lists, task lists, quotes, tables, highlighted code and
 * links. The text can be selected. A link to a web page opens in the system
 * browser, and a picture is drawn when its address is `https`. Any other
 * link shows as its words and any other picture as its description, so
 * nothing an agent writes has the window ask its own origin for anything.
 * Code blocks name their language and copy with a button, and they and
 * tables scroll sideways when they are wider than what holds them. `onColor`
 * draws it for a bubble in a chat's colour, where the text and its marks take
 * the one colour that reads on it.
 */
export function Markdown({ text, onColor = false }: { text: string; onColor?: boolean }) {
  const drawn = useMemo(() => parsed(text, onColor), [text, onColor]);
  return (
    <div data-selectable data-testid="markdown" className="min-w-0 text-message [&>*:last-child]:mb-0">
      {drawn}
    </div>
  );
}

// The replies drawn lately, so a chat opened again draws its messages without reading their markdown again.
const drawnLately = new Map<string, ReactElement>();
const DRAWN_KEPT = 500;

/** A reply's markdown as the elements it is drawn with. */
function parsed(text: string, onColor: boolean): ReactElement {
  const key = `${onColor ? 1 : 0}${text}`;
  // The markdown is read here, once, rather than each time a chat draws it.
  const drawn = drawnLately.get(key) ?? readMarkdown({ children: text, remarkPlugins: PLUGINS, components: onColor ? ON_COLOR : ON_BUBBLE });
  drawnLately.delete(key);
  if (drawnLately.size >= DRAWN_KEPT) drawnLately.delete(drawnLately.keys().next().value!);
  drawnLately.set(key, drawn);
  return drawn;
}

/** The elements markdown is drawn with, on the agent's bubble or the page, or on a chat's colour. */
function components(onColor: boolean): Components {
  const quiet = onColor ? "text-on-tint/80" : "text-ink2";
  return {
    p: ({ node: _node, ...props }) => <p className="mb-2.5" {...props} />,
    h1: ({ node: _node, ...props }) => <h1 className="mt-1 mb-1.5 text-xl font-bold" {...props} />,
    h2: ({ node: _node, ...props }) => <h2 className="mt-1 mb-1.5 text-lg font-bold" {...props} />,
    h3: ({ node: _node, ...props }) => <h3 className="mt-1 mb-1 font-bold" {...props} />,
    h4: ({ node: _node, ...props }) => <h4 className="mt-1 mb-1 font-bold" {...props} />,
    h5: ({ node: _node, ...props }) => <h5 className="mt-1 mb-1 font-bold" {...props} />,
    h6: ({ node: _node, ...props }) => <h6 className="mt-1 mb-1 font-bold" {...props} />,
    strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
    ul: ({ node: _node, className, ...props }) => (
      <ul className={cn("mb-2.5 list-disc pl-5", onColor ? "marker:text-on-tint/70" : "marker:text-ink2", className === "contains-task-list" && "list-none pl-0.5", "[&_ol]:mb-0 [&_ul]:mb-0")} {...props} />
    ),
    ol: ({ node: _node, ...props }) => <ol className={cn("mb-2.5 list-decimal pl-6 [&_ol]:mb-0 [&_ul]:mb-0", onColor ? "marker:text-on-tint/70" : "marker:text-ink2")} {...props} />,
    li: ({ node: _node, className, ...props }) => <li className={cn("mt-1 pl-0.5 first:mt-0 [&>p]:mb-1", className === "task-list-item" && "flex items-baseline gap-2")} {...props} />,
    input: ({ node: _node, ...props }) => (
      <input {...props} disabled className={cn("relative top-px size-3.5 shrink-0", onColor ? "accent-on-tint" : "accent-[var(--chat,var(--tint))]")} />
    ),
    blockquote: ({ node: _node, ...props }) => <blockquote className={cn("mb-2.5 border-l-[3px] pl-2.5 [&>*:last-child]:mb-0", quiet, onColor ? "border-on-tint/50" : "border-line-strong")} {...props} />,
    hr: () => <hr className={cn("my-3 border-t", onColor ? "border-on-tint/40" : "border-line")} />,
    a: ({ node: _node, href, children, ...props }) =>
      href && isWeb(href) ? (
        <a
          href={href}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            void window.desktop.openExternal(href);
          }}
          className={cn("cursor-pointer underline decoration-1 underline-offset-2", onColor ? "text-on-tint" : "text-tint-ink hover:decoration-2")}
          {...props}
        >
          {children}
        </a>
      ) : (
        <>{children}</>
      ),
    img: ({ node: _node, src, alt, ...props }) => (src && isSecureWeb(src) ? <img src={src} alt={alt ?? ""} className="inline-block max-w-full rounded-md" {...props} /> : <>{alt}</>),
    code: ({ node: _node, ...props }) => <code className="rounded-xs bg-canvas px-1 py-px font-mono text-[0.88em] text-ink" {...props} />,
    pre: ({ node }) => {
      const code = node?.children[0];
      const language = code && code.type === "element" ? languageOf(code.properties.className) : undefined;
      return <CodeBlock code={textOf(code).replace(/\n$/, "")} language={language} />;
    },
    table: ({ node: _node, ...props }) => (
      <div className="mb-2.5 overflow-x-auto rounded-lg border border-line bg-canvas text-ink">
        <table className="w-max min-w-full border-collapse text-sm" {...props} />
      </div>
    ),
    th: ({ node: _node, style, ...props }) => <th className="border-l border-line px-2.5 py-1.5 text-left font-semibold first:border-l-0" style={style} {...props} />,
    td: ({ node: _node, style, ...props }) => <td className="border-t border-l border-line px-2.5 py-1.5 align-top first:border-l-0" style={style} {...props} />,
    thead: ({ node: _node, ...props }) => <thead className="bg-field" {...props} />,
  };
}

const PLUGINS = [remarkGfm];
const ON_BUBBLE = components(false);
const ON_COLOR = components(true);

/** The language a code block names, from the class markdown gives its code, as `language-ts`. */
function languageOf(className: unknown): string | undefined {
  const names = Array.isArray(className) ? className : typeof className === "string" ? className.split(" ") : [];
  const named = names.find((name): name is string => typeof name === "string" && name.startsWith("language-"));
  return named?.slice("language-".length) || undefined;
}

type Node = { type: string; value?: string; children?: Node[] } | undefined;

/** The text inside a piece of the markdown's tree. */
function textOf(node: Node): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * A block of code, on the page's colour: its language and a button that
 * copies it above, and the code below, coloured once the highlighter has
 * loaded, scrolling sideways when it is wider than the block.
 */
function CodeBlock({ code, language }: { code: string; language: string | undefined }) {
  const lines = useHighlighted(code, language);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => void navigator.clipboard.writeText(code).then(() => setCopied(true));
  return (
    <div className="mb-2.5 min-w-0 overflow-hidden rounded-lg border border-line bg-canvas text-ink" data-testid="code-block">
      <div className="flex h-7 items-center gap-2 pr-0.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-ink2" data-testid="code-language">
          {language ?? ""}
        </span>
        <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy code"} size="sm" onClick={copy} data-testid="copy-code" />
      </div>
      <pre className="overflow-x-auto px-3 pb-2.5 font-mono text-sm [tab-size:2]">
        <code className="[&_span]:text-(--shiki-light) dark:[&_span]:text-(--shiki-dark)">{lines ? <Lines lines={lines} /> : code}</code>
      </pre>
    </div>
  );
}

function Lines({ lines }: { lines: NonNullable<ReturnType<typeof useHighlighted>> }) {
  return lines.map((line, at) => (
    <span key={at} className="block min-h-[1lh]">
      {line.map((token, index) => (
        <span key={index} style={token.style as ComponentProps<"span">["style"]}>
          {token.content}
        </span>
      ))}
    </span>
  ));
}
