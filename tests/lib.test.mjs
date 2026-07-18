import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import { getCurrentBranch, getRepoContext, parseAzureDevOpsRemote, runCommand } from "../lib.ts";
import { createTempGitRepo } from "./test-helpers.mjs";

const supportedRemotes = [
  {
    name: "dev.azure.com HTTPS",
    remote: "https://dev.azure.com/acme/Project/_git/widgets",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "dev.azure.com HTTPS with a credential prefix",
    remote: "https://acme@dev.azure.com/acme/Project/_git/widgets",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "Azure Repos SSH",
    remote: "git@ssh.dev.azure.com:v3/acme/Project/widgets",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "legacy visualstudio.com HTTPS",
    remote: "https://acme.visualstudio.com/Project/_git/widgets",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "legacy visualstudio.com HTTPS with DefaultCollection",
    remote: "https://acme.visualstudio.com/DefaultCollection/Project/_git/widgets",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "HTTPS with a .git suffix",
    remote: "https://dev.azure.com/acme/Project/_git/widgets.git",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "HTTPS with a trailing slash",
    remote: "https://dev.azure.com/acme/Project/_git/widgets/",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "legacy HTTPS with a .git suffix and trailing slash",
    remote: "https://acme.visualstudio.com/Project/_git/widgets.git/",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "SSH with a .git suffix",
    remote: "git@ssh.dev.azure.com:v3/acme/Project/widgets.git",
    expected: { organization: "acme", project: "Project", repository: "widgets" },
  },
  {
    name: "percent-encoded path components",
    remote: "https://dev.azure.com/acme%20org/Project%2FSpace/_git/widgets%20%2B%20tools",
    expected: {
      organization: "acme org",
      project: "Project/Space",
      repository: "widgets + tools",
    },
  },
];

for (const { name, remote, expected } of supportedRemotes) {
  test(`parseAzureDevOpsRemote parses ${name}`, () => {
    assert.deepEqual(parseAzureDevOpsRemote(remote), expected);
  });
}

const unsupportedRemotes = [
  "https://github.com/acme/widgets.git",
  "git@github.com:acme/widgets.git",
  "https://example.invalid/acme/Project/_git/widgets",
  "ssh://git@ssh.dev.azure.com/v3/acme/Project/widgets",
  "",
];

for (const remote of unsupportedRemotes) {
  test(`parseAzureDevOpsRemote rejects unsupported remote ${JSON.stringify(remote)}`, () => {
    assert.throws(() => parseAzureDevOpsRemote(remote), {
      message:
        `Could not parse an Azure DevOps organization/project/repository from remote URL: ` +
        `"${remote}"`,
    });
  });
}

async function withWorkingDirectory(path, callback) {
  const previousCwd = process.cwd();
  process.chdir(path);
  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

describe("Git repository integration", { concurrency: false }, () => {
  test("getRepoContext reads origin and getCurrentBranch reads the checked-out branch", async (t) => {
    const repo = createTempGitRepo(t, {
      origin: "https://dev.azure.com/acme/Test%20Project/_git/widgets.git",
      branch: "feature/lib-tests",
    });

    await withWorkingDirectory(repo, async () => {
      assert.deepEqual(await getRepoContext(), {
        organization: "acme",
        project: "Test Project",
        repository: "widgets",
      });
      assert.equal(await getCurrentBranch(), "feature/lib-tests");
    });
  });

  test("getRepoContext reports the current parser error when origin is missing", async (t) => {
    const repo = createTempGitRepo(t);

    await withWorkingDirectory(repo, async () => {
      await assert.rejects(getRepoContext(), {
        message:
          'Could not parse an Azure DevOps organization/project/repository from remote URL: ""',
      });
    });
  });

  test('getCurrentBranch reports "HEAD" for a detached checkout', async (t) => {
    const repo = createTempGitRepo(t, { branch: "main" });
    git(repo, "checkout", "--detach");

    await withWorkingDirectory(repo, async () => {
      assert.equal(await getCurrentBranch(), "HEAD");
    });
  });

  test("runCommand resolves the current non-zero Git result instead of rejecting", async (t) => {
    const repo = createTempGitRepo(t);

    await withWorkingDirectory(repo, async () => {
      assert.deepEqual(await runCommand("git", ["rev-parse", "--verify", "missing-ref"]), {
        code: 128,
        stdout: "",
      });
    });
  });
});
