import { useSyncExternalStore } from "react";
import { useShape as useOrmShape } from "@ng-org/orm/react";
import type { BaseType, ShapeType } from "@ng-org/shex-orm";
import type { Scope } from "@ng-org/orm";
import {
  getExternalRevision,
  subscribeExternalRevision,
} from "../utils/localNgEngine";

/**
 * The ORM's signal object accepts backend patches correctly, but its React
 * adapter does not invalidate consumers for every backend-applied primitive
 * update in this local-engine integration. Subscribe to the engine's explicit
 * external revision as a repo-owned bridge; the ORM still owns all data and
 * mutation semantics.
 */
export function useShape<T extends BaseType>(
  shape: ShapeType<T>,
  scope: Scope | string | undefined,
) {
  const records = useOrmShape(shape, scope);
  useSyncExternalStore(
    subscribeExternalRevision,
    getExternalRevision,
    getExternalRevision,
  );
  return records;
}
