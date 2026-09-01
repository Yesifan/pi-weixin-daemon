/**
 * Bridge concurrency state (one daemon = one AgentSession = one in-flight turn).
 *
 *   IDLE ──prompt──▶ RUNNING ──agent completed──▶ IDLE
 *                      │
 *                      └──extension ui──▶ WAITING_FOR_UI ──user reply──▶ RUNNING
 *
 * No message queue: while RUNNING/WAITING_FOR_UI, new ordinary messages are
 * refused immediately with a busy reply (unless they are UI responses from the
 * turn origin account in WAITING_FOR_UI).
 */
export type BridgeState = "IDLE" | "RUNNING" | "WAITING_FOR_UI";

export const BUSY_REPLY = "⚠️ 当前 Agent 正在执行任务，请稍后再试。";
