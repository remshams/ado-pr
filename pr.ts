/**
 * Creates Azure DevOps pull requests, and lists/creates/replies-to/edits/deletes/resolves PR comments,
 * for the pull request associated with the current branch of a git checkout whose origin remote
 * points at Azure Repos.
 *
 * Auth: requires an AZURE_DEVOPS_PAT env var (a Personal Access Token with "Code" scope - "Read"
 * is enough for `list`, "Read & Write" is needed for comment-changing actions and `batch`).
 * Run this via pr.sh, which accepts an exported PAT or loads one from .env. Literal values use
 * Node's native dotenv support; op:// references are resolved just-in-time through 1Password CLI
 * and are never written to disk by the launcher.
 */
import { createAzureRequester, pullRequestWebUrl } from "./azure.ts";
import { createBatchRunner } from "./batch.ts";
import { getPat, parseArgs } from "./cli.ts";
import { createFileAnchorService } from "./file-anchors.ts";
import { getRepoContext } from "./lib.ts";
import { toCommentLocation } from "./operation-types.ts";
import { createPullRequestService } from "./pull-requests.ts";
import { createThreadService } from "./threads.ts";

async function main(): Promise<void> {
  const options = parseArgs();
  const pat = getPat();
  const ctx = await getRepoContext();

  const azure = createAzureRequester({ pat });
  const pullRequests = createPullRequestService({ azure, ctx });
  const fileAnchors = createFileAnchorService({ azure, ctx });
  const threads = createThreadService({ azure, ctx, fileAnchors });
  const batch = createBatchRunner({ threads });

  // "create" makes a brand-new PR, so there's no existing PR ID to resolve yet.
  if (options.action === "create") {
    const pr = await pullRequests.create(options);
    console.log(`Created PR #${pr.pullRequestId}: ${pr.title}`);
    console.log(pullRequestWebUrl(ctx, pr.pullRequestId));
    return;
  }

  const prId = await pullRequests.resolveId(options.pr);

  switch (options.action) {
    case "list": {
      const commentThreads = await threads.list(prId, options);

      if (options.json) {
        console.log(JSON.stringify(commentThreads, null, 2));
        return;
      }
      if (commentThreads.length === 0) {
        console.log(`No matching comment threads on PR #${prId}.`);
        return;
      }
      console.log(`Comment threads on PR #${prId}:\n`);
      console.log(commentThreads.map((thread) => threads.format(thread, prId)).join("\n\n"));
      console.log("\n---\n\nSummary:\n");
      console.log(threads.formatSummary(commentThreads, prId));
      return;
    }
    case "comment": {
      const location = toCommentLocation(options);
      const thread = await threads.comment(prId, options.message!, location);
      console.log(`Posted new comment thread ${thread.id} on PR #${prId}.`);
      console.log(threads.webUrl(prId, thread.id));
      return;
    }
    case "reply": {
      await threads.reply(prId, options.thread!, options.message!);
      console.log(`Posted reply to thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "edit": {
      await threads.edit(prId, options.thread!, options.comment!, options.message!);
      console.log(`Edited comment ${options.comment} in thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "delete": {
      await threads.delete(prId, options.thread!, options.comment!);
      console.log(
        `Deleted comment ${options.comment} from thread ${options.thread} on PR #${prId}.`,
      );
      return;
    }
    case "resolve": {
      await threads.resolve(prId, options.thread!);
      console.log(`Marked thread ${options.thread} on PR #${prId} as resolved.`);
      return;
    }
    case "batch": {
      await batch.run(prId);
      return;
    }
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
