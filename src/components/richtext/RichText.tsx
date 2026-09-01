import Link from "next/link";
import {
  parseRichText,
  type BlockNode,
  type InlineNode,
  type MentionCandidate,
} from "@/lib/richtext";

/**
 * Renders Prio's rich text.
 *
 * Every branch below produces a React element with the author's text as a
 * *child*, never as markup. There is no `dangerouslySetInnerHTML` in this file
 * and there must never be one: that is the whole reason a comment containing
 * `<script>` is inert rather than merely filtered.
 *
 * The only attribute that ever carries user input is a link's `href`, and the
 * parser has already run it through `safeUrl` — an `href` that reaches here has
 * an http, https or mailto scheme, or the parser turned it into plain text.
 */

export function RichText({
  value,
  mentionable = [],
  className,
}: {
  value: string;
  /** People who may be mentioned here, so `@name` resolves to a real person. */
  mentionable?: MentionCandidate[];
  className?: string;
}) {
  const blocks = parseRichText(value, mentionable);

  if (blocks.length === 0) return null;

  return (
    <div className={`prio-rt${className ? ` ${className}` : ""}`}>
      {blocks.map((block, index) => (
        <Block key={index} node={block} />
      ))}
    </div>
  );
}

function Block({ node }: { node: BlockNode }): React.ReactElement | null {
  switch (node.kind) {
    case "paragraph":
      return (
        <p className="prio-rt__p">
          <Inlines nodes={node.children} />
        </p>
      );

    case "heading": {
      // Comment headings start at h4: the page already owns h1–h3, and a
      // comment must not be able to reshape the document outline.
      const Tag = (["h4", "h5", "h6"] as const)[node.level - 1] ?? "h6";
      return (
        <Tag className="prio-rt__h" data-level={node.level}>
          <Inlines nodes={node.children} />
        </Tag>
      );
    }

    case "quote":
      return (
        <blockquote className="prio-rt__quote">
          {node.children.map((child, index) => (
            <Block key={index} node={child} />
          ))}
        </blockquote>
      );

    case "list":
      return node.ordered ? (
        <ol className="prio-rt__list">
          {node.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="prio-rt__list">
          {node.items.map((item, index) => (
            <li key={index}>
              <Inlines nodes={item} />
            </li>
          ))}
        </ul>
      );

    case "code":
      return (
        <pre className="prio-rt__pre" data-language={node.language ?? undefined}>
          <code>{node.value}</code>
        </pre>
      );

    case "rule":
      return <hr className="prio-rt__rule" />;
  }
}

function Inlines({ nodes }: { nodes: InlineNode[] }): React.ReactElement {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineOne key={index} node={node} />
      ))}
    </>
  );
}

function InlineOne({ node }: { node: InlineNode }): React.ReactElement {
  switch (node.kind) {
    case "text":
      // A plain string child. React escapes it; this is the safe default the
      // whole design rests on.
      return <>{node.value}</>;

    case "strong":
      return (
        <strong>
          <Inlines nodes={node.children} />
        </strong>
      );

    case "em":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );

    case "underline":
      return (
        <u>
          <Inlines nodes={node.children} />
        </u>
      );

    case "strike":
      return (
        <s>
          <Inlines nodes={node.children} />
        </s>
      );

    case "code":
      return <code className="prio-rt__code">{node.value}</code>;

    case "link": {
      const internal = node.href.startsWith("/");
      if (internal) {
        return (
          <Link href={node.href} className="prio-rt__link">
            <Inlines nodes={node.children} />
          </Link>
        );
      }
      return (
        <a
          href={node.href}
          className="prio-rt__link"
          target="_blank"
          /* `noopener` denies the opened page access to `window.opener`;
             `noreferrer` keeps Prio's internal URLs out of its referer log. */
          rel="noopener noreferrer nofollow"
        >
          <Inlines nodes={node.children} />
        </a>
      );
    }

    case "issue":
      /* A link to Prio's own issue route — the same route every other issue
         link uses, so it authorizes on arrival. Nothing here asserts the
         issue exists: an unknown key lands on the ordinary not-found page
         rather than being silently swallowed while typing. */
      return (
        <Link
          href={`/issues/${node.key.toLowerCase()}`}
          className="prio-rt__issue"
        >
          {node.key}
        </Link>
      );

    case "mention":
      return (
        <span className="prio-rt__mention" data-user={node.userId ?? undefined}>
          @{node.handle}
        </span>
      );
  }
}
