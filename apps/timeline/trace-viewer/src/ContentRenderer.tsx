import DOMPurify from "dompurify";
import { lexer, type MarkedToken, type Token } from "marked";
import { memo, useEffect, useId, useMemo, useState, type ElementType, type ReactNode } from "react";
import "./ContentRenderer.css";

/*
 * Governance: this module renders untrusted trace text for the exact-Session
 * Trace Viewer. It owns safety and lazy loading only: Markdown becomes React
 * elements, and Mermaid becomes a sanitized Blob-backed image. It does not own
 * trace evidence, Rarebit selection, or the raw-record authority, and it must
 * never fetch a resource, run active markup, or leak diagram CSS into the host
 * UI. Consumers pass text; the raw record stays the evidence authority.
 */

export interface ContentRendererProps {
  readonly text: string;
}

export interface MermaidDiagramRenderer {
  (source: string, id: string): Promise<string>;
}

interface MermaidBlockProps {
  readonly id: string;
  readonly source: string;
  readonly renderDiagram?: MermaidDiagramRenderer;
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// DOMPurify's SVG profile owns the element/attribute policy and preserves the
// geometry, marker, gradient, and filter vocabulary a diagram needs. This
// module adds only the resource policy and the raw-fallback decision.
const EXTERNAL_SVG_ATTRIBUTES = new Set(["href", "src", "xlink:href"]);
// Local fragment references are inert; external or embedded resources are not.
const UNSAFE_CSS_VALUE =
  /(?:url\s*\(\s*['"]?(?!#)|@import|@font-face|@namespace|expression\s*\(|behavior\s*:|-moz-binding|(?:javascript|data|vbscript):|(?:https?:)?\/\/|<)/iu;
// Dropping these can remove labels, shapes, or embedded resources, so the
// sanitizer refuses the output instead of shipping an incomplete diagram.
const UNSUPPORTED_SVG_CONTENT = new Set(["a", "foreignobject", "image", "use"]);

type Purifier = ReturnType<typeof DOMPurify>;
let privatePurifier: Purifier | null = null;

/**
 * Use a private DOMPurify instance. Mermaid imports the shared singleton too,
 * so adding hooks there would change Mermaid's own sanitization policy.
 */
function getPurifier(): Purifier | null {
  if (privatePurifier !== null) return privatePurifier;
  if (typeof window === "undefined") return null;
  const instance = DOMPurify(window);
  instance.addHook("uponSanitizeAttribute", (_node, data) => {
    if (
      EXTERNAL_SVG_ATTRIBUTES.has(data.attrName.toLowerCase()) ||
      UNSAFE_CSS_VALUE.test(data.attrValue)
    )
      data.keepAttr = false;
  });
  instance.addHook("afterSanitizeElements", (node) => {
    if (node.nodeName.toLowerCase() === "style" && UNSAFE_CSS_VALUE.test(node.textContent ?? ""))
      (node as Element).remove();
  });
  privatePurifier = instance;
  return privatePurifier;
}

/** Styles are inert inside the image; keep safe CSS and re-inject it. */
function takeSafeSvgStyles(root: Element): string[] {
  const styles: string[] = [];
  for (const element of [...root.querySelectorAll("style")]) {
    const css = element.textContent ?? "";
    if (css.trim() !== "" && !UNSAFE_CSS_VALUE.test(css)) styles.push(css);
    element.remove();
  }
  return styles;
}

function injectSvgStyles(svg: string, styles: readonly string[]): string {
  if (styles.length === 0) return svg;
  const match = /<svg\b[^>]*>/iu.exec(svg);
  if (match === null) return svg;
  const block = styles.map((css) => `<style>${css}</style>`).join("");
  const end = match.index + match[0].length;
  return svg.slice(0, end) + block + svg.slice(end);
}

/** DOMPurify can drop xmlns; an SVG loaded as an image needs it. */
function ensureSvgNamespace(svg: string): string {
  const match = /<svg\b([^>]*)>/iu.exec(svg);
  if (match === null || /\bxmlns\s*=/iu.test(match[1])) return svg;
  const root = `<svg xmlns="http://www.w3.org/2000/svg"${match[1]}>`;
  return svg.slice(0, match.index) + root + svg.slice(match.index + match[0].length);
}

function safeLink(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return null;
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return trimmed.startsWith("//") ? null : trimmed;
  }
  try {
    const url = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Mermaid returns markup rather than a React tree. DOMPurify's SVG profile
 * removes scripts, event handlers, and unknown markup while preserving the
 * geometry and markers a diagram needs. This wrapper adds the resource policy
 * and refuses output that would lose visible content, so the caller can show
 * the raw source instead of an incomplete diagram.
 */
export function sanitizeMermaidSvg(markup: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root === null || root.localName !== "svg" || parsed.querySelector("parsererror")) return null;
  for (const element of parsed.querySelectorAll("*"))
    if (UNSUPPORTED_SVG_CONTENT.has(element.localName.toLowerCase())) return null;
  const styles = takeSafeSvgStyles(root);
  const purifier = getPurifier();
  if (purifier === null) return null;
  const stripped = new XMLSerializer().serializeToString(root);
  const sanitized = purifier.sanitize(stripped, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  if (!sanitized.includes("<svg")) return null;
  return injectSvgStyles(ensureSvgNamespace(sanitized), styles);
}

export function prepareMermaidSource(source: string): string {
  const withoutConfig = source
    .replace(/^\s*---\s*\n[\s\S]*?\n---\s*$/mu, "")
    .replace(/%%\{[\s\S]*?\}%%/gu, "");
  // Strip only active/resource Mermaid directives. URL-looking label text is
  // evidence, not a request, so it must survive to the rendered diagram.
  return withoutConfig
    .split("\n")
    .filter((line) => !/^\s*(?:click|link|image)\b/iu.test(line))
    .join("\n");
}

async function renderWithMermaid(source: string, id: string): Promise<string> {
  const module = await import("mermaid");
  const mermaid = module.default;
  mermaid.initialize({
    fontFamily: "sans-serif",
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
  });
  const result = await mermaid.render(id, prepareMermaidSource(source));
  // MermaidBlock sanitizes the result once; this adapter stays a pure render.
  return result.svg;
}

export function MermaidBlock(props: MermaidBlockProps) {
  return <MermaidBlockRender key={`${props.id}:${props.source}`} {...props} />;
}

function MermaidBlockRender({ id, source, renderDiagram = renderWithMermaid }: MermaidBlockProps) {
  const [diagramUrl, setDiagramUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    renderDiagram(source, id)
      .then((svg) => {
        const sanitized = sanitizeMermaidSvg(svg);
        if (sanitized === null) throw new Error("Mermaid returned unsafe or invalid SVG");
        if (typeof URL.createObjectURL !== "function") throw new Error("Blob URLs unavailable");
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([sanitized], { type: "image/svg+xml" }));
        setDiagramUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [id, renderDiagram, source]);

  if (diagramUrl !== null)
    return (
      <figure className="content-mermaid" data-testid="mermaid-diagram">
        <img
          alt="Mermaid diagram"
          onError={() => {
            URL.revokeObjectURL(diagramUrl);
            setDiagramUrl(null);
            setFailed(true);
          }}
          src={diagramUrl}
        />
        <figcaption>Mermaid diagram</figcaption>
      </figure>
    );
  return (
    <div className="content-mermaid-fallback" data-testid="mermaid-fallback">
      {failed && <p>Diagram could not be rendered. Raw Mermaid source:</p>}
      {!failed && <p>Rendering Mermaid diagram…</p>}
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * Marked keeps HTML entities as source text. A text node does not decode them,
 * so decode the small entity grammar we can trust: numeric references plus a
 * named allowlist. This only ever produces text, never markup.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu,
    (match: string, entity: string) => {
      if (entity.startsWith("#")) {
        const hexadecimal = entity[1] === "x" || entity[1] === "X";
        const code = Number.parseInt(
          hexadecimal ? entity.slice(2) : entity.slice(1),
          hexadecimal ? 16 : 10,
        );
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function renderInline(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => renderToken(token as MarkedToken, `${keyPrefix}-${index}`));
}

function renderTableCell(
  tokens: readonly Token[],
  align: "center" | "left" | "right" | null,
  header: boolean,
  key: string,
) {
  const Tag: ElementType = header ? "th" : "td";
  return (
    <Tag key={key} style={align ? { textAlign: align } : undefined}>
      {renderInline(tokens, key)}
    </Tag>
  );
}

// Marked exposes one discriminated union with many presentation variants.
// Keep the dispatch in one place so every unknown token remains inert text.
// eslint-disable-next-line complexity
function renderToken(token: MarkedToken, key: string): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "text":
    case "escape":
      return "tokens" in token && token.tokens ? (
        <>{renderInline(token.tokens, key)}</>
      ) : (
        decodeEntities(token.text)
      );
    case "heading": {
      const Tag = HEADING_TAGS[token.depth - 1] ?? "h6";
      return <Tag key={key}>{renderInline(token.tokens, key)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(token.tokens, key)}</p>;
    case "strong":
      return <strong key={key}>{renderInline(token.tokens, key)}</strong>;
    case "em":
      return <em key={key}>{renderInline(token.tokens, key)}</em>;
    case "del":
      return <del key={key}>{renderInline(token.tokens, key)}</del>;
    case "codespan":
      return <code key={key}>{token.text}</code>;
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{renderInline(token.tokens, key)}</blockquote>;
    case "code":
      return token.lang?.trim().toLowerCase().split(/[\s,]/u)[0] === "mermaid" ? (
        <MermaidBlock
          id={`mermaid-${key.replace(/[^a-z0-9_-]/giu, "-")}`}
          key={key}
          source={token.text}
        />
      ) : (
        <pre key={key}>
          <code>{token.text}</code>
        </pre>
      );
    case "link": {
      const href = safeLink(token.href);
      const children = renderInline(token.tokens, key);
      if (href === null)
        return (
          <span className="content-blocked-link" key={key}>
            {children}
          </span>
        );
      const external = /^https?:/u.test(href);
      return (
        <a
          href={href}
          key={key}
          rel={external ? "noreferrer noopener" : undefined}
          target={external ? "_blank" : undefined}
          title={token.title ?? undefined}
        >
          {children}
        </a>
      );
    }
    case "image":
      return (
        <span
          aria-label={`Image omitted: ${token.text}`}
          className="content-blocked-resource"
          key={key}
        >
          Image omitted: {token.text}
        </span>
      );
    case "list": {
      if (token.ordered) {
        const start = token.start !== "" ? token.start : undefined;
        return (
          <ol key={key} start={start}>
            {token.items.map((item, index) => renderToken(item, `${key}-${index}`))}
          </ol>
        );
      }
      return (
        <ul key={key}>{token.items.map((item, index) => renderToken(item, `${key}-${index}`))}</ul>
      );
    }
    case "list_item":
      return (
        <li key={key}>
          {token.task && (
            <input
              aria-label={token.checked ? "Completed task" : "Incomplete task"}
              checked={token.checked}
              readOnly
              type="checkbox"
            />
          )}
          {renderInline(token.tokens, key)}
        </li>
      );
    case "table":
      return (
        <table key={key}>
          <thead>
            <tr>
              {token.header.map((cell, index) =>
                renderTableCell(
                  cell.tokens,
                  token.align[index] ?? null,
                  true,
                  `${key}-header-${index}`,
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {token.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {row.map((cell, index) =>
                  renderTableCell(
                    cell.tokens,
                    token.align[index] ?? null,
                    false,
                    `${key}-${rowIndex}-${index}`,
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "html":
      // Raw HTML stays inert but visible, because it is still trace evidence.
      return <span key={key}>{token.text}</span>;
    default: {
      const nested = (token as { tokens?: readonly Token[] }).tokens;
      return nested ? <>{renderInline(nested, key)}</> : decodeEntities(token.raw);
    }
  }
}

function ContentRendererView({ text }: ContentRendererProps) {
  const tokens = useMemo(
    // Marked's lexer returns the wider Token union, but with no custom
    // extensions it only emits the known MarkedToken variants.
    () => lexer(text, { gfm: true, breaks: true }) as MarkedToken[],
    [text],
  );
  const instanceId = useId().replace(/:/gu, "");
  return (
    <div className="content-renderer">
      {tokens.map((token, index) => renderToken(token, `${instanceId}-${index}`))}
    </div>
  );
}

export const ContentRenderer = memo(ContentRendererView);
ContentRenderer.displayName = "ContentRenderer";
