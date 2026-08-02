import { resolve } from "node:path";

export interface WorkspaceEnvironment {
	LOGOS_AGENT_WORKSPACE?: string;
	INIT_CWD?: string;
}

export function resolveWorkspaceRoot(
	environment: WorkspaceEnvironment,
	processDirectory: string,
): string {
	const explicitWorkspace = environment.LOGOS_AGENT_WORKSPACE?.trim();
	if (explicitWorkspace) return resolve(processDirectory, explicitWorkspace);
	const launchDirectory = environment.INIT_CWD?.trim();
	return resolve(processDirectory, launchDirectory || ".");
}
