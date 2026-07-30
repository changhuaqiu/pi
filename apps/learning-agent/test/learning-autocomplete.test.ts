import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LearningAutocompleteProvider } from "../src/learning-autocomplete.ts";

async function suggestions(
	provider: LearningAutocompleteProvider,
	text: string,
): Promise<string[]> {
	const result = await provider.getSuggestions(
		[text],
		0,
		text.length,
		{ signal: new AbortController().signal },
	);
	return result?.items.map((item) => item.value) ?? [];
}

test("workspace autocomplete suggests safe files and rejects path escapes", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "learning-autocomplete-"));
	const workspace = join(tempRoot, "workspace");
	const outside = join(tempRoot, "outside");
	await mkdir(join(workspace, "src"), { recursive: true });
	await mkdir(join(workspace, ".git"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(workspace, "src", "safe.ts"), "safe");
	await writeFile(join(workspace, ".git", "config"), "sensitive");
	await writeFile(join(outside, "secret.txt"), "secret");
	try {
		const provider = new LearningAutocompleteProvider([], workspace);
		assert.deepEqual(await suggestions(provider, "@src/s"), ["@src/safe.ts"]);
		assert.deepEqual(await suggestions(provider, "@../"), []);
		assert.deepEqual(await suggestions(provider, "@/"), []);
		assert.deepEqual(await suggestions(provider, "@~/"), []);
		assert.deepEqual(await suggestions(provider, "@.git/"), []);

		await symlink(
			outside,
			join(workspace, "escape"),
			process.platform === "win32" ? "junction" : "dir",
		);
		assert.doesNotMatch(
			(await suggestions(provider, "@")).join("\n"),
			/escape/,
		);
		assert.deepEqual(await suggestions(provider, "@escape/"), []);
		await symlink(
			join(workspace, ".git"),
			join(workspace, "git-alias"),
			process.platform === "win32" ? "junction" : "dir",
		);
		assert.doesNotMatch(
			(await suggestions(provider, "@git-")).join("\n"),
			/git-alias/,
		);
		assert.deepEqual(await suggestions(provider, "@git-alias/"), []);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
