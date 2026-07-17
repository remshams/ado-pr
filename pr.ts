/**
 * Creates Azure DevOps pull requests, and lists/creates/replies-to/resolves PR comment threads,
 * for the pull request associated with the current branch of a git checkout whose origin remote
 * points at Azure Repos.
 *
 * Auth: requires an AZURE_DEVOPS_PAT env var (a Personal Access Token with "Code" scope - "Read"
 * is enough for `list`, "Read & Write" is needed for `create`/`comment`/`reply`/`resolve`/`batch`).
 * Run this via pr.sh, which loads it from .env (see .env.tpl). If the 1Password CLI (`op`) is
 * installed, .env is loaded via `op run` so an op:// 1Password reference works too (resolved
 * just-in-time, never written to disk); otherwise .env is loaded directly, which requires
 * AZURE_DEVOPS_PAT to be a literal secret.
 */
import { pullRequestWebUrl } from "./azure.ts";
import { runBatch } from "./batch.ts";
import { getPat, parseArgs } from "./cli.ts";
import { createFileAnchorCache } from "./file-anchors.ts";
import { getRepoContext } from "./lib.ts";
import { toCommentLocation } from "./operation-types.ts";
import { createPullRequest, resolvePullRequestId } from "./pull-requests.ts";
import {
  formatSummaryTable,
  formatThread,
  getFilteredThreads,
  postComment,
  postReply,
  resolveThread,
  threadWebUrl,
} from "./threads.ts";

async function main(): Promise<void> {
  const options = parseArgs();
  const pat = getPat();
  const ctx = await getRepoContext();

  // "create" makes a brand-new PR, so there's no existing PR ID to resolve yet.
  if (options.action === "create") {
    const pr = await createPullRequest(ctx, pat, options);
    console.log(`Created PR #${pr.pullRequestId}: ${pr.title}`);
    console.log(pullRequestWebUrl(ctx, pr.pullRequestId));
    return;
  }

  const prId = await resolvePullRequestId(ctx, options.pr, pat);

  switch (options.action) {
    case "list": {
      const threads = await getFilteredThreads(ctx, prId, pat, options);

      if (options.json) {
        console.log(JSON.stringify(threads, null, 2));
        return;
      }
      if (threads.length === 0) {
        console.log(`No matching comment threads on PR #${prId}.`);
        return;
      }
      console.log(`Comment threads on PR #${prId}:\n`);
      console.log(threads.map((thread) => formatThread(thread, ctx, prId)).join("\n\n"));
      console.log("\n---\n\nSummary:\n");
      console.log(formatSummaryTable(threads, ctx, prId));
      return;
    }
    case "comment": {
      const location = toCommentLocation(options);
      const thread = await postComment(
        ctx,
        prId,
        options.message!,
        pat,
        location,
        createFileAnchorCache(),
      );
      console.log(`Posted new comment thread ${thread.id} on PR #${prId}.`);
      console.log(threadWebUrl(ctx, prId, thread.id));
      return;
    }
    case "reply": {
      await postReply(ctx, prId, options.thread!, options.message!, pat);
      console.log(`Posted reply to thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "resolve": {
      await resolveThread(ctx, prId, options.thread!, pat);
      console.log(`Marked thread ${options.thread} on PR #${prId} as resolved.`);
      return;
    }
    case "batch": {
      await runBatch(ctx, pat, prId);
      return;
    }
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
