import type { CommandId } from "./command-registry.ts";

export interface CommentLocation {
  file: string;
  line?: number;
  endLine?: number;
}

interface PullRequestTarget {
  pr?: number;
}

type CliOptionsShape =
  | {
      resource: "pr";
      command: "list";
      json: boolean;
    }
  | (PullRequestTarget & {
      resource: "pr";
      command: "show";
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
      build: number;
      fullLogs: boolean;
      json: boolean;
    })
  | (PullRequestTarget & {
      resource: "build";
      command: "retry";
      build: number;
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
    })
  | (PullRequestTarget & {
      resource: "comment";
      command: "reply";
      thread: number;
      message: string;
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
export type CliOptions = RegistryMatchesCliOptions extends true ? CliOptionsShape : never;

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Builds an optional file-anchor location from CLI options or a batch operation. */
export function toCommentLocation(source: {
  file?: string;
  line?: number;
  endLine?: number;
}): CommentLocation | undefined {
  return source.file
    ? { file: source.file, line: source.line, endLine: source.endLine }
    : undefined;
}
