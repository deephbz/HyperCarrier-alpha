// Carrier-neutral Arc link. Session refs belong to the source adapter; this
// boundary carries committed receipts, live samples and durable command IDs.
import type { ReceiptRevision } from "./core/types.ts";
import type { BuildStatus, DismissResult, RequestResult } from "../shared/arc.ts";
import type { ServiceStatus } from "./service/status.ts";
import type { Stamp } from "./service/engine.ts";
export type ArcCommand = { t: "arc.request"; requestId: string; sessionRef: string } & (
 | { kind: "manual" | "rebuild"; requester: string }
 | { kind: "dismiss"; dropId: string; toPosition: number }
);
export type ArcResult = RequestResult | DismissResult;
export type ArcScheduled = { sessionRef: string; nextAt: string; trigger: "owner" | "stop" };
export type ArcFrame =
 | { t: "arc.hello"; stamp: Stamp; generation: string; service: ServiceStatus; expected: Stamp }
 | ({ t: "arc.receipt" } & ReceiptRevision)
 | { t: "arc.status"; generation: string; seq: number; service: ServiceStatus; statuses: BuildStatus[]; scheduled: ArcScheduled[] }
 | { t: "arc.ack"; requestId: string; result: ArcResult | { outcome: "unknown" } };
