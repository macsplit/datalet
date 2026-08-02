import { useCallback } from "react";
import type { Block } from "../shapes/orm/metaShapes.typings";
import { byOrderThenId, newMetaSubjectIri, nextOrder } from "./metaHookUtils";
import { useMetaStore } from "./MetaStoreContext";

export type BlockParent =
  | { parentTabId: string; parentBlockId?: never }
  | { parentBlockId: string; parentTabId?: never };

export type CreateBlock = BlockParent &
  Pick<Block, "blockType"> &
  Partial<Pick<Block, "order" | "title" | "layoutMode" | "schemaId">>;

/** Read all sibling blocks for a tab/layout block and expose mutations. */
export function useBlocks(parent?: BlockParent) {
  const { privateNuri, blockSet } = useMetaStore();
  const blocks = [...blockSet]
    .filter((block) => {
      if (!parent) return true;
      if (parent.parentTabId !== undefined) {
        return block.parentTabId === parent.parentTabId;
      }
      return block.parentBlockId === parent.parentBlockId;
    })
    .sort(byOrderThenId);

  const createBlock = useCallback(
    (values: CreateBlock) => {
      if (!privateNuri) return;
      const blockId = newMetaSubjectIri("block");
      const siblings = [...blockSet].filter((block) =>
        values.parentTabId !== undefined
          ? block.parentTabId === values.parentTabId
          : block.parentBlockId === values.parentBlockId,
      );
      blockSet.add({
        "@graph": privateNuri,
        "@id": blockId,
        "@type": "did:ng:z:Block",
        blockType: values.blockType,
        order: values.order ?? nextOrder(siblings),
        ...(values.title !== undefined && { title: values.title }),
        ...(values.layoutMode !== undefined && { layoutMode: values.layoutMode }),
        ...(values.schemaId !== undefined && { schemaId: values.schemaId }),
        ...(values.parentTabId !== undefined
          ? { parentTabId: values.parentTabId }
          : { parentBlockId: values.parentBlockId }),
      });
      return blockId;
    },
    [blockSet, privateNuri],
  );

  const deleteBlock = useCallback(
    (block: Block) => blockSet.delete(block),
    [blockSet],
  );

  return { blocks, createBlock, deleteBlock };
}
