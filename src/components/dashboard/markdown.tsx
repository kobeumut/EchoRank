// Chat Markdown (CommonMark + GFM: tables, task lists, strikethrough, autolinks) rendered as React elements.
// Raw HTML is dropped and URLs pass react-markdown's safe default, so model output can never inject markup or
// `javascript:` links; images become plain links so an answer cannot make the browser load remote content.
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, cx } from "./ui";

type Tone = "default" | "inverse";

const TONE = {
  default: {
    text: "text-zinc-800 dark:text-zinc-200",
    strong: "text-zinc-900 dark:text-zinc-100",
    link: "text-indigo-600 dark:text-indigo-400",
    code: "bg-zinc-100 dark:bg-zinc-800",
    rule: "border-zinc-200 dark:border-zinc-700",
    head: "bg-zinc-50 dark:bg-zinc-800/60",
  },
  // White text on the indigo user bubble.
  inverse: {
    text: "text-white",
    strong: "text-white",
    link: "text-white underline",
    code: "bg-white/20",
    rule: "border-white/30",
    head: "bg-white/10",
  },
} as const;

const REMARK_PLUGINS = [remarkGfm];

function components(tone: Tone): Components {
  const t = TONE[tone];
  return {
    h1: ({ children }) => <p className={cx("text-base font-semibold", t.strong)}>{children}</p>,
    h2: ({ children }) => <p className={cx("text-base font-semibold", t.strong)}>{children}</p>,
    h3: ({ children }) => <p className={cx("font-semibold", t.strong)}>{children}</p>,
    h4: ({ children }) => <p className={cx("font-semibold", t.strong)}>{children}</p>,
    h5: ({ children }) => <p className={cx("font-semibold", t.strong)}>{children}</p>,
    h6: ({ children }) => <p className={cx("font-semibold", t.strong)}>{children}</p>,
    p: ({ children }) => <p className="whitespace-pre-line">{children}</p>,
    strong: ({ children }) => <strong className={cx("font-semibold", t.strong)}>{children}</strong>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cx("break-words underline-offset-2 hover:underline", t.link)}>
        {children}
      </a>
    ),
    img: ({ src, alt }) =>
      typeof src === "string" && src ? (
        <a href={src} target="_blank" rel="noopener noreferrer nofollow" className={cx("underline-offset-2 hover:underline", t.link)}>
          {alt || src}
        </a>
      ) : null,
    ul: ({ children, className }) => <ul className={cx("space-y-1 pl-5", className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc")}>{children}</ul>,
    ol: ({ children, start }) => <ol start={start} className="list-decimal space-y-1 pl-5">{children}</ol>,
    li: ({ children }) => <li className="[&>ol]:mt-1 [&>ul]:mt-1">{children}</li>,
    input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly disabled className="mr-1.5 align-middle accent-indigo-600" />,
    blockquote: ({ children }) => <blockquote className={cx("space-y-2 border-l-2 pl-3 opacity-90", t.rule)}>{children}</blockquote>,
    hr: () => <hr className={t.rule} />,
    table: ({ children }) => (
      <div className="max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className={t.head}>{children}</thead>,
    th: ({ children, style }) => <th style={style} className={cx("border px-2 py-1 font-semibold", t.rule)}>{children}</th>,
    td: ({ children, style }) => <td style={style} className={cx("border px-2 py-1 align-top", t.rule)}>{children}</td>,
    // Fenced blocks: the <code> child carries the language; render them with the dashboard's CodeBlock (copy button).
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
      const language = /language-([\w+-]+)/.exec(child.props.className ?? "")?.[1];
      const code = Children.toArray(child.props.children).join("").replace(/\n$/, "");
      return <CodeBlock code={code} language={language} maxHeight="24rem" />;
    },
    code: ({ children, className }) => <code className={cx("rounded px-1 py-0.5 font-mono text-[0.85em]", t.code, className)}>{children}</code>,
  };
}
const COMPONENTS: Record<Tone, Components> = { default: components("default"), inverse: components("inverse") };

export function Markdown({ text, tone = "default", className }: { text: string; tone?: Tone; className?: string }) {
  return (
    <div className={cx("min-w-0 space-y-3 break-words text-sm leading-relaxed", TONE[tone].text, className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS[tone]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
