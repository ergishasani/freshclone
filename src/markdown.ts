import { fromMarkdown } from 'mdast-util-from-markdown';

/** A shell command explicitly selected from the project's README. */
export interface ReadmeBlock {
  id: string;
  command: string;
  /** One-based line of the first command, after the opening code fence. */
  line: number;
}

const markerPattern = /^<!--\s*freshclone:([A-Za-z][A-Za-z0-9_-]*)\s*-->$/;
const shellLanguages = new Set(['sh', 'bash', 'shell']);

type MarkdownNode = {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MarkdownNode[];
  position?: { start: { line: number; offset?: number } };
};

/**
 * Extract opted-in shell fences using Markdown's syntax tree. Text inside a
 * code fence is never interpreted as another FreshClone marker.
 */
export function extractBlocks(markdown: string): Map<string, ReadmeBlock> {
  const tree = fromMarkdown(markdown);
  const blocks = new Map<string, ReadmeBlock>();

  function visit(nodes: readonly MarkdownNode[]): void {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;

      if (node.type === 'html') {
        const html = node.value?.trim() ?? '';
        const marker = markerPattern.exec(html);
        if (marker) {
          const id = marker[1]!;
          const markerLine = node.position?.start.line ?? 1;
          if (blocks.has(id)) {
            throw new Error(`Duplicate FreshClone block "${id}" at README line ${markerLine}.`);
          }

          const next = nodes[index + 1];
          if (next?.type !== 'code') {
            throw new Error(
              `FreshClone marker "${id}" at README line ${markerLine} must immediately precede a shell code fence.`,
            );
          }
          if (!next.lang || !shellLanguages.has(next.lang)) {
            throw new Error(
              `FreshClone block "${id}" at README line ${markerLine} must use a sh, bash, or shell code fence.`,
            );
          }
          const command = next.value ?? '';
          if (!command.trim()) {
            throw new Error(`FreshClone block "${id}" at README line ${markerLine} is empty.`);
          }

          blocks.set(id, {
            id,
            command,
            line: (next.position?.start.line ?? markerLine) + 1,
          });
          index += 1;
          continue;
        }

        if (/^<!--\s*freshclone:/.test(html)) {
          throw new Error(
            `Invalid FreshClone marker at README line ${node.position?.start.line ?? 1}. Use <!-- freshclone:block-name --> on its own line.`,
          );
        }
      }

      if (node.children) visit(node.children);
    }
  }

  visit(tree.children);
  return blocks;
}
