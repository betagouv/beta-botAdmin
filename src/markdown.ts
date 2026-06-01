import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkStringify from "remark-stringify";
import matter from "gray-matter";
import type { Root, Content, Heading, Paragraph, Code, BlockContent, DefinitionContent } from "mdast";

export interface Section {
  breadcrumb: string;
  depth: number;
  content: string;
}

// Strip GitBook-specific syntax blocks
function stripGitBook(content: string): string {
  return content
    .replace(/\{%.*?%\}/gs, "")
    .replace(/\s*<a\s[^>]*><\/a>/g, "");
}

// Extract text content from an MDAST node recursively
function nodeText(node: Content | Root): string {
  if ("value" in node) return (node as { value: string }).value;
  if ("children" in node) {
    return (node as { children: Content[] }).children
      .map(nodeText)
      .join(" ");
  }
  return "";
}

export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const { data, content: body } = matter(content);
  return { data: data as Record<string, unknown>, body };
}

export function extractSections(rawContent: string): Section[] {
  const cleaned = stripGitBook(rawContent);
  const { body } = parseFrontmatter(cleaned);

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter);

  const tree = processor.parse(body) as Root;

  const sections: Section[] = [];
  const headingStack: { depth: number; text: string }[] = [];
  let currentContent: string[] = [];

  function flushSection() {
    const content = currentContent.join(" ").trim();
    if (content.length === 0) return;
    const breadcrumb =
      headingStack.map((h) => h.text).join(" > ") || "Introduction";
    const depth = headingStack.length > 0 ? headingStack[headingStack.length - 1].depth : 0;
    sections.push({ breadcrumb, depth, content });
    currentContent = [];
  }

  for (const node of tree.children) {
    if (node.type === "heading") {
      flushSection();
      const hNode = node as Heading;
      const text = nodeText(hNode).trim();
      // Pop headings of same or deeper depth
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].depth >= hNode.depth
      ) {
        headingStack.pop();
      }
      headingStack.push({ depth: hNode.depth, text });
    } else {
      const text = nodeText(node as Content).trim();
      if (text) currentContent.push(text);
    }
  }
  flushSection();

  // Merge sections with < 50 chars content into the previous one
  const merged: Section[] = [];
  for (const section of sections) {
    if (
      section.content.length < 50 &&
      merged.length > 0
    ) {
      merged[merged.length - 1].content += " " + section.content;
    } else {
      merged.push({ ...section });
    }
  }

  return merged;
}
