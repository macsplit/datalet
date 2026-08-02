import type { Block } from "../shapes/orm/metaShapes.typings";
import { RUNTIME_LIMITS } from "./runtimeHealth";

export class BlockGraphLimitError extends Error {}

/** Linear, cycle-safe descendant traversal shared by destructive operations. */
export function collectDescendantBlockIds(
  blocks: Block[],
  rootIds: Iterable<string>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.parentBlockId) continue;
    const siblings = children.get(block.parentBlockId) ?? [];
    siblings.push(block["@id"]);
    children.set(block.parentBlockId, siblings);
  }

  const result = new Set(rootIds);
  const queue = [...result];
  for (let index = 0; index < queue.length; index += 1) {
    if (result.size > RUNTIME_LIMITS.graphNodes) {
      throw new BlockGraphLimitError(
        `The operation crossed ${RUNTIME_LIMITS.graphNodes.toLocaleString()} blocks and was stopped.`,
      );
    }
    for (const childId of children.get(queue[index]) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}
