export interface CommentLocation {
  file: string;
  line?: number;
  endLine?: number;
}

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
  return action === "reply" || action === "comment" || action === "edit";
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
