// Renders a profile rich-text document (server JSON, see
// backend/apps/profiles/richtext.py) with React elements only. No HTML string
// is ever injected; links are re-checked here (https only) as defence in
// depth and always open with rel="nofollow ugc noopener noreferrer".
// OWNER: WS-PROFILES.
import { cn } from "../../kit/lib/cn";

export const LINK_REL = "nofollow ugc noopener noreferrer";

/** True for an absolute https:// URL without credentials (the server already enforced more). */
export function isSafeHref(href) {
  if (typeof href !== "string" || href.length > 2048) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function Inline({ nodes }) {
  if (!Array.isArray(nodes)) return null;
  return nodes.map((node, index) => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "break") return <br key={index} />;
    if (node.type === "link") {
      const text = String(node.text || "");
      if (!isSafeHref(node.href)) return <span key={index}>{text}</span>;
      return (
        <a
          key={index}
          href={node.href}
          rel={LINK_REL}
          target="_blank"
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors duration-150 hover:decoration-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          {text}
        </a>
      );
    }
    if (node.type !== "text") return null;
    const marks = Array.isArray(node.marks) ? node.marks : [];
    let element = String(node.text || "");
    if (marks.includes("code")) {
      element = <code className="rounded bg-accent/[.14] px-1.5 py-0.5 font-mono text-[0.9em] text-accent">{element}</code>;
    }
    if (marks.includes("italic")) element = <em>{element}</em>;
    if (marks.includes("bold")) element = <strong className="font-semibold text-white">{element}</strong>;
    return <span key={index}>{element}</span>;
  });
}

/** <RichText doc={...} /> renders paragraphs, h3 headings, quotes and lists. */
export default function RichText({ doc, className }) {
  const blocks = doc && doc.type === "doc" && Array.isArray(doc.content) ? doc.content : [];
  if (!blocks.length) return null;
  return (
    <div className={cn("space-y-4 text-base leading-7 text-[#d4d4d4]", className)}>
      {blocks.map((block, index) => {
        if (!block || typeof block !== "object") return null;
        switch (block.type) {
          case "heading":
            return (
              <h3 key={index} className="pt-2 text-xl font-semibold text-white">
                <Inline nodes={block.content} />
              </h3>
            );
          case "quote":
            return (
              <blockquote key={index} className="border-l-2 border-accent pl-4 text-muted-foreground">
                <Inline nodes={block.content} />
              </blockquote>
            );
          case "list":
            return (
              <ul key={index} className="list-none space-y-2">
                {(Array.isArray(block.items) ? block.items : []).map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-3">
                    <span aria-hidden="true" className="mt-[0.7em] size-1 shrink-0 rounded-full bg-white/50" />
                    <span>
                      <Inline nodes={item} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          case "paragraph":
            return (
              <p key={index}>
                <Inline nodes={block.content} />
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
