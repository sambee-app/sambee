import type { Element, Root } from "hast";
import rehypeSlug from "rehype-slug";
import type { Plugin } from "unified";

export const MARKDOWN_HEADING_ID_PREFIX = "sambee-markdown-";

export const rehypeMarkdownHeadingLinks: Plugin<[], Root> = () => {
  const assignIds = rehypeSlug({ prefix: MARKDOWN_HEADING_ID_PREFIX });
  return (tree) => {
    assignIds(tree);
    const targets = new Set<string>();
    const links: Element[] = [];
    const visit = (node: Root | Element) => {
      if (node.type === "element") {
        if (/^h[1-6]$/.test(node.tagName) && typeof node.properties.id === "string") targets.add(node.properties.id);
        if (node.tagName === "a") links.push(node);
      }
      for (const child of node.children) if (child.type === "element") visit(child);
    };
    visit(tree);
    for (const link of links) {
      const href = link.properties.href;
      if (typeof href !== "string" || !href.startsWith("#")) continue;
      let fragment: string;
      try {
        fragment = decodeURIComponent(href.slice(1));
      } catch {
        continue;
      }
      const id = fragment.startsWith(MARKDOWN_HEADING_ID_PREFIX) ? fragment : `${MARKDOWN_HEADING_ID_PREFIX}${fragment}`;
      if (targets.has(id)) link.properties.href = `#${encodeURIComponent(id)}`;
    }
  };
};
