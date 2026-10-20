/**
 * Shared helpers for parsing Azure DevOps remotes and running Git commands.
 */
import { spawn } from "node:child_process";

export interface AzureDevOpsRepoContext {
	organization: string;
	project: string;
	repository: string;
}

/**
 * Parses an Azure DevOps org/project/repo out of a git remote URL, supporting the HTTPS
 * (dev.azure.com and legacy *.visualstudio.com) and SSH remote formats Azure Repos hands out.
 */
export function parseAzureDevOpsRemote(
	remoteUrl: string,
): AzureDevOpsRepoContext {
	const patterns = [
		// https://dev.azure.com/{org}/{project}/_git/{repo} (optionally with a "{org}@" prefix, as
		// used for HTTPS credential prompts)
		/^https:\/\/(?:[^/@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/,
		// git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
		/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
		// https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo} (legacy)
		/^https:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/,
	];

	for (const pattern of patterns) {
		const match = pattern.exec(remoteUrl);
		if (match) {
			const [, organization, project, repository] = match;
			return {
				organization: decodeURIComponent(organization),
				project: decodeURIComponent(project),
				repository: decodeURIComponent(repository),
			};
		}
	}

	throw new Error(
		`Could not parse an Azure DevOps organization/project/repository from remote URL: "${remoteUrl}"`,
	);
}

export async function getRepoContext(): Promise<AzureDevOpsRepoContext> {
	const { stdout } = await runCommand("git", ["remote", "get-url", "origin"]);
	return parseAzureDevOpsRemote(stdout.trim());
}

export async function getCurrentBranch(
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	const { stdout } = await runCommand(
		"git",
		["rev-parse", "--abbrev-ref", "HEAD"],
		options,
	);
	return stdout.trim();
}

export function runCommand(
	command: string,
	args: string[],
	options: {
		inheritTerminal?: boolean;
		detached?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		// When a command may need to interact with the user (e.g. a sudo password prompt), inherit
		// stdin/stderr so it can read/write directly to the real terminal, while still piping stdout
		// so we can inspect it.
		const child = spawn(command, args, {
			stdio: options.inheritTerminal ? ["inherit", "pipe", "inherit"] : "pipe",
			detached: options.detached,
			signal: options.signal,
		});
		let stdout = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
		child.once("error", reject);
		child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
	});
}
