/** Bounded authority observations. No record asserts that a recipient read or acted on it. */
type Message = { id: string; at: number | null; from: string | null; to: string[] };
export type TeamMessage =
 | (Message & { kind: "alert"; alertKind: string; text: string; task?: string; status: "accepted" })
 | (Message & { kind: "delivery"; deliveryKind: "alert" | "task" | "stop"; ref: string; status: "accepted" | "submitted" | "settled" | "retired"; conversationId: string; generation: number; acceptedAt?: number; submittedAt?: number; settledAt?: number; submissionId?: string; outcome?: string })
 | (Message & { kind: "lead-update"; eventKind: string; text?: string; task?: string; tasks?: string[]; worker?: string; status: "recorded" });

export type TeamMessages =
 | { availability: "unavailable"; reason: string }
 | { availability: "available"; source: string; epoch: string; limits: { alerts: number; deliveries: number; events: number }; records: TeamMessage[] };
