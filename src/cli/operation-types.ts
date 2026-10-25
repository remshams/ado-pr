import type { ResolvedStatus } from "../comments/threads.ts";
import type { CommandId } from "../shared/command-contracts.ts";

interface PullRequestTarget {
	pr?: number;
}

type CliOptionsShape =
	| {
			resource: "pr";
			command: "list";
			reviewing: boolean;
			all: boolean;
			target?: string;
			json: boolean;
	  }
	| (PullRequestTarget & {
			resource: "pr";
			command: "attach";
			path: string;
			name?: string;
	  })
	| (PullRequestTarget & {
			resource: "pr";
			command: "show";
			json: boolean;
	  })
	| (PullRequestTarget & {
			resource: "pr";
			command: "status";
			json: boolean;
	  })
	| (PullRequestTarget & {
			resource: "pr";
			command: "diff";
			sinceIteration?: number;
			sinceLastReview: boolean;
			nameOnly: boolean;
			json: boolean;
	  })
	| {
			resource: "pr";
			command: "create";
			title: string;
			description?: string;
			sourceBranch?: string;
			targetBranch?: string;
			draft: boolean;
			images?: string[];
			reviewers?: string[];
	  }
	| (PullRequestTarget & {
			resource: "pr";
			command: "edit";
			description?: string;
			draft?: boolean;
			images?: string[];
			removeImages?: string[];
			reviewers?: string[];
			removeReviewers?: string[];
	  })
	| (PullRequestTarget & {
			resource: "build";
			command: "list";
			history: boolean;
			json: boolean;
	  })
	| (PullRequestTarget & {
			resource: "build";
			command: "show";
			build?: number;
			latest: boolean;
			fullLogs: boolean;
			json: boolean;
	  })
	| (PullRequestTarget & {
			resource: "build";
			command: "retry";
			build: number;
	  })
	| (PullRequestTarget & {
			resource: "build";
			command: "queue";
			branch?: string;
			definition?: number;
	  })
	| (PullRequestTarget & {
			resource: "build";
			command: "wait";
			build?: number;
			latest: boolean;
			intervalSeconds: number;
			timeoutSeconds: number;
			json: boolean;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "list";
			json: boolean;
			excludeOwn: boolean;
			excludeResolved: boolean;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "create";
			message: string;
			file?: string;
			line?: number;
			endLine?: number;
			attachment?: string;
			attachmentName?: string;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "reply";
			thread: number;
			message: string;
			status?: ResolvedStatus;
			attachment?: string;
			attachmentName?: string;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "edit";
			thread: number;
			comment: number;
			message: string;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "delete";
			thread: number;
			comment: number;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "resolve";
			thread: number;
			status: ResolvedStatus;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "reopen";
			thread: number;
	  })
	| (PullRequestTarget & {
			resource: "comment";
			command: "batch";
	  });

type CommandIdFor<Option> = Option extends {
	resource: infer Resource extends string;
	command: infer Command extends string;
}
	? `${Resource}.${Command}`
	: never;
type CliOptionCommandId = CommandIdFor<CliOptionsShape>;
type Assert<T extends true> = T;
type RegistryMatchesCliOptions = Assert<
	[CommandId] extends [CliOptionCommandId]
		? [CliOptionCommandId] extends [CommandId]
			? true
			: false
		: false
>;
export type CliOptions = RegistryMatchesCliOptions extends true
	? CliOptionsShape
	: never;
