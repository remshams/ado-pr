export interface CommentLocation {
  file: string;
  line?: number;
  endLine?: number;
}

interface PullRequestTarget {
  pr?: number;
}

export type CliOptions =
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
    }
  | (PullRequestTarget &
      (
        | {
            resource: "pr";
            command: "edit";
            description: string;
            draft?: boolean;
          }
        | {
            resource: "pr";
            command: "edit";
            description?: never;
            draft: boolean;
          }
      ))
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

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function actionRequiresThread(action: string): boolean {
  return action === "reply" || action === "resolve" || action === "edit" || action === "delete";
}

export function actionRequiresComment(action: string): boolean {
  return action === "edit" || action === "delete";
}

export function actionRequiresMessage(action: string): boolean {
  return action === "create" || action === "reply" || action === "edit";
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
