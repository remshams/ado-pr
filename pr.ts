/**
 * Creates, lists, inspects, and edits Azure DevOps pull requests, and manages their comment threads
 * from a git checkout whose origin remote points at Azure Repos.
 *
 * Auth: requires an AZURE_DEVOPS_PAT env var. Code (Read) is enough for PR/comment reads; Code
 * (Read & Write) is needed for PR/comment mutations. Build queries need Build (Read), also named
 * vso.build; build retries additionally need Build execute (vso.build_execute). Build commands cover
 * YAML/classic Build API validations only, never Releases, external checks, or individual retries.
 * Reviewer additions additionally need Identity (Read), while reviewer removal resolves the PR's
 * current reviewers using Code access only.
 * Run this via pr.sh, which accepts an exported PAT or loads one from .env.
 *
 * Images use a bidirectional placeholder contract: every upload needs a matching
 * {{image:<basename>}}, and every such placeholder needs an upload. Create/edit uploads replace
 * every exact match with marked image Markdown; edit removal strips only exact marked references.
 */
import { createAzureRequester, pullRequestWebUrl } from "./azure.ts";
import { createBatchRunner } from "./batch.ts";
import { createBuildService } from "./builds.ts";
import { getPat, parseArgs } from "./cli.ts";
import { createFileAnchorService } from "./file-anchors.ts";
import { getRepoContext } from "./lib.ts";
import { toCommentLocation } from "./operation-types.ts";
import { createPullRequestService } from "./pull-requests.ts";
import { createThreadService } from "./threads.ts";

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const pat = getPat();
  const ctx = await getRepoContext();

  const azure = createAzureRequester({ pat });
  const pullRequests = createPullRequestService({ azure, ctx });
  const fileAnchors = createFileAnchorService({ azure, ctx });
  const threads = createThreadService({ azure, ctx, fileAnchors });
  const batch = createBatchRunner({ threads });
  const builds = createBuildService({ azure, ctx, pullRequests });

  if (options.resource === "build") {
    switch (options.command) {
      case "list": {
        const result = await builds.list(options.pr, { history: options.history });
        console.log(options.json ? JSON.stringify(result, null, 2) : builds.formatList(result));
        return;
      }
      case "show": {
        const result = await builds.show(options.pr, options.build, {
          fullLogs: options.fullLogs,
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : builds.formatShow(result));
        if (builds.hasLogErrors(result)) process.exitCode = 1;
        return;
      }
      case "retry": {
        const result = await builds.retry(options.pr, options.build);
        console.log(builds.formatRetry(result));
        return;
      }
    }
    return assertNever(options);
  }

  if (options.resource === "pr") {
    switch (options.command) {
      case "list": {
        const prs = await pullRequests.list();
        if (options.json) {
          console.log(JSON.stringify(prs, null, 2));
          return;
        }
        if (prs.length === 0) {
          console.log("No active pull requests created by you in this repository.");
          return;
        }
        console.log("Active pull requests created by you:\n");
        console.log(prs.map((pr) => pullRequests.formatListItem(pr)).join("\n\n"));
        return;
      }
      case "create": {
        const pr = await pullRequests.create(options);
        console.log(`Created PR #${pr.pullRequestId}: ${pr.title}`);
        console.log(pullRequestWebUrl(ctx, pr.pullRequestId));
        return;
      }
      case "show": {
        const pr = await pullRequests.resolve(options.pr);
        console.log(options.json ? JSON.stringify(pr, null, 2) : pullRequests.format(pr));
        return;
      }
      case "edit": {
        const prId = await pullRequests.edit(options.pr, options);
        console.log(`Updated PR #${prId}.`);
        console.log(pullRequestWebUrl(ctx, prId));
        return;
      }
    }
  }

  const prId = await pullRequests.resolveId(options.pr);

  switch (options.command) {
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
    case "create": {
      const location = toCommentLocation(options);
      const thread = await threads.comment(prId, options.message, location);
      console.log(`Posted new comment thread ${thread.id} on PR #${prId}.`);
      console.log(threads.webUrl(prId, thread.id));
      return;
    }
    case "reply": {
      await threads.reply(prId, options.thread, options.message);
      console.log(`Posted reply to thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "edit": {
      await threads.edit(prId, options.thread, options.comment, options.message);
      console.log(`Edited comment ${options.comment} in thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "delete": {
      await threads.delete(prId, options.thread, options.comment);
      console.log(
        `Deleted comment ${options.comment} from thread ${options.thread} on PR #${prId}.`,
      );
      return;
    }
    case "resolve": {
      await threads.resolve(prId, options.thread);
      console.log(`Marked thread ${options.thread} on PR #${prId} as resolved.`);
      return;
    }
    case "batch": {
      await batch.run(prId);
      return;
    }
  }

  return assertNever(options);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
