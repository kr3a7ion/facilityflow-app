/**
 * Composition layer over the work-order lifecycle.
 *
 * `workOrders` owns the state machine and knows nothing about PPM; `ppm` knows how to
 * advance a schedule and nothing about the lifecycle. This module joins them so that
 * verifying a PPM job rolls its schedule forward — without either service importing
 * the other. Routes and tests use this facade, never `workOrders.verify` directly.
 */
import type { Db } from '../db/connection.js';
import * as wo from './workOrders.js';
import * as ppm from './ppm.js';

export * from './workOrders.js';

export function verify(db: Db, ctx: wo.Ctx, id: string, note?: string): wo.WorkOrder {
  const result = wo.verify(db, ctx, id, note);
  ppm.onWorkOrderVerified(db, ctx.propertyId, id);
  return result;
}
