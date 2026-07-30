import {
	readdir,
	realpath,
	stat,
} from "node:fs/promises";
import {
	isAbsolute,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";

const blockedEntryNames = new Set([
	".git",
	".ssh",
	".aws",
	"node_modules",
]);
const maxSuggestions = 50;

interface ReferencePrefix {
	prefix: string;
	path: string;
	quoted: boolean;
}

function extractReferencePrefix(text: string): ReferencePrefix | undefined {
	const quoted = /(?:^|\s)(@"[^"]*)$/.exec(text)?.[1];
	if (quoted) {
		return {
			prefix: quoted,
			path: quoted.slice(2),
			quoted: true,
		};
	}
	const unquoted = /(?:^|\s)(@[^\s]*)$/.exec(text)?.[1];
	if (!unquoted) return undefined;
	return {
		prefix: unquoted,
		path: unquoted.slice(1),
		quoted: false,
	};
}

function isBlockedEntry(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		blockedEntryNames.has(lower) ||
		lower === ".env" ||
		lower.startsWith(".env.")
	);
}

function isWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!isAbsolute(pathFromRoot))
	);
}

function isSafeRelativePath(value: string): boolean {
	if (
		value.includes("\0") ||
		value.startsWith("~") ||
		isAbsolute(value) ||
		win32.isAbsolute(value)
	) {
		return false;
	}
	const segments = value.split(/[\\/]+/).filter(Boolean);
	return (
		!segments.includes("..") &&
		!segments.some((segment) => isBlockedEntry(segment))
	);
}

function containsBlockedRealPath(root: string, candidate: string): boolean {
	return relative(root, candidate)
		.split(/[\\/]+/)
		.filter(Boolean)
		.some((segment) => isBlockedEntry(segment));
}

export class LearningAutocompleteProvider implements AutocompleteProvider {
	private readonly commandProvider: CombinedAutocompleteProvider;
	private readonly workspaceRoot: string;
	private readonly workspaceRealPath: Promise<string>;
	private readonly onReferenceContext?: (active: boolean) => void;

	constructor(
		commands: readonly SlashCommand[],
		workspaceRoot: string,
		onReferenceContext?: (active: boolean) => void,
	) {
		this.commandProvider = new CombinedAutocompleteProvider(
			[...commands],
			workspaceRoot,
		);
		this.workspaceRoot = resolve(workspaceRoot);
		this.workspaceRealPath = realpath(this.workspaceRoot);
		this.onReferenceContext = onReferenceContext;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.startsWith("/")) {
			this.onReferenceContext?.(false);
			return await this.commandProvider.getSuggestions(
				lines,
				cursorLine,
				cursorCol,
				options,
			);
		}

		const reference = extractReferencePrefix(textBeforeCursor);
		this.onReferenceContext?.(reference !== undefined);
		if (!reference || !isSafeRelativePath(reference.path)) return null;
		return await this.getReferenceSuggestions(reference, options.signal);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	} {
		this.onReferenceContext?.(
			prefix.startsWith("@") && item.label.endsWith("/"),
		);
		return this.commandProvider.applyCompletion(
			lines,
			cursorLine,
			cursorCol,
			item,
			prefix,
		);
	}

	shouldTriggerFileCompletion(): boolean {
		return false;
	}

	private async getReferenceSuggestions(
		reference: ReferencePrefix,
		signal: AbortSignal,
	): Promise<AutocompleteSuggestions | null> {
		if (signal.aborted) return null;
		const displayPath = reference.path.replace(/\\/g, "/");
		const slashIndex = displayPath.lastIndexOf("/");
		const directory = slashIndex === -1 ? "" : displayPath.slice(0, slashIndex + 1);
		const searchPrefix = displayPath.slice(slashIndex + 1);
		const searchDirectory = resolve(
			this.workspaceRoot,
			...directory.split("/").filter(Boolean),
		);
		if (!isWithin(this.workspaceRoot, searchDirectory)) return null;

		let workspaceRealPath: string;
		let searchRealPath: string;
		try {
			[workspaceRealPath, searchRealPath] = await Promise.all([
				this.workspaceRealPath,
				realpath(searchDirectory),
			]);
		} catch {
			return null;
		}
		if (
			!isWithin(workspaceRealPath, searchRealPath) ||
			containsBlockedRealPath(workspaceRealPath, searchRealPath)
		) {
			return null;
		}

		const entries = await readdir(searchRealPath, {
			withFileTypes: true,
		}).catch(() => undefined);
		if (!entries) return null;
		const suggestions: AutocompleteItem[] = [];
		for (const entry of entries) {
			if (
				signal.aborted ||
				isBlockedEntry(entry.name) ||
				!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())
			) {
				continue;
			}
			const candidate = resolve(searchRealPath, entry.name);
			let candidateRealPath: string;
			try {
				candidateRealPath = await realpath(candidate);
			} catch {
				continue;
			}
			if (
				!isWithin(workspaceRealPath, candidateRealPath) ||
				containsBlockedRealPath(workspaceRealPath, candidateRealPath)
			) {
				continue;
			}

			const isDirectory =
				entry.isDirectory() ||
				(entry.isSymbolicLink() &&
					(await this.isDirectory(candidateRealPath)));
			const completedPath = `${directory}${entry.name}${isDirectory ? "/" : ""}`;
			const needsQuotes = reference.quoted || /\s/.test(completedPath);
			const value = needsQuotes
				? `@"${completedPath}${isDirectory ? "" : '"'}`
				: `@${completedPath}`;
			suggestions.push({
				value,
				label: completedPath,
				description: isDirectory ? "workspace directory" : "workspace file",
			});
			if (suggestions.length >= maxSuggestions) break;
		}
		suggestions.sort((left, right) => left.label.localeCompare(right.label));
		return suggestions.length > 0
			? { items: suggestions, prefix: reference.prefix }
			: null;
	}

	private async isDirectory(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	}
}
