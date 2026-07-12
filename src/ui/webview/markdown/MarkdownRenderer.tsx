import { Fragment, type ComponentChildren, type JSX } from "preact";

export const MAX_MARKDOWN_LENGTH = 100_000;

type InlineNode =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "strong"; readonly children: readonly InlineNode[] }
  | { readonly kind: "emphasis"; readonly children: readonly InlineNode[] }
  | { readonly kind: "link"; readonly label: readonly InlineNode[]; readonly href: string };

export type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly children: readonly InlineNode[] }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly InlineNode[];
    }
  | { readonly kind: "unordered-list"; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: "ordered-list"; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: "code"; readonly language?: string; readonly value: string };

interface MarkdownRendererProps {
  readonly source: string;
}

export function MarkdownRenderer({ source }: MarkdownRendererProps): JSX.Element {
  const blocks = parseMarkdown(source);
  return (
    <div class="thread-markdown">{blocks.map((block, index) => renderBlock(block, index))}</div>
  );
}

export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const normalizedSource = normalizeSource(source);
  const lines = normalizedSource.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}```([A-Za-z0-9_+-]{0,32})\s*$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const language = fence[1] ? fence[1].toLowerCase() : undefined;
      blocks.push({ kind: "code", language, value: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    const unorderedItem = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unorderedItem) {
      const items: (readonly InlineNode[])[] = [];
      while (index < lines.length) {
        const item = /^\s*[-*+]\s+(.+)$/.exec(lines[index] ?? "");
        if (!item) {
          break;
        }
        items.push(parseInline(item[1]));
        index += 1;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    const orderedItem = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (orderedItem) {
      const items: (readonly InlineNode[])[] = [];
      while (index < lines.length) {
        const item = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index] ?? "");
        if (!item) {
          break;
        }
        items.push(parseInline(item[1]));
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";
      if (
        paragraphLine.trim() === "" ||
        /^ {0,3}```/.test(paragraphLine) ||
        /^(#{1,6})\s+/.test(paragraphLine) ||
        /^\s*[-*+]\s+/.test(paragraphLine) ||
        /^\s*\d+[.)]\s+/.test(paragraphLine)
      ) {
        break;
      }
      paragraphLines.push(paragraphLine);
      index += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", children: parseInline(paragraphLines.join("\n")) });
    }
  }

  return blocks;
}

function normalizeSource(source: string): string {
  const safeSource = typeof source === "string" ? source : "";
  if (safeSource.length <= MAX_MARKDOWN_LENGTH) {
    return safeSource.replace(/\r\n?/g, "\n");
  }
  return `${safeSource.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[本文は長すぎるため省略されました]`;
}

function parseInline(source: string): readonly InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";

  const flushText = (): void => {
    if (text) {
      nodes.push({ kind: "text", value: text });
      text = "";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && index + 1 < source.length) {
      text += source[index + 1];
      index += 1;
      continue;
    }

    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end !== -1) {
        flushText();
        nodes.push({ kind: "code", value: source.slice(index + 1, end) });
        index = end;
        continue;
      }
    }

    const strongMarker = source.slice(index, index + 2);
    if (strongMarker === "**" || strongMarker === "__") {
      const end = source.indexOf(strongMarker, index + 2);
      if (end > index + 2) {
        flushText();
        nodes.push({ kind: "strong", children: parseInline(source.slice(index + 2, end)) });
        index = end + 1;
        continue;
      }
    }

    if (source[index] === "*" || source[index] === "_") {
      const marker = source[index];
      const end = source.indexOf(marker, index + 1);
      if (end > index + 1) {
        flushText();
        nodes.push({ kind: "emphasis", children: parseInline(source.slice(index + 1, end)) });
        index = end;
        continue;
      }
    }

    if (source[index] === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      const urlEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const href = sanitizeHref(source.slice(labelEnd + 2, urlEnd).trim());
        flushText();
        if (href) {
          nodes.push({
            kind: "link",
            label: parseInline(source.slice(index + 1, labelEnd)),
            href,
          });
        } else {
          nodes.push({ kind: "text", value: source.slice(index, urlEnd + 1) });
        }
        index = urlEnd;
        continue;
      }
    }

    text += source[index];
  }

  flushText();
  return nodes;
}

function sanitizeHref(value: string): string | undefined {
  if (!/^(https?:|mailto:)/i.test(value)) {
    return undefined;
  }
  return value;
}

function renderBlock(block: MarkdownBlock, key: number): ComponentChildren {
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as keyof JSX.IntrinsicElements;
      return <Heading key={key}>{renderInline(block.children)}</Heading>;
    }
    case "paragraph":
      return (
        <p key={key} class="thread-markdown-paragraph">
          {renderInline(block.children)}
        </p>
      );
    case "unordered-list":
      return (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "ordered-list":
      return (
        <ol key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre key={key} class="thread-code-block">
          <code class={block.language ? `language-${block.language}` : undefined}>
            {block.value}
          </code>
        </pre>
      );
  }
}

function renderInline(nodes: readonly InlineNode[]): ComponentChildren {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.value}</Fragment>;
      case "code":
        return <code key={index}>{node.value}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "emphasis":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.label)}
          </a>
        );
    }
  });
}
