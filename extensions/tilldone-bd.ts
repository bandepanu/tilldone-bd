/**
 * TillDone Extension — Work Till It's Done
 *
 * A task-driven discipline extension. The agent MUST define what it's going
 * to do (via `tilldone add`) before it can use any other tools. On agent
 * completion, if tasks remain incomplete, the agent gets nudged to continue
 * or mark them done. Play on words: "todo" → "tilldone" (work till done).
 *
 * Three-state lifecycle:  idle → inprogress → done
 *
 * Each list has a title and description that give the tasks a theme.
 * Use `new-list` to start a fresh list. `clear` wipes tasks with user confirm.
 *
 * UI surfaces:
 * - Footer:  persistent task list with live progress + list title
 * - Widget:  prominent "current task" display (the inprogress task)
 * - Status:  compact summary in the status line
 * - /tilldone:  interactive overlay with full task details
 *
 * Usage: local extension (agent/extensions/tilldone-bd.ts); no npm package needed.
 */

/**
 * TillDone Extension — Work Till It's Done (beads backend)
 *
 * Replacement for the retired npm tilldone package: identical tool contract
 * (tool `tilldone`, actions new-list/add/toggle/remove/update/list/clear,
 * statuses idle→inprogress→done, single-inprogress demotion, /tilldone overlay,
 * footer widget, status line, agent_end nudge, write-tool gate) but backed by
 * the persistent beads (bd) issue store instead of the ephemeral session branch.
 *
 * Storage: one beads label per list (`f_slug(listTitle)`, default `tilldone`),
 * active-list pointer in `<project>/.beads/tilldone.json`. Status mapping:
 * idle↔open, inprogress↔in_progress, done↔closed (blocked/deferred read as idle).
 *
 * Approval policy: the gate's own inner loop (add, toggle, list) runs
 * approval-free so the agent can never deadlock waiting for a human; every
 * other mutation (new-list incl. bd init, update, remove, clear) prompts via
 * ctx.ui.confirm and BLOCKS by default in headless non-UI contexts.
 *
 * Requires: bd CLI on PATH (npm i -g @beads/bd) + per-project `bd init`.
 * Windows note: spawns `bd.cmd`.
 *
 * Usage: drop into ~/.pi/agent/extensions/ and /reload (the legacy tilldone.ts
 * was retired; this is the only tilldone extension).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────

type TaskStatus = "idle" | "inprogress" | "done";

interface Task {
	id: number;
	ref: string; // beads issue id
	text: string;
	status: TaskStatus;
}

interface TillDoneDetails {
	action: string;
	tasks: Task[];
	nextId: number;
	listTitle?: string;
	listDescription?: string;
	error?: string;
}

const TillDoneParams = Type.Object({
	action: StringEnum(["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Task text (for add/update), or list title (for new-list)" })),
	texts: Type.Optional(Type.Array(Type.String(), { description: "Multiple task texts (for add). Use this to batch-add several tasks at once." })),
	description: Type.Optional(Type.String({ description: "List description (for new-list)" })),
	id: Type.Optional(Type.Number({ description: "Task ID (for toggle/remove/update)" })),
});

// ── Status helpers ─────────────────────────────────────────────────────

const STATUS_ICON: Record<TaskStatus, string> = { idle: "○", inprogress: "●", done: "✓" };
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = { idle: "inprogress", inprogress: "done", done: "idle" };
const STATUS_LABEL: Record<TaskStatus, string> = { idle: "idle", inprogress: "in progress", done: "done" };

// ── /tilldone overlay component ────────────────────────────────────────

class TillDoneListComponent {
	private tasks: Task[];
	private title: string | undefined;
	private desc: string | undefined;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], title: string | undefined, desc: string | undefined, theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.title = title;
		this.desc = desc;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const heading = this.title
			? th.fg("accent", ` ${this.title} `)
			: th.fg("accent", " TillDone ");
		const headingLen = this.title ? this.title.length + 2 : 10;
		lines.push(truncateToWidth(
			th.fg("borderMuted", "─".repeat(3)) + heading +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - headingLen))),
			width,
		));

		if (this.desc) {
			lines.push(truncateToWidth(`  ${th.fg("muted", this.desc)}`, width));
		}
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.tasks.filter((t) => t.status === "done").length;
			const active = this.tasks.filter((t) => t.status === "inprogress").length;
			const idle = this.tasks.filter((t) => t.status === "idle").length;

			lines.push(truncateToWidth(
				"  " +
				th.fg("success", `${done} done`) + th.fg("dim", "  ") +
				th.fg("accent", `${active} active`) + th.fg("dim", "  ") +
				th.fg("muted", `${idle} idle`),
				width,
			));
			lines.push("");

			for (const task of this.tasks) {
				const icon = task.status === "done"
					? th.fg("success", STATUS_ICON.done)
					: task.status === "inprogress"
						? th.fg("accent", STATUS_ICON.inprogress)
						: th.fg("dim", STATUS_ICON.idle);
				const id = th.fg("accent", `#${task.id}`);
				const text = task.status === "done"
					? th.fg("dim", task.text)
					: task.status === "inprogress"
						? th.fg("success", task.text)
						: th.fg("muted", task.text);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let nextId = 1;
	let listTitle: string | undefined;
	let listDescription: string | undefined;
	let nudgedThisCycle = false;

	// ── beads (bd) backend ────────────────────────────────────────────

	const BD_CMD = process.platform === "win32" ? "bd.cmd" : "bd";
	const STATUS_TO_BD: Record<TaskStatus, string> = { idle: "open", inprogress: "in_progress", done: "closed" };
	const BD_TO_STATUS: Record<string, TaskStatus> = { open: "idle", in_progress: "inprogress", blocked: "idle", deferred: "idle", closed: "done" };

	let s_storeRoot: string | undefined; // dir containing .beads/
	let s_bdMissing = false; // bd CLI not on PATH

	const f_slug = (s_text: string): string =>
		s_text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tilldone";

	// Unique, stable beads label for a list title: slug + 6-char hash so
	// distinct titles ("Q1 Plan" vs "q1 plan", emoji-only titles that slug to
	// "tilldone") never collide and merge lists.
	const f_labelOf = (s_title: string | undefined): string => {
		if (!s_title) return "tilldone";
		const s_slug = f_slug(s_title);
		let s_hash = 0;
		for (const ch of s_title) s_hash = (s_hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
		return `${s_slug}-${s_hash.toString(36).slice(0, 6)}`;
	};

	interface SidecarState {
	label: string;
	title?: string;
	description?: string;
	nextId?: number;
	ids?: Record<string, number>; // beads ref -> numeric id, stable across reloads
}

	const f_parseSidecar = (): SidecarState | undefined => {
		if (!s_storeRoot) return undefined;
		const s_file = resolve(s_storeRoot, ".beads", "tilldone.json");
		if (!existsSync(s_file)) return undefined;
		try {
			const d_raw = JSON.parse(readFileSync(s_file, "utf8"));
			return {
				label: typeof d_raw?.label === "string" ? d_raw.label : "tilldone",
				title: d_raw?.title,
				description: d_raw?.description,
				nextId: typeof d_raw?.nextId === "number" ? d_raw.nextId : undefined,
				ids: d_raw?.ids && typeof d_raw.ids === "object" ? d_raw.ids as Record<string, number> : undefined,
			};
		} catch {
			return undefined;
		}
	};

	let s_storageError: string | undefined; // last sidecar write failure

	const f_saveSidecar = (o_state: SidecarState): void => {
		s_storageError = undefined;
		if (!s_storeRoot) return;
		try {
			// Merge with what's on disk first so racing sessions (parent +
			// sub-agents share this store) never regress nextId or reuse a
			// task id: take the max nextId and the union of the ref→id maps.
			// (Residual race: two sessions may still claim the same id within
			// the same instant — a full fix needs a file lock; this makes
			// lost-update clobbering the exception, not the rule.)
			const s_file = resolve(s_storeRoot, ".beads", "tilldone.json");
			let d_current: SidecarState | undefined;
			try {
				d_current = f_parseSidecar();
			} catch { /* ignore */ }
			const o_merged: SidecarState = {
				label: o_state.label,
				title: o_state.title,
				description: o_state.description,
				nextId: Math.max(o_state.nextId ?? 1, d_current?.nextId ?? 1),
				ids: { ...(d_current?.ids ?? {}), ...(o_state.ids ?? {}) },
			};
			// Atomic replace: write a temp file, then rename over the target
			// (no partial/torn tilldone.json for a reader that races us).
			const s_tmp = s_file + ".tmp";
			writeFileSync(s_tmp, JSON.stringify(o_merged, null, 2), "utf8");
			renameSync(s_tmp, s_file);
		} catch (e) {
			s_storageError = String(e);
		}
	};

	const f_findStore = (s_startDir: string): string | undefined => {
		let s_dir = resolve(s_startDir || process.cwd());
		for (let i = 0; i < 12; i++) {
			if (existsSync(resolve(s_dir, ".beads"))) return s_dir;
			const s_parent = resolve(s_dir, "..");
			if (s_parent === s_dir) return undefined;
			s_dir = s_parent;
		}
		return undefined;
	};

	let s_bdScript: string | undefined; // resolved bd node script (win32)

	const f_bdInit = (): void => {
		// Windows: bd ships as an npm shim (bd.cmd) which Node cannot spawn
		// directly (EINVAL). Resolve the underlying node script from the shim
		// and spawn it via node — no cmd.exe, so titles containing '%', '&',
		// '$PATH', etc. are passed through verbatim (verified on bd v1.1.2).
		if (process.platform !== "win32" || s_bdScript) return;
		try {
			const a_candidates: string[] = [];
			for (const s_dir of (process.env.PATH || "").split(";")) {
				if (s_dir) a_candidates.push(s_dir);
			}
			// pi's runtime PATH may lack the npm global bin; probe the standard
			// Windows npm locations too.
			for (const s_env of [process.env.APPDATA, process.env.USERPROFILE]) {
				if (s_env) a_candidates.push(resolve(s_env, "npm"));
			}
			for (const s_dir of a_candidates) {
				const s_shim = resolve(s_dir, "bd.cmd");
				if (!existsSync(s_shim)) continue;
				const s_text = readFileSync(s_shim, "utf8");
				const m_rel = s_text.match(/"%dp0%\\([^"]+\.js)"/);
				const s_script = m_rel
					? resolve(s_dir, m_rel[1].replace(/\\/g, "/"))
					: resolve(s_dir, "node_modules", "@beads", "bd", "bin", "bd.js");
				if (existsSync(s_script)) {
					s_bdScript = s_script;
					return;
				}
			}
		} catch {
			// fall through to plain bd / bd.cmd
		}
	};

	const f_bd = (a_args: string[]): { ok: boolean; stdout: string; stderr: string } => {
		f_bdInit();
		const s_cmd = s_bdScript ? (process.execPath || "node") : BD_CMD;
		const a_spawn = s_bdScript ? [s_bdScript, ...a_args] : a_args;
		try {
			const o_r = spawnSync(s_cmd, a_spawn, { cwd: s_storeRoot ?? process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
			if (o_r.error) {
				const d_err = o_r.error as NodeJS.ErrnoException;
				if (d_err.code === "ENOENT") s_bdMissing = true;
				return { ok: false, stdout: "", stderr: String(o_r.error?.message ?? o_r.error) };
			}
			return { ok: o_r.status === 0, stdout: o_r.stdout ?? "", stderr: o_r.stderr ?? "" };
		} catch (e) {
			return { ok: false, stdout: "", stderr: String(e) };
		}
	};

	interface BeadsRow {
		id: string;
		title?: string;
		status?: string;
	}

	let s_lastBdError: string | undefined; // last bd query failure

	const f_queryTasks = (s_label: string): BeadsRow[] | null => {
		const o_r = f_bd(["list", "--label", s_label, "--all", "--json"]);
		if (!o_r.ok) {
			s_lastBdError = o_r.stderr.trim() || o_r.stdout.trim() || "bd list failed";
			return null;
		}
		try {
			const a_rows = JSON.parse(o_r.stdout) as BeadsRow[];
			return Array.isArray(a_rows) ? a_rows.filter((d_r) => d_r?.id && d_r.title !== undefined) : [];
		} catch {
			s_lastBdError = "bd list returned invalid JSON";
			return null;
		}
	};

	const f_sessionCwd = (ctx: ExtensionContext | ExtensionCommandContext): string =>
		(ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd()) as string;

	const f_refresh = (ctx: ExtensionContext | ExtensionCommandContext): void => {
		s_storeRoot = f_findStore(f_sessionCwd(ctx));

		const d_side = f_parseSidecar();
		const s_label = d_side?.label ?? "tilldone";

		// Numeric ids survive refreshes AND reloads: seed from the sidecar's
		// ref->id map, then overlay anything known in memory (newer).
		const d_known = new Map<string, number>();
		if (d_side?.ids) for (const [s_ref, s_id] of Object.entries(d_side.ids)) d_known.set(s_ref, s_id);
		for (const t of tasks) if (t.ref) d_known.set(t.ref, t.id);
		let s_nextLocal = d_side?.nextId ?? 1;
		for (const v of d_known.values()) s_nextLocal = Math.max(s_nextLocal, v + 1);

		if (!s_storeRoot) {
			// No .beads/ store in this project; empty list; gate will ask for bd init.
			tasks = [];
			listTitle = d_side?.title;
			listDescription = d_side?.description;
			nextId = s_nextLocal;
		} else if (s_bdMissing) {
			// CLI missing: keep the current view (nothing to query).
		} else {
			const a_rows = f_queryTasks(s_label);
			if (a_rows === null) {
				// Query failed: KEEP the previous task view so the gate/UI don't
				// masquerade as "no tasks" (and a retried add won't duplicate).
				if (tasks.length === 0 && !listTitle) {
					listTitle = d_side?.title;
					listDescription = d_side?.description;
					nextId = s_nextLocal;
				}
			} else {
				tasks = [];
				listTitle = d_side?.title;
				listDescription = d_side?.description;
				nextId = s_nextLocal;
				const d_newIds: Record<string, number> = {};
				for (const d_row of a_rows) {
					const s_status = BD_TO_STATUS[d_row.status ?? ""] ?? "idle";
					const s_id = d_known.get(d_row.id) ?? nextId++;
					d_newIds[d_row.id] = s_id;
					tasks.push({ id: s_id, ref: d_row.id, text: d_row.title ?? "", status: s_status });
				}
				f_saveSidecar({ label: s_label, title: listTitle, description: listDescription, nextId, ids: { ...(d_side?.ids ?? {}), ...d_newIds } });
			}
		}
		refreshUI(ctx);
	};

	// Approval gate for mutations: interactive confirm when UI present,
	// block-by-default otherwise (headless sub-agents / non-TUI sessions).
	const f_approve = async (ctx: ExtensionContext, s_title: string, s_body: string): Promise<boolean> => {
		if (!ctx.hasUI) {
			ctx.ui.notify?.("TillDone mutation requires interactive approval", "warning");
			return false;
		}
		try {
			return await ctx.ui.confirm(s_title, s_body, { timeout: 30000 });
		} catch {
			return false;
		}
	};

	// ── Snapshot for details ───────────────────────────────────────────

	const makeDetails = (action: string, error?: string): TillDoneDetails => ({
		action,
		tasks: [...tasks],
		nextId,
		listTitle,
		listDescription,
		...(error ? { error } : {}),
	});

	// ── UI refresh ─────────────────────────────────────────────────────

	const refreshWidget = (ctx: ExtensionContext) => {
		const current = tasks.find((t) => t.status === "inprogress");

		if (!current) {
			ctx.ui.setWidget("tilldone-current", undefined);
			return;
		}

		ctx.ui.setWidget("tilldone-current", (_tui, theme) => {
			const container = new Container();
			const borderFn = (s: string) => theme.fg("dim", s);

			container.addChild(new Text("", 0, 0));
			container.addChild(new DynamicBorder(borderFn));
			const content = new Text("", 1, 0);
			container.addChild(content);
			container.addChild(new DynamicBorder(borderFn));

			return {
				render(width: number): string[] {
					const cur = tasks.find((t) => t.status === "inprogress");
					if (!cur) return [];

					const line =
						theme.fg("accent", "● ") +
						theme.fg("dim", "WORKING ON  ") +
						theme.fg("accent", `#${cur.id}`) +
						theme.fg("dim", "  ") +
						theme.fg("success", cur.text);

					content.setText(truncateToWidth(line, width - 4));
					return container.render(width);
				},
				invalidate() { container.invalidate(); },
			};
		}, { placement: "belowEditor" });
	};

	const refreshFooter = (ctx: ExtensionContext) => {
		s_lastCtx = ctx;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const done = tasks.filter((t) => t.status === "done").length;
					const active = tasks.filter((t) => t.status === "inprogress").length;
					const idle = tasks.filter((t) => t.status === "idle").length;
					const total = tasks.length;

					// ── Line 1: list title + progress (left), counts (right) ──
					const titleDisplay = listTitle
						? theme.fg("accent", ` ${listTitle} `)
						: theme.fg("dim", " TillDone ");

					const l1Left = total === 0
						? titleDisplay + theme.fg("muted", "no tasks")
						: titleDisplay +
							theme.fg("warning", "[") +
							theme.fg("success", `${done}`) +
							theme.fg("dim", "/") +
							theme.fg("success", `${total}`) +
							theme.fg("warning", "]");

					const l1Right = total === 0
						? ""
						: theme.fg("dim", STATUS_ICON.idle + " ") + theme.fg("muted", `${idle}`) +
							theme.fg("dim", "  ") +
							theme.fg("accent", STATUS_ICON.inprogress + " ") + theme.fg("accent", `${active}`) +
							theme.fg("dim", "  ") +
							theme.fg("success", STATUS_ICON.done + " ") + theme.fg("success", `${done}`) +
							theme.fg("dim", " ");

					const pad1 = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
					const line1 = truncateToWidth(l1Left + pad1 + l1Right, width, "");

					const a_lines: string[] = [line1];

					if (total > 0) {
						// ── Rows: inprogress first, then most recent done, max 5 ──
						const activeTasks = tasks.filter((t) => t.status === "inprogress");
						const doneTasks = tasks.filter((t) => t.status === "done").reverse();
						const visible = [...activeTasks, ...doneTasks].slice(0, 5);
						const remaining = total - visible.length;

						const rows = visible.map((t) => {
							const icon = t.status === "done"
								? theme.fg("success", STATUS_ICON.done)
								: theme.fg("accent", STATUS_ICON.inprogress);
							const text = t.status === "done"
								? theme.fg("dim", t.text)
								: theme.fg("success", t.text);
							return truncateToWidth(` ${icon} ${text}`, width, "");
						});

						if (remaining > 0) {
							rows.push(truncateToWidth(
								` ${theme.fg("dim", `  +${remaining} more`)}`,
								width, "",
							));
						}

						a_lines.push(...rows);
					}

					// ── Default pi footer content, restored at the bottom ──
					a_lines.push(...f_buildDefaultFooterLines(width, theme, footerData));

					return a_lines;
				},
			};
		});
	};

	// ── Default pi footer content (pwd, token stats, model, context) ──

	let s_lastCtx: ExtensionContext | undefined;

	const f_fmtTokens = (s_count: number): string => {
		if (s_count < 1000) return s_count.toString();
		if (s_count < 10000) return `${(s_count / 1000).toFixed(1)}k`;
		if (s_count < 1000000) return `${Math.round(s_count / 1000)}k`;
		if (s_count < 10000000) return `${(s_count / 1000000).toFixed(1)}M`;
		return `${Math.round(s_count / 1000000)}M`;
	};

	const f_fmtCwd = (s_cwd: string): string => {
		const s_home = process.env.HOME || process.env.USERPROFILE;
		if (!s_home) return s_cwd;
		const s_resolvedCwd = resolve(s_cwd);
		const s_resolvedHome = resolve(s_home);
		const s_rel = relative(s_resolvedHome, s_resolvedCwd);
		const s_inside = s_rel === "" || (s_rel !== ".." && !s_rel.startsWith(`..${sep}`) && !isAbsolute(s_rel));
		if (!s_inside) return s_cwd;
		return s_rel === "" ? "~" : `~${sep}${s_rel}`;
	};

	const f_sanitize = (s_text: string): string =>
		s_text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

	const f_usageTotals = (): {
		input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
		latestCacheHitRate: number | undefined;
	} => {
		const d_totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let s_latestCacheHitRate: number | undefined;

		for (const entry of s_lastCtx?.sessionManager.getEntries() ?? []) {
			let o_usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;

			if (entry.type === "message") {
				if (entry.message.role === "assistant") {
					o_usage = entry.message.usage;
					if (o_usage) {
						const s_promptTokens = (o_usage.input ?? 0) + (o_usage.cacheRead ?? 0) + (o_usage.cacheWrite ?? 0);
						s_latestCacheHitRate = s_promptTokens > 0 ? ((o_usage.cacheRead ?? 0) / s_promptTokens) * 100 : undefined;
					}
				} else if (entry.message.role === "toolResult") {
					o_usage = entry.message.usage as typeof o_usage;
				}
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				o_usage = entry.usage as typeof o_usage;
			}

			if (o_usage) {
				d_totals.input += o_usage.input ?? 0;
				d_totals.output += o_usage.output ?? 0;
				d_totals.cacheRead += o_usage.cacheRead ?? 0;
				d_totals.cacheWrite += o_usage.cacheWrite ?? 0;
				d_totals.cost += o_usage.cost?.total ?? 0;
			}
		}

		return { ...d_totals, latestCacheHitRate: s_latestCacheHitRate };
	};

	const f_buildDefaultFooterLines = (
		width: number,
		theme: Theme,
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			getAvailableProviderCount(): number;
		},
	): string[] => {
		const d_totals = f_usageTotals();
		const o_model = s_lastCtx?.model;

		// ── pwd line: pwd (git branch) • session name ──
		let s_pwd = f_fmtCwd(s_lastCtx?.sessionManager.getCwd() ?? s_lastCtx?.cwd ?? "");
		const s_branch = footerData.getGitBranch();
		if (s_branch) s_pwd = `${s_pwd} (${s_branch})`;
		const s_sessionName = s_lastCtx?.sessionManager.getSessionName();
		if (s_sessionName) s_pwd = `${s_pwd} • ${s_sessionName}`;

		// ── stats line: tokens, cache, cost, context ──
		const a_statsParts: string[] = [];
		if (d_totals.input) a_statsParts.push(`↑${f_fmtTokens(d_totals.input)}`);
		if (d_totals.output) a_statsParts.push(`↓${f_fmtTokens(d_totals.output)}`);
		if (d_totals.cacheRead) a_statsParts.push(`R${f_fmtTokens(d_totals.cacheRead)}`);
		if (d_totals.cacheWrite) a_statsParts.push(`W${f_fmtTokens(d_totals.cacheWrite)}`);
		if ((d_totals.cacheRead > 0 || d_totals.cacheWrite > 0) && d_totals.latestCacheHitRate !== undefined) {
			a_statsParts.push(`CH${d_totals.latestCacheHitRate.toFixed(1)}%`);
		}

		const s_usingSubscription = o_model ? o_model.provider === "kimi-coding" : false;
		if (d_totals.cost || s_usingSubscription) {
			a_statsParts.push(`$${d_totals.cost.toFixed(3)}${s_usingSubscription ? " (sub)" : ""}`);
		}

		const o_contextUsage = s_lastCtx?.getContextUsage();
		const s_contextWindow = o_contextUsage?.contextWindow ?? o_model?.contextWindow ?? 0;
		const s_contextPercent = o_contextUsage?.percent ?? 0;
		const s_contextDisplay = o_contextUsage?.percent !== undefined && o_contextUsage?.percent !== null
			? `${s_contextPercent.toFixed(1)}%/${f_fmtTokens(s_contextWindow)}`
			: `?/${f_fmtTokens(s_contextWindow)}`;
		a_statsParts.push(
			s_contextPercent > 90 ? theme.fg("error", s_contextDisplay)
				: s_contextPercent > 70 ? theme.fg("warning", s_contextDisplay)
				: s_contextDisplay,
		);

		const s_statsLeft = a_statsParts.join(" ");
		const s_statsLeftWidth = visibleWidth(s_statsLeft);

		// ── right side: model name, provider, thinking level ──
		let s_right = o_model?.id || "no-model";
		if (o_model?.reasoning) {
			const s_thinking = s_lastCtx?.thinkingLevel || "off";
			s_right = s_thinking === "off" ? `${s_right} • thinking off` : `${s_right} • ${s_thinking}`;
		}
		if (footerData.getAvailableProviderCount() > 1 && o_model) {
			const s_prefixed = `(${o_model.provider}) ${s_right}`;
			if (s_statsLeftWidth + 2 + visibleWidth(s_prefixed) <= width) s_right = s_prefixed;
		}

		let s_statsLine = s_statsLeft;
		const s_rightWidth = visibleWidth(s_right);
		if (s_statsLeftWidth + 2 + s_rightWidth <= width) {
			s_statsLine = s_statsLeft + " ".repeat(width - s_statsLeftWidth - s_rightWidth) + s_right;
		} else {
			const s_availableForRight = width - s_statsLeftWidth - 2;
			if (s_availableForRight > 0) {
				const s_truncatedRight = truncateToWidth(s_right, s_availableForRight, "");
				s_statsLine = s_statsLeft + " ".repeat(Math.max(0, width - s_statsLeftWidth - visibleWidth(s_truncatedRight))) + s_truncatedRight;
			}
		}

		const s_dimStatsLeft = theme.fg("dim", s_statsLeft);
		const s_remainder = s_statsLine.slice(s_statsLeft.length);
		const s_dimRemainder = theme.fg("dim", s_remainder);

		const a_lines = [
			truncateToWidth(theme.fg("dim", s_pwd), width, theme.fg("dim", "...")),
			s_dimStatsLeft + s_dimRemainder,
		];

		// ── extension statuses line (e.g. TillDone status) ──
		const d_statuses = footerData.getExtensionStatuses();
		if (d_statuses.size > 0) {
			const a_statuses = Array.from(d_statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, s_text]) => f_sanitize(s_text));
			a_lines.push(truncateToWidth(a_statuses.join(" "), width, theme.fg("dim", "...")));
		}

		return a_lines;
	};

	const refreshUI = (ctx: ExtensionContext) => {
		const s_warn = [s_storageError, s_lastBdError].filter(Boolean).map((e) => `⚠ ${e}`).join(" ");
		const s_suffix = s_warn ? ` (${s_warn})` : "";
		if (tasks.length === 0) {
			ctx.ui.setStatus("tilldone", `📋 TillDone: no tasks${s_suffix}`);
		} else {
			const remaining = tasks.filter((t) => t.status !== "done").length;
			const label = listTitle ? `📋 ${listTitle}` : "📋 TillDone";
			ctx.ui.setStatus("tilldone", `${label}: ${tasks.length} tasks (${remaining} remaining)${s_suffix}`);
		}

		refreshWidget(ctx);
		refreshFooter(ctx);
	};

	// ── State reconstruction from session ──────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => f_refresh(ctx);
	// session_start covers startup, reload, new, resume, and fork
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── Blocking gate ──────────────────────────────────────────────────
	// Only blocks write/execute tools. Read-only tools (read, grep, find,
	// ls, glob) are always allowed so agents can explore before planning.
	// Subagent tools and dispatch tools are also whitelisted.

	const READ_ONLY_TOOLS = new Set([
		"read", "grep", "find", "ls", "glob",
		"query_experts",
		"subagent_create", "subagent_continue", "subagent_list", "subagent_remove",
		"dispatch_agent",
		"run_chain",
	]);

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "tilldone") return { block: false };
		if (READ_ONLY_TOOLS.has(event.toolName)) return { block: false };

		const pending = tasks.filter((t) => t.status !== "done");
		const active = tasks.filter((t) => t.status === "inprogress");

		if (tasks.length === 0) {
			const s_reason = s_bdMissing
				? "🚫 The `bd` CLI is not installed/on PATH. Install it (npm i -g @beads/bd), then reload, before using write/execute tools."
				: !s_storeRoot
					? "🚫 This project has no beads store (.beads/). Run `bd init` (or `tilldone new-list`, which can auto-init on approval) to define tasks before using write/execute tools."
					: "🚫 No TillDone tasks defined. Use `tilldone new-list` or `tilldone add` to define your tasks before using write/execute tools.";
			return {
				block: true,
				reason: s_reason,
			};
		}
		if (pending.length === 0) {
			return {
				block: true,
				reason: "🚫 All TillDone tasks are done. Use `tilldone add` for new tasks or `tilldone new-list` to start a fresh list.",
			};
		}
		if (active.length === 0) {
			return {
				block: true,
				reason: "🚫 No task is in progress. Use `tilldone toggle` to mark a task as inprogress before doing any work.",
			};
		}

		return { block: false };
	});

	// ── Auto-nudge on agent_end ────────────────────────────────────────

	pi.on("agent_end", async (_event, _ctx) => {
		const incomplete = tasks.filter((t) => t.status !== "done");
		if (incomplete.length === 0 || nudgedThisCycle) return;

		nudgedThisCycle = true;

		const taskList = incomplete
			.map((t) => `  ${STATUS_ICON[t.status]} #${t.id} [${STATUS_LABEL[t.status]}]: ${t.text}`)
			.join("\n");

		pi.sendMessage(
			{
				customType: "tilldone-nudge",
				content: `⚠️ You still have ${incomplete.length} incomplete task(s):\n\n${taskList}\n\nEither continue working on them or mark them done with \`tilldone toggle\`. Don't stop until it's done!`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("input", async () => {
		nudgedThisCycle = false;
		return { action: "continue" as const };
	});

	// ── Register tilldone tool ─────────────────────────────────────────

	pi.registerTool({
		name: "tilldone",
		label: "TillDone",
		description:
			"Manage your task list. You MUST add tasks before using any other tools. " +
			"Actions: new-list (text=title, description), add (text or texts[] for batch), toggle (id) — cycles idle→inprogress→done, remove (id), update (id + text), list, clear. " +
			"Always toggle a task to inprogress before starting work on it, and to done when finished. " +
			"Use new-list to start a themed list with a title and description. " +
			"IMPORTANT: If the user's new request does not fit the current list's theme, use clear to wipe the slate and new-list to start fresh.",
		parameters: TillDoneParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "new-list": {
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text (title) required for new-list" }],
							details: makeDetails("new-list", "text required"),
						};
					}

					// Missing store: offer to auto-init (runs `bd init` — it also writes
					// AGENTS.md/CLAUDE.md/README.md + .claude/ .codex/ .agents/ project files)
					if (!s_storeRoot) {
						const s_noStoreBody =
							"Initialize beads in this project? That runs `bd init`, which creates .beads/ plus project files (AGENTS.md, CLAUDE.md, README.md, .claude/, .codex/, .agents/) and git-ignore rules. Otherwise run `bd init` manually and retry new-list.";
						if (!(await f_approve(ctx, "Initialize beads store?", s_noStoreBody))) {
							return {
								content: [{ type: "text" as const, text: "Blocked: beads store missing. Run `bd init` in the project, then retry new-list." }],
								details: makeDetails("new-list", "bd init required"),
							};
						}
						const o_rInit = f_bd(["init"]);
						if (!o_rInit.ok) {
							return {
								content: [{ type: "text" as const, text: `bd init failed: ${o_rInit.stderr.trim() || o_rInit.stdout.trim()}` }],
								details: makeDetails("new-list", "bd init failed"),
							};
						}
						s_storeRoot = f_findStore(f_sessionCwd(ctx));
						// bd init can abort silently on non-interactive stdin (leaving
						// .beads/ with no database) — verify the store actually works.
						const o_rCheck = f_bd(["statuses", "--json"]);
						if (!o_rCheck.ok) {
							return {
								content: [{ type: "text" as const, text: `bd init did not complete (non-interactive run can abort) — run \`bd init\` interactively in the project, then retry. ${o_rCheck.stderr.trim() || "store not usable"}` }],
								details: makeDetails("new-list", "bd init incomplete"),
							};
						}s_storeRoot = f_findStore(f_sessionCwd(ctx));
					}

					// If a list already exists, confirm before swapping the active list
					if (tasks.length > 0 || listTitle) {
						if (!(await f_approve(
							ctx,
							"Start a new list?",
							`This will swap the active list to the new theme. Tasks already in beads stay on disk (under their old label) — nothing is deleted. ${listTitle ? `Current: "${listTitle}" (${tasks.length} task(s)).` : `${tasks.length} task(s) present.`} Continue?`,
						))) {
							return {
								content: [{ type: "text" as const, text: "New list cancelled (approval required)." }],
								details: makeDetails("new-list", "not approved"),
							};
						}
					}

					listTitle = params.text;
					listDescription = params.description || undefined;
					f_saveSidecar({ label: f_labelOf(listTitle), title: listTitle, description: listDescription, nextId: 1, ids: {} });
					f_refresh(ctx);

					const result = {
						content: [{
							type: "text" as const,
							text: `New list: "${listTitle}"${listDescription ? ` — ${listDescription}` : ""} (beads label ${f_labelOf(listTitle)})`,
						}],
						details: makeDetails("new-list"),
					};
					return result;
				}
				
				case "list": {
					f_refresh(ctx); // sync with external bd edits (TUI, other tools)
					const header = listTitle ? `${listTitle}:` : "";
					const result = {
						content: [{
							type: "text" as const,
							text: tasks.length
								? (header ? header + "\n" : "") +
									tasks.map((t) => `[${STATUS_ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`).join("\n")
								: "No tasks defined yet.",
						}],
						details: makeDetails("list"),
					};
					refreshUI(ctx);
					return result;
				}

				case "add": {
					const items = params.texts?.length ? params.texts : params.text ? [params.text] : [];
					if (items.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: text or texts required for add" }],
							details: makeDetails("add", "text required"),
						};
					}
					const s_label = f_labelOf(listTitle);
					const a_refs: string[] = [];
					const a_failReasons: string[] = [];
					for (const item of items) {
						const o_r = f_bd(["q", item, "-l", s_label, "-t", "task"]);
						if (o_r.ok) {
							const s_ref = o_r.stdout.trim().split(/\s+/)[0];
							if (s_ref) a_refs.push(s_ref);
							else a_failReasons.push("no ref in bd output");
						} else {
							a_failReasons.push(o_r.stderr.trim() || o_r.stdout.trim() || "bd q failed");
						}
					}
					f_refresh(ctx);
					const added = tasks.filter((t) => t.ref && a_refs.includes(t.ref));
					const a_failed = items.length - a_refs.length;
					const msg = added.length === 0
						? "No tasks added (bd failed)."
						: added.length === 1
							? `Added task #${added[0].id}: ${added[0].text}`
							: `Added ${added.length} tasks: ${added.map((t) => `#${t.id}`).join(", ")}`;
					const result = {
						content: [{
							type: "text" as const,
							text: a_failed > 0 ? `${msg} (${a_failed} failed: ${a_failReasons.join("; ")})` : msg,
						}],
						details: makeDetails("add"),
					};
					return result;
				}
				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
							details: makeDetails("toggle", "id required"),
						};
					}
					const task = tasks.find((t) => t.id === params.id);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("toggle", `#${params.id} not found`),
						};
					}
					const prev = task.status;
					const next = NEXT_STATUS[task.status];

					
					// Enforce single inprogress — demote any other active task in beads.
					// Interactive-only: a headless session (sub-agent / RPC) must never
					// silently flip another session's tasks — the sweep would demote the
					// parent's active task (stalling its write gate: "No task is in
					// progress") and the done→idle cycle could resurrect parent-closed
					// tasks. Headless toggles change only their own task.
					const demoted: Task[] = [];
					const a_demoteFail: string[] = [];
					if (next === "inprogress" && ctx.hasUI) {
						for (const t of tasks) {
							if (t.id !== task.id && t.status === "inprogress") {
								if (f_bd(["update", t.ref, "--status", "open"]).ok) demoted.push(t);
								else a_demoteFail.push(`#${t.id}`);
							}
						}
					}

					const o_rU = f_bd(["update", task.ref, "--status", STATUS_TO_BD[next]]);
					if (!o_rU.ok) {
						return {
							content: [{ type: "text" as const, text: `bd update failed: ${o_rU.stderr.trim() || o_rU.stdout.trim()}` }],
							details: makeDetails("toggle", "bd update failed"),
						};
					}
					f_refresh(ctx);

					const t_now = tasks.find((t) => t.ref === task.ref);
					let msg = t_now ? `Task #${t_now.id}: ${prev} → ${t_now.status}` : `Task ${task.ref}: ${prev} → ${next}`;
					if (demoted.length > 0) {
						msg += `\n(Auto-paused ${demoted.map((t) => `#${t.id}`).join(", ")} → idle. Only one task can be in progress at a time.)`;
					}
					if (a_demoteFail.length > 0) {
						msg += `\n(⚠ failed to pause ${a_demoteFail.join(", ")} — more than one task may be in progress in beads.)`;
					}

					const result = {
						content: [{
							type: "text" as const,
							text: msg,
						}],
						details: makeDetails("toggle"),
					};
					return result;
				}
				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
							details: makeDetails("remove", "id required"),
						};
					}
					const task = tasks.find((t) => t.id === params.id);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("remove", `#${params.id} not found`),
						};
					}
					if (!(await f_approve(ctx, `Remove task #${task.id}?`, `"${task.text}" will be permanently deleted from .beads/ (bd delete --force, ref ${task.ref}).`))) {
						return {
							content: [{ type: "text" as const, text: "Remove cancelled (approval required)." }],
							details: makeDetails("remove", "not approved"),
						};
					}
					const o_r = f_bd(["delete", task.ref, "--force"]);
					if (!o_r.ok) {
						return {
							content: [{ type: "text" as const, text: `bd delete failed: ${o_r.stderr.trim() || o_r.stdout.trim()}` }],
							details: makeDetails("remove", "bd delete failed"),
						};
					}
					f_refresh(ctx);
					const result = {
						content: [{ type: "text" as const, text: `Removed task #${task.id}: ${task.text}` }],
						details: makeDetails("remove"),
					};
					return result;
				}
				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for update" }],
							details: makeDetails("update", "id required"),
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text required for update" }],
							details: makeDetails("update", "text required"),
						};
					}
					const toUpdate = tasks.find((t) => t.id === params.id);
					if (!toUpdate) {
						return {
							content: [{ type: "text" as const, text: `Task #${params.id} not found` }],
							details: makeDetails("update", `#${params.id} not found`),
						};
					}
					const oldText = toUpdate.text;
					if (!(await f_approve(ctx, `Update task #${toUpdate.id}?`, `"${oldText}" → "${params.text}" (beads ref ${toUpdate.ref})`))) {
						return {
							content: [{ type: "text" as const, text: "Update cancelled (approval required)." }],
							details: makeDetails("update", "not approved"),
						};
					}
					const o_rU = f_bd(["update", toUpdate.ref, "--title", params.text]);
					if (!o_rU.ok) {
						return {
							content: [{ type: "text" as const, text: `bd update failed: ${o_rU.stderr.trim() || o_rU.stdout.trim()}` }],
							details: makeDetails("update", "bd update failed"),
						};
					}
					f_refresh(ctx);
					const t_now = tasks.find((t) => t.ref === toUpdate.ref);
					const result = {
						content: [{
							type: "text" as const,
							text: t_now ? `Updated #${t_now.id}: "${oldText}" → "${t_now.text}"` : `Updated ${toUpdate.ref}: "${oldText}" → "${params.text}"`,
						}],
						details: makeDetails("update"),
					};
					return result;
				}
				case "clear": {
					if (tasks.length > 0) {
						if (!(await f_approve(
							ctx,
							"Clear TillDone list?",
							`This will permanently DELETE all ${tasks.length} task(s)${listTitle ? ` from "${listTitle}" (beads label ${f_labelOf(listTitle)})` : ""} in .beads/ via bd delete --force. Continue?`,
						))) {
							return {
								content: [{ type: "text" as const, text: "Clear cancelled (approval required)." }],
								details: makeDetails("clear", "not approved"),
							};
						}
					}

					const count = tasks.length;
					const a_refs = tasks.map((t) => t.ref);
					const a_deleteFail: string[] = [];
					for (const s_ref of a_refs) {
						if (!f_bd(["delete", s_ref, "--force"]).ok) a_deleteFail.push(s_ref);
					}
					listTitle = undefined;
					listDescription = undefined;
					f_saveSidecar({ label: "tilldone", nextId: 1, ids: {} });
					f_refresh(ctx);

					const result = {
						content: [{
							type: "text" as const,
							text: `Cleared ${count} task(s)` + (a_deleteFail.length ? ` (⚠ ${a_deleteFail.length} failed: ${a_deleteFail.join(", ")})` : ""),
						}],
						details: makeDetails("clear"),
					};
					return result;
				}
				
				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: makeDetails("list", `unknown action: ${params.action}`),
					};
			}
		},

		renderCall(args, theme) {
			// Compact chip: per-action glyph + payload, NOT the tool name (a bold
			// "tilldone <action>" on every call piles N identical labels in the
			// transcript tail — one per add/toggle/list — which reads as noise).
			const s_action = args.action;
			const s_glyph =
				s_action === "new-list" ? "◈"
				: s_action === "add" ? "＋"
				: s_action === "toggle" ? "↻"
				: s_action === "remove" ? "✕"
				: s_action === "update" ? "✎"
				: s_action === "clear" ? "≡"
				: "📋";
			let text = theme.fg("toolTitle", s_glyph);
			if (args.texts?.length) text += ` ${theme.fg("dim", `${args.texts.length} tasks`)}`;
			else if (args.text) text += ` ${theme.fg("accent", `"${args.text}"`)}`;
			if (args.description) text += ` ${theme.fg("dim", `— ${args.description}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TillDoneDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const taskList = details.tasks;

			switch (details.action) {
				case "new-list": {
					let msg = theme.fg("success", "✓ New list ") + theme.fg("accent", `"${details.listTitle}"`);
					if (details.listDescription) {
						msg += theme.fg("dim", ` — ${details.listDescription}`);
					}
					return new Text(msg, 0, 0);
				}

				case "list": {
					if (taskList.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);

					let listText = "";
					if (details.listTitle) {
						listText += theme.fg("accent", details.listTitle) + theme.fg("dim", "  ");
					}
					listText += theme.fg("muted", `${taskList.length} task(s):`);
					const display = expanded ? taskList : taskList.slice(0, 5);
					for (const t of display) {
						const icon = t.status === "done"
							? theme.fg("success", STATUS_ICON.done)
							: t.status === "inprogress"
								? theme.fg("accent", STATUS_ICON.inprogress)
								: theme.fg("dim", STATUS_ICON.idle);
						const itemText = t.status === "done"
							? theme.fg("dim", t.text)
							: t.status === "inprogress"
								? theme.fg("success", t.text)
								: theme.fg("muted", t.text);
						listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && taskList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${taskList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("accent", "⟳ ") + theme.fg("muted", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("warning", "✕ ") + theme.fg("muted", msg), 0, 0);
				}

				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all tasks"), 0, 0);

				default:
					return new Text(theme.fg("dim", "done"), 0, 0);
			}
		},
	});

	// ── /tilldone command ──────────────────────────────────────────────

	pi.registerCommand("tilldone", {
		description: "Show all TillDone tasks on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tilldone requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TillDoneListComponent(tasks, listTitle, listDescription, theme, () => done());
			});
		},
	});
}
