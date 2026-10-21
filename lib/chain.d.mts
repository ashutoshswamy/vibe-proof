/* eslint-disable @typescript-eslint/no-explicit-any */
export type ChainRecord = { seq: number; ts: string; runId: string; kind: "start" | "check" | "end"; prev: string; data: any; hash: string };
export type Report = { format?: string; runId?: string; head?: string; records: ChainRecord[]; [k: string]: any };
export const GENESIS: string;
export function sha(v: unknown): string;
export function hashRecord(r: Omit<ChainRecord, "hash">): string;
export function testHash(url: string, slow: boolean, checks: { id: number; title: string }[]): string;
export function buildChain(o: { runId: string; url: string; slow?: boolean; checks: { id: number; section: string; title: string; status: string; reason?: string; fix?: string }[]; link?: { runId: string; head: string } | null; statusCode?: number }): ChainRecord[];
export function reportOf(records: ChainRecord[], extra?: object): Report;
export function verifyChain(report: Report, expectedHead?: string): { ok: true; records: number; head: string } | { ok: false; at: number; reason: string };
export function compareRetest(original: Report, retest: Report, only?: number[]): { fixVerified: boolean; status: string; reason: string; fixed: number[]; stillFailing: number[] };
