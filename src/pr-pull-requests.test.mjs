import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runPr } from "../tests/test-helpers.mjs";
import {
	apiBase,
	assertSucceeded,
	createRepo,
	request,
	semanticRequest,
	validationPr,
	webBase,
} from "../tests/pr-cli-helpers.mjs";

test("pr attach uploads a file and prints its URL and Markdown link", (t) => {
	const cwd = createRepo(t);
	const path = join(cwd, "change.patch");
	writeFileSync(path, "patch bytes");
	const result = runPr(
		t,
		["pr", "attach", path, "--pr", "42", "--name", "change.txt"],
		{
			cwd,
			responses: [
				{
					json: {
						displayName: "change.txt",
						url: "https://files.test/change.txt",
					},
				},
			],
		},
	);
	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"Attachment URL: https://files.test/change.txt\nMarkdown: [change.txt](<https://files.test/change.txt>)\n",
	);
	assert.equal(result.calls[0].method, "POST");
});

test("pr attach reports Azure's rejection body and suggests --name", (t) => {
	const cwd = createRepo(t);
	const path = join(cwd, "change.patch");
	writeFileSync(path, "patch bytes");
	const result = runPr(t, ["pr", "attach", path, "--pr", "42"], {
		cwd,
		responses: [
			{
				status: 400,
				statusText: "Bad Request",
				body: '{"message":"Unsupported file type"}',
			},
		],
	});
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/400 Bad Request[\s\S]*Unsupported file type[\s\S]*--name "attachment.txt"/,
	);
});

const completeHead = "2222222222222222222222222222222222222222";

const pushedHead = "4444444444444444444444444444444444444444";

const completeUrl = `${apiBase}/pullRequests/42?api-version=7.1`;

const statusHint =
	"Run `pr.sh pr status --pr 42` to see blocking policies, merge conflicts and the current head.";

function completablePr(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Add widgets",
		status: "active",
		sourceRefName: "refs/heads/feature/dispatch",
		lastMergeSourceCommit: { commitId: completeHead },
		mergeStatus: "succeeded",
		...overrides,
	};
}

// Azure error bodies carry the reason in `message`; statuses and wording are not verified.

function azureRejection(status, statusText, message) {
	return {
		status,
		statusText,
		json: { $id: "1", innerException: null, message, errorCode: 0 },
	};
}

// The server accepts only the head it has now and rejects any other head with 409.

function serverAtHead(serverHead) {
	return {
		whenBodyIncludes: `"lastMergeSourceCommit":{"commitId":"${serverHead}"}`,
		matched: { json: completablePr({ status: "completed" }) },
		otherwise: azureRejection(
			409,
			"Conflict",
			"TF401192: The source branch has been updated since the pull request was last merged.",
		),
	};
}

test("pr complete completes the branch PR at the head it just read", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "complete", "--merge-strategy", "squash"], {
		cwd,
		responses: [
			{ json: { count: 1, value: [completablePr()] } },
			{ json: completablePr() },
			{ json: completablePr({ status: "completed", mergeStatus: "queued" }) },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.slice(1).map(semanticRequest), [
		{ url: completeUrl, method: "GET", body: null },
		{
			url: completeUrl,
			method: "PATCH",
			body: {
				status: "completed",
				lastMergeSourceCommit: { commitId: completeHead },
				completionOptions: { mergeStrategy: "squash" },
			},
		},
	]);
	assert.equal(
		result.stdout,
		[
			"Requested completion of PR #42: Add widgets",
			`Head commit: ${completeHead}`,
			"Azure DevOps is still merging (merge status: queued). Run `pr.sh pr status --pr 42` to check the result.",
			"Options: merge strategy squash",
			`${webBase}/42`,
			"",
		].join("\n"),
	);
});

test("pr complete keeps earlier completion options and overlays the flags given", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"complete",
			"--pr",
			"42",
			"--merge-strategy",
			"rebase-merge",
			"--delete-source-branch",
		],
		{
			cwd,
			responses: [
				{
					json: completablePr({
						completionOptions: {
							transitionWorkItems: true,
							mergeStrategy: "squash",
						},
					}),
				},
				serverAtHead(completeHead),
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(semanticRequest(result.calls[1]).body, {
		status: "completed",
		lastMergeSourceCommit: { commitId: completeHead },
		completionOptions: {
			transitionWorkItems: true,
			mergeStrategy: "rebaseMerge",
			deleteSourceBranch: true,
		},
	});
	assert.equal(
		result.stdout,
		[
			"Completed PR #42: Add widgets",
			`Head commit: ${completeHead}`,
			"Options: merge strategy rebase-merge, delete source branch",
			`${webBase}/42`,
			"",
		].join("\n"),
	);
});

test("pr complete --auto sets auto-complete for the authenticated user", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "complete", "--pr", "42", "--auto", "--merge-strategy", "squash"],
		{
			cwd,
			responses: [
				{ json: completablePr() },
				{ json: { authenticatedUser: { id: "user-1" } } },
				{ json: completablePr({ autoCompleteSetBy: { id: "user-1" } }) },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{ url: completeUrl, method: "GET", body: null },
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
		{
			url: completeUrl,
			method: "PATCH",
			body: {
				autoCompleteSetBy: { id: "user-1" },
				completionOptions: { mergeStrategy: "squash" },
			},
		},
	]);
	assert.equal(
		result.stdout,
		[
			"Set auto-complete on PR #42: Add widgets",
			"Azure DevOps completes it once the required policies pass, at whatever head passes them, including later pushes.",
			"Options: merge strategy squash",
			`${webBase}/42`,
			"",
		].join("\n"),
	);
});

test("pr complete reports Azure's rejection of a changed head", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "complete", "--pr", "42", "--merge-strategy", "merge"],
		{
			cwd,
			responses: [{ json: completablePr() }, serverAtHead(pushedHead)],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.deepEqual(semanticRequest(result.calls[1]).body, {
		status: "completed",
		lastMergeSourceCommit: { commitId: completeHead },
		completionOptions: { mergeStrategy: "noFastForward" },
	});
	assert.equal(
		result.stderr,
		[
			"Azure DevOps rejected completing PR #42 (HTTP 409): TF401192: The source branch has been updated since the pull request was last merged.",
			`Sent head commit ${completeHead}. If the source branch has moved since, review the new commits before completing again.`,
			statusHint,
			"",
		].join("\n"),
	);
});

test("pr complete reports a policy rejection with the pr status hint", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "complete", "--pr", "42", "--merge-strategy", "squash"],
		{
			cwd,
			responses: [
				{ json: completablePr() },
				azureRejection(
					409,
					"Conflict",
					"The pull request cannot be completed because required policies are not satisfied.",
				),
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		[
			"Azure DevOps rejected completing PR #42 (HTTP 409): The pull request cannot be completed because required policies are not satisfied.",
			`Sent head commit ${completeHead}. If the source branch has moved since, review the new commits before completing again.`,
			statusHint,
			"",
		].join("\n"),
	);
});

test("pr complete exits 1 when the merge fails after the request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "complete", "--pr", "42", "--merge-strategy", "squash"],
		{
			cwd,
			responses: [
				{ json: completablePr() },
				{
					json: completablePr({
						mergeStatus: "conflicts",
						mergeFailureMessage: "Merge conflicts in src/widgets.ts.",
					}),
				},
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		`Azure DevOps could not merge PR #42 (merge status: conflicts): Merge conflicts in src/widgets.ts.\n${statusHint}\n`,
	);
});

test("pr complete requires a merge strategy before any Azure request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "complete", "--pr", "42", "--auto"], {
		cwd,
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^Error: --merge-strategy is required for "pr complete"\n/,
	);
	assert.deepEqual(result.calls, []);
});

test("pr list requests the current identity then prints active pull requests in response order", (t) => {
	const cwd = createRepo(t);
	const pullRequests = [
		{
			pullRequestId: 91,
			title: "Draft API cleanup",
			status: "active",
			isDraft: true,
			sourceRefName: "refs/heads/feature/api-cleanup",
			targetRefName: "refs/heads/main",
			reviewers: [
				{ id: "reviewer-1", displayName: "Ada Reviewer", vote: 10 },
				{ id: "reviewer-2", displayName: "Lin Reviewer", vote: -5 },
			],
		},
		{
			pullRequestId: 12,
			title: "Release fix",
			status: "active",
			isDraft: false,
			sourceRefName: "refs/heads/fix/release",
			targetRefName: "refs/heads/release/2026",
		},
	];
	const result = runPr(t, ["pr", "list"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "creator/id +?#" } } },
			{ json: { count: pullRequests.length, value: pullRequests } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.creatorId=creator%2Fid%20%2B%3F%23&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"Active pull requests created by you:\n\n" +
			"- PR #91: Draft API cleanup [draft]\n" +
			"  feature/api-cleanup -> main\n" +
			"  Reviewers: Ada Reviewer: approved, Lin Reviewer: waiting for author\n" +
			`  ${webBase}/91\n\n` +
			"- PR #12: Release fix\n" +
			"  fix/release -> release/2026\n" +
			`  ${webBase}/12\n`,
	);
});

test("pr list sends reviewer, all, and target search criteria", (t) => {
	const cases = [
		{
			args: ["--reviewing"],
			identity: true,
			criteria:
				"searchCriteria.reviewerId=me&searchCriteria.status=active&api-version=7.1",
		},
		{
			args: ["--reviewing", "--target", "release/2026"],
			identity: true,
			criteria:
				"searchCriteria.reviewerId=me&searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Frelease%2F2026&api-version=7.1",
		},
		{
			args: ["--all"],
			identity: false,
			criteria: "searchCriteria.status=active&api-version=7.1",
		},
		{
			args: ["--all", "--target", "main"],
			identity: false,
			criteria:
				"searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Fmain&api-version=7.1",
		},
		{
			args: ["--target", "main"],
			identity: true,
			criteria:
				"searchCriteria.creatorId=me&searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Fmain&api-version=7.1",
		},
	];
	for (const { args, identity, criteria } of cases) {
		const cwd = createRepo(t);
		const result = runPr(t, ["pr", "list", ...args, "--json"], {
			cwd,
			responses: [
				...(identity ? [{ json: { authenticatedUser: { id: "me" } } }] : []),
				{ json: { value: [] } },
			],
		});
		assertSucceeded(result);
		assert.equal(
			result.calls.at(-1).url,
			`${apiBase}/pullrequests?${criteria}`,
		);
	}
});

test("pr list rejects --reviewing with --all", (t) => {
	const result = runPr(t, ["pr", "list", "--reviewing", "--all"], {
		cwd: createRepo(t),
		responses: [],
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--reviewing and --all are mutually exclusive/);
	assert.equal(result.calls.length, 0);
});

test("pr list --json prints the collection value as a pretty JSON array", (t) => {
	const cwd = createRepo(t);
	const pullRequests = [
		{
			pullRequestId: 44,
			title: "Raw collection entry",
			sourceRefName: "refs/heads/feature/raw",
			targetRefName: "refs/heads/main",
			repository: { id: "repository-metadata-is-preserved" },
		},
	];
	const result = runPr(t, ["pr", "list", "--json"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { value: pullRequests } },
		],
	});

	assertSucceeded(result);
	assert.equal(result.stdout, `${JSON.stringify(pullRequests, null, 2)}\n`);
	assert.equal(result.calls.length, 2);
	assert.match(result.calls[1].url, /searchCriteria\.creatorId=me/);
});

test("pr list reports an empty active collection as a successful result", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "list"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { count: 0, value: [] } },
		],
	});

	assertSucceeded(result);
	assert.equal(result.calls.length, 2);
	assert.equal(
		result.stdout,
		"No active pull requests created by you in this repository.\n",
	);
});

test("create dispatches directly without resolving an existing pull request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Dispatch coverage",
			"--description",
			"Regression test",
			"--source",
			"feature/source",
			"--target",
			"main",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 101,
						title: "Dispatch coverage",
						sourceRefName: "refs/heads/feature/source",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullrequests?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				sourceRefName: "refs/heads/feature/source",
				targetRefName: "refs/heads/main",
				title: "Dispatch coverage",
				description: "Regression test",
				isDraft: true,
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Created PR #101: Dispatch coverage\n${webBase}/101\n`,
	);
});

test("create resolves reviewers, uploads binary images, and patches every matching placeholder", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "flow[1].png"), Buffer.from([0, 255, 16, 32]));
	const placeholderDescription =
		"Flow {{image:flow[1].png}} and repeated {{image:flow[1].png}}";
	const attachmentUrl = "https://attachments.test/flow(1).png?token=x";
	const finalDescription =
		`Flow ![flow\\[1\\].png](<${attachmentUrl}>)<!-- ado-pr-image:flow%5B1%5D.png --> and repeated ` +
		`![flow\\[1\\].png](<${attachmentUrl}>)<!-- ado-pr-image:flow%5B1%5D.png -->`;
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Illustrated flow",
			"--description",
			placeholderDescription,
			"--source",
			"feature/dispatch",
			"--target",
			"main",
			"--image",
			"flow[1].png",
			"--reviewer",
			"Ada Lovelace",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: "reviewer/id",
								providerDisplayName: "ADA LOVELACE",
								isActive: true,
							},
						],
					},
				},
				{
					json: {
						pullRequestId: 102,
						title: "Illustrated flow",
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
				{ json: { value: [] } },
				{ json: { displayName: "flow[1].png", url: attachmentUrl } },
				{
					json: {
						pullRequestId: 102,
						title: "Illustrated flow",
						description: finalDescription,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				"https://vssps.dev.azure.com/acme/_apis/identities?" +
				"searchFilter=General&filterValue=Ada%20Lovelace&queryMembership=None&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullrequests?api-version=7.1`,
			method: "POST",
			body: {
				sourceRefName: "refs/heads/feature/dispatch",
				targetRefName: "refs/heads/main",
				title: "Illustrated flow",
				description: placeholderDescription,
				isDraft: false,
				reviewers: [{ id: "reviewer/id" }],
			},
		},
		{
			url: `${apiBase}/pullRequests/102/attachments?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/102/attachments/flow%5B1%5D.png?api-version=7.1`,
			method: "POST",
			body: { encoding: "base64", data: "AP8QIA==" },
		},
		{
			url: `${apiBase}/pullRequests/102?api-version=7.1`,
			method: "PATCH",
			body: { description: finalDescription },
		},
	]);
	assert.equal(
		result.stdout,
		`Created PR #102: Illustrated flow\n${webBase}/102\n`,
	);
});

test("create rejects an image placeholder mismatch before creating a pull request", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "flow.png"), Buffer.from([1, 2, 3]));
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Mismatch",
			"--description",
			"{{image:other.png}}",
			"--source",
			"feature/dispatch",
			"--target",
			"main",
			"--image",
			"flow.png",
		],
		{ cwd },
	);

	assert.equal(result.status, 1);
	assert.deepEqual(result.calls, []);
	assert.equal(
		result.stderr,
		"Image placeholder mismatch: missing {{image:flow.png}} for --image flow.png; " +
			"no --image was supplied for {{image:other.png}}.\n",
	);
});

test("show fetches an explicit PR and prints human-readable details", (t) => {
	const cwd = createRepo(t);
	const pr = {
		pullRequestId: 42,
		title: "Account validation",
		description: "Validate accounts before saving.",
		status: "active",
		isDraft: true,
		sourceRefName: "refs/heads/feature/account-validation",
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--pr", "42"], {
		cwd,
		responses: [{ json: pr }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"PR #42: Account validation\n" +
			"Status: active\n" +
			"Draft: yes\n" +
			"Source: feature/account-validation\n" +
			"Target: main\n" +
			`URL: ${webBase}/42\n` +
			"Description:\n" +
			"Validate accounts before saving.\n",
	);
});

test("show prints an explicit PR as JSON", (t) => {
	const cwd = createRepo(t);
	const pr = {
		pullRequestId: 42,
		title: "JSON details",
		description: "Machine readable",
		status: "active",
		isDraft: false,
		sourceRefName: "refs/heads/feature/json",
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--pr", "42", "--json"], {
		cwd,
		responses: [{ json: pr }],
	});

	assertSucceeded(result);
	assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("show hydrates the active PR found for the current branch", (t) => {
	const cwd = createRepo(t, "feature/branch-details");
	const candidate = {
		pullRequestId: 73,
		title: "Branch details",
		description: "Truncated collection description",
		sourceRefName: "refs/heads/feature/branch-details",
	};
	const pr = {
		...candidate,
		description: "Found from the current branch with the full description.",
		status: "active",
		isDraft: false,
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--json"], {
		cwd,
		responses: [{ json: { value: [candidate] } }, { json: pr }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fbranch-details&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("pr edit replaces the description for an explicit PR without fetching it first", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			"Updated from the command line",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 42,
						title: "Updated PR",
						description: "Updated from the command line",
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: "Updated from the command line" },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit marks an explicit PR as draft without fetching it first", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "edit", "--pr", "42", "--draft"], {
		cwd,
		responses: [
			{
				json: {
					pullRequestId: 42,
					title: "Draft PR",
					isDraft: true,
					sourceRefName: "refs/heads/feature/dispatch",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { isDraft: true },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit clears draft state with --no-draft", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "edit", "--pr", "42", "--no-draft"], {
		cwd,
		responses: [
			{
				json: {
					pullRequestId: 42,
					title: "Ready PR",
					isDraft: false,
					sourceRefName: "refs/heads/feature/dispatch",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { isDraft: false },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit combines description and draft changes in one request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			"Work in progress",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 42,
						title: "Combined update",
						description: "Work in progress",
						isDraft: true,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: "Work in progress", isDraft: true },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit retargets a pull request before changing its draft state", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "edit", "--pr", "42", "--target", "main", "--no-draft"],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 42,
						title: "Retargeted PR",
						sourceRefName: "refs/heads/feature/dispatch",
						targetRefName: "refs/heads/main",
					},
				},
				{
					json: {
						pullRequestId: 42,
						title: "Retargeted PR",
						isDraft: false,
						sourceRefName: "refs/heads/feature/dispatch",
						targetRefName: "refs/heads/main",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { targetRefName: "refs/heads/main" },
		},
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { isDraft: false },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit preflights and applies image and reviewer additions and removals in safe order", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "new.png"), Buffer.from("new-image-bytes"));
	const oldUrl = "https://attachments.test/old.png?token=exact";
	const newUrl = "https://attachments.test/new.png?token=new";
	const replacement =
		`New {{image:new.png}}\nOld ![old.png](<${oldUrl}>)` +
		"<!-- ado-pr-image:old.png -->";
	const finalDescription = `New ![new.png](<${newUrl}>)<!-- ado-pr-image:new.png -->\nOld `;
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			replacement,
			"--image",
			"new.png",
			"--remove-image",
			"old.png",
			"--reviewer",
			"New Reviewer",
			"--remove-reviewer",
			"old@example.test",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: "new/id",
								providerDisplayName: "New Reviewer",
								isActive: true,
							},
						],
					},
				},
				{
					json: {
						value: [
							{
								id: "old/id",
								displayName: "Old Reviewer",
								uniqueName: "OLD@EXAMPLE.TEST",
								inactive: true,
								vote: 10,
							},
						],
					},
				},
				{ json: { value: [{ displayName: "old.png", url: oldUrl }] } },
				{ json: { displayName: "new.png", url: newUrl } },
				{
					json: {
						pullRequestId: 42,
						title: "Updated assets",
						description: finalDescription,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
				{ status: 204 },
				{ body: "" },
				{ status: 204 },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				"https://vssps.dev.azure.com/acme/_apis/identities?" +
				"searchFilter=General&filterValue=New%20Reviewer&queryMembership=None&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/attachments?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/attachments/new.png?api-version=7.1`,
			method: "POST",
			body: {
				encoding: "base64",
				data: Buffer.from("new-image-bytes").toString("base64"),
			},
		},
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: finalDescription, isDraft: true },
		},
		{
			url: `${apiBase}/pullRequests/42/attachments/old.png?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers/new%2Fid?api-version=7.1`,
			method: "PUT",
			body: { id: "new/id", vote: 0 },
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers/old%2Fid?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit resolves the branch PR and can clear its description", (t) => {
	const cwd = createRepo(t, "feature/clear-description");
	const result = runPr(t, ["pr", "edit", "--description", ""], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							pullRequestId: 73,
							title: "Clear description",
							sourceRefName: "refs/heads/feature/clear-description",
						},
					],
				},
			},
			{
				json: {
					pullRequestId: 73,
					title: "Clear description",
					description: "",
					sourceRefName: "refs/heads/feature/clear-description",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fclear-description&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73?api-version=7.1`,
			method: "PATCH",
			body: { description: "" },
		},
	]);
	assert.equal(result.stdout, `Updated PR #73.\n${webBase}/73\n`);
});

function diffIterations(count) {
	return {
		json: {
			count,
			value: Array.from({ length: count }, (_, index) => ({
				id: index + 1,
				sourceRefCommit: { commitId: `source-${index + 1}` },
				commonRefCommit: { commitId: `common-${index + 1}` },
				createdDate: `2026-10-0${index + 1}T12:00:00Z`,
			})),
		},
	};
}

function diffChange(changeType, path, extra = {}) {
	return {
		changeId: 1,
		changeTrackingId: 1,
		changeType,
		item: { path },
		...extra,
	};
}

function diffItem(content, isBinary = false) {
	return {
		json: { gitObjectType: "blob", content, contentMetadata: { isBinary } },
	};
}

function diffItemUrl(path, commit) {
	return `${apiBase}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json&api-version=7.1`;
}

test("pr diff prints modified, added, deleted, renamed and binary files", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42"], {
		cwd,
		responses: [
			diffIterations(2),
			{
				json: {
					changeEntries: [
						diffChange("edit", "/src/app.ts"),
						diffChange("add", "/docs/new.md"),
						diffChange("delete", null, { originalPath: "/old.txt" }),
						diffChange("edit, rename", "/src/renamed.ts", {
							originalPath: "/src/original.ts",
						}),
						diffChange("edit", "/logo.png"),
					],
				},
			},
			diffItem("a\nb\nc\n"),
			diffItem("a\nB\nc\n"),
			{
				json: {
					count: 1,
					value: [
						{
							path: "/src/app.ts",
							lineDiffBlocks: [
								{
									changeType: "edit",
									originalLineNumberStart: 2,
									originalLinesCount: 1,
									modifiedLineNumberStart: 2,
									modifiedLinesCount: 1,
								},
							],
						},
					],
				},
			},
			diffItem("# New\n"),
			diffItem("gone\n"),
			diffItem("x\n"),
			diffItem("x\ny\n"),
			{
				json: {
					count: 1,
					value: [
						{
							path: "/src/renamed.ts",
							originalPath: "/src/original.ts",
							lineDiffBlocks: [
								{
									changeType: "add",
									originalLineNumberStart: 2,
									originalLinesCount: 0,
									modifiedLineNumberStart: 2,
									modifiedLinesCount: 1,
								},
							],
						},
					],
				},
			},
			diffItem("PNG", true),
			diffItem("PNG", true),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		[
			"PR #42: iteration 2 compared with the merge base.",
			"diff --git a/src/app.ts b/src/app.ts",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
			"diff --git a/docs/new.md b/docs/new.md",
			"--- /dev/null",
			"+++ b/docs/new.md",
			"@@ -0,0 +1,1 @@",
			"+# New",
			"diff --git a/old.txt b/old.txt",
			"--- a/old.txt",
			"+++ /dev/null",
			"@@ -1,1 +0,0 @@",
			"-gone",
			"diff --git a/src/original.ts b/src/renamed.ts",
			"rename from src/original.ts",
			"rename to src/renamed.ts",
			"--- a/src/original.ts",
			"+++ b/src/renamed.ts",
			"@@ -1,1 +1,2 @@",
			" x",
			"+y",
			"diff --git a/logo.png b/logo.png",
			"Binary files a/logo.png and b/logo.png differ",
			"",
		].join("\n"),
	);
	assert.deepEqual(
		result.calls.map((call) => `${call.method} ${call.url}`),
		[
			`GET ${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			`GET ${apiBase}/pullRequests/42/iterations/2/changes?$top=2000&api-version=7.1`,
			`GET ${diffItemUrl("/src/app.ts", "common-2")}`,
			`GET ${diffItemUrl("/src/app.ts", "source-2")}`,
			`POST ${apiBase}/filediffs?api-version=7.1-preview.1`,
			`GET ${diffItemUrl("/docs/new.md", "source-2")}`,
			`GET ${diffItemUrl("/old.txt", "common-2")}`,
			`GET ${diffItemUrl("/src/original.ts", "common-2")}`,
			`GET ${diffItemUrl("/src/renamed.ts", "source-2")}`,
			`POST ${apiBase}/filediffs?api-version=7.1-preview.1`,
			`GET ${diffItemUrl("/logo.png", "common-2")}`,
			`GET ${diffItemUrl("/logo.png", "source-2")}`,
		],
	);
	assert.deepEqual(semanticRequest(result.calls[9]).body, {
		baseVersionCommit: "common-2",
		targetVersionCommit: "source-2",
		fileDiffParams: [
			{ path: "/src/renamed.ts", originalPath: "/src/original.ts" },
		],
	});
});

test("pr diff --since-iteration compares the current branch's PR with an earlier iteration", (t) => {
	const cwd = createRepo(t, "feature/diff");
	const result = runPr(t, ["pr", "diff", "--since-iteration", "2"], {
		cwd,
		responses: [
			{ json: { value: [validationPr({ pullRequestId: 73 })] } },
			diffIterations(3),
			{ json: { changeEntries: [diffChange("add", "/later.txt")] } },
			diffItem("later\n"),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"PR #73: iteration 3 compared with iteration 2.\ndiff --git a/later.txt b/later.txt\n--- /dev/null\n+++ b/later.txt\n@@ -0,0 +1,1 @@\n+later\n",
	);
	assert.deepEqual(
		result.calls.slice(1).map((call) => call.url),
		[
			`${apiBase}/pullRequests/73/iterations?api-version=7.1`,
			`${apiBase}/pullRequests/73/iterations/3/changes?$top=2000&$compareTo=2&api-version=7.1`,
			diffItemUrl("/later.txt", "source-3"),
		],
	);
});

test("pr diff stops at the output limit with a truncation notice", (t) => {
	const cwd = createRepo(t);
	const fileText = `${"x".repeat(99)}\n`.repeat(550);
	const result = runPr(t, ["pr", "diff", "--pr", "42"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("add", "/one.txt"),
						diffChange("add", "/two.txt"),
						diffChange("add", "/three.txt"),
					],
				},
			},
			diffItem(fileText),
			diffItem(fileText),
		],
	});

	assertSucceeded(result);
	assert.match(
		result.stdout,
		/\n\+x+\nDiff truncated at the 100,000-byte limit in file 2 of 3 \(two\.txt\)\.\n$/,
	);
	const heading = "PR #42: iteration 1 compared with the merge base.\n";
	const notice = result.stdout.slice(
		result.stdout.lastIndexOf("Diff truncated"),
	);
	assert.ok(
		Buffer.byteLength(result.stdout) - heading.length - notice.length <=
			100_000,
	);
	assert.equal(result.calls.length, 4);
});

test("pr diff rejects an iteration the PR does not have", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--since-iteration", "5"],
		{
			cwd,
			responses: [diffIterations(2)],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"PR #42 has no iteration 5; the latest iteration is 2.\n",
	);
});

const connectionDataUrl =
	"https://dev.azure.com/acme/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1";

test("pr diff --since-last-review compares with the iteration before the user's last vote", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--since-last-review"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{
				json: {
					value: [
						{
							id: 1,
							comments: [
								{
									id: 1,
									author: { id: "me" },
									commentType: "text",
									content: "Please rename",
									publishedDate: "2026-10-01T15:00:00Z",
								},
							],
						},
						{
							id: 2,
							properties: {
								CodeReviewThreadType: {
									$type: "System.String",
									$value: "VoteUpdate",
								},
								CodeReviewVotedByIdentity: {
									$type: "System.String",
									$value: "1",
								},
							},
							identities: { 1: { id: "me", displayName: "Ada" } },
							comments: [
								{
									id: 1,
									author: { id: "azure-service" },
									commentType: "system",
									content: "Ada voted 10",
									publishedDate: "2026-10-02T15:00:00Z",
								},
							],
						},
					],
				},
			},
			diffIterations(3),
			{ json: { changeEntries: [diffChange("add", "/later.txt")] } },
			diffItem("later\n"),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"PR #42: iteration 3 compared with iteration 2, the latest before your last review on 2026-10-02T15:00:00.000Z.\ndiff --git a/later.txt b/later.txt\n--- /dev/null\n+++ b/later.txt\n@@ -0,0 +1,1 @@\n+later\n",
	);
	assert.deepEqual(
		result.calls.map((call) => call.url),
		[
			connectionDataUrl,
			`${apiBase}/pullRequests/42/threads?api-version=7.1`,
			`${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			`${apiBase}/pullRequests/42/iterations/3/changes?$top=2000&$compareTo=2&api-version=7.1`,
			diffItemUrl("/later.txt", "source-3"),
		],
	);
});

test("pr diff --since-last-review fails without activity by the user", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--since-last-review"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { value: [] } },
			diffIterations(2),
		],
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"Found no comment or vote by you on PR #42. Use --since-iteration <n> instead.\n",
	);
});

test("pr diff --since-last-review rejects --since-iteration before any request", (t) => {
	const result = runPr(
		t,
		["pr", "diff", "--since-last-review", "--since-iteration", "1"],
		{ cwd: createRepo(t), responses: [] },
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^Error: --since-iteration and --since-last-review are mutually exclusive for "pr diff"\n/,
	);
	assert.equal(result.calls.length, 0);
});

test("pr diff --name-only prints only path lines and reads no content", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--name-only"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("edit", "/src/app.ts"),
						diffChange("edit, rename", "/src/renamed.ts", {
							originalPath: "/src/original.ts",
						}),
						diffChange("delete", null, { originalPath: "/old.txt" }),
					],
				},
			},
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"edit\tsrc/app.ts\nrename\tsrc/original.ts -> src/renamed.ts\ndelete\told.txt\n",
	);
	assert.equal(result.calls.length, 2);
});

test("pr diff --json prints files, change types and line blocks", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--since-iteration", "1", "--json"],
		{
			cwd,
			responses: [
				diffIterations(2),
				{
					json: {
						changeEntries: [
							diffChange("edit", "/src/app.ts"),
							diffChange("add", "/logo.png"),
						],
					},
				},
				diffItem("a\nb\nc\n"),
				diffItem("a\nB\nc\n"),
				{
					json: {
						count: 1,
						value: [
							{
								path: "/src/app.ts",
								lineDiffBlocks: [
									{
										changeType: "edit",
										originalLineNumberStart: 2,
										originalLinesCount: 1,
										modifiedLineNumberStart: 2,
										modifiedLinesCount: 1,
									},
								],
							},
						],
					},
				},
				diffItem("PNG", true),
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(JSON.parse(result.stdout), {
		pullRequestId: 42,
		iteration: 2,
		baseIteration: 1,
		lastReview: null,
		files: [
			{
				path: "src/app.ts",
				originalPath: "src/app.ts",
				change: "edit",
				content: "text",
				blocks: [
					{
						originalStart: 2,
						originalCount: 1,
						modifiedStart: 2,
						modifiedCount: 1,
						removed: ["b"],
						added: ["B"],
					},
				],
			},
			{
				path: "logo.png",
				originalPath: "logo.png",
				change: "add",
				content: "binary",
				blocks: [],
			},
		],
		truncated: false,
	});
});

test("pr diff --json keeps the printed output within 100,000 bytes", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--json"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("add", "/huge.txt"),
						diffChange("add", "/half.txt"),
						diffChange("add", "/small.txt"),
					],
				},
			},
			// One-character lines take about 15 bytes each in the printed JSON.
			diffItem("x\n".repeat(8000)),
			diffItem("y\n".repeat(4000)),
			diffItem("small\n"),
		],
	});

	assertSucceeded(result);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(
		output.files.map((file) => [file.path, file.content]),
		[
			["huge.txt", "omitted"],
			["half.txt", "text"],
			["small.txt", "text"],
		],
	);
	assert.equal(output.truncated, true);
	assert.ok(Buffer.byteLength(result.stdout) <= 100_000);
	assert.ok(Buffer.byteLength(result.stdout) > 60_000);
});

test("pr diff --json --name-only prints only paths and change types", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--name-only", "--json"],
		{
			cwd,
			responses: [
				diffIterations(1),
				{ json: { changeEntries: [diffChange("add", "/new\u202e.txt")] } },
			],
		},
	);

	assertSucceeded(result);
	assert.match(result.stdout, /"path": "new\\u202e\.txt"/);
	assert.deepEqual(JSON.parse(result.stdout), {
		pullRequestId: 42,
		iteration: 1,
		baseIteration: null,
		lastReview: null,
		files: [
			{ path: "new\u202e.txt", originalPath: "new\u202e.txt", change: "add" },
		],
		truncated: false,
	});
	assert.equal(result.calls.length, 2);
});

test("pr vote puts the vote for the authenticated user and names it", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "vote", "--vote", "approve-with-suggestions", "--pr", "42"],
		{
			cwd,
			responses: [
				{ json: { authenticatedUser: { id: "user-1" } } },
				{ json: { id: "user-1", vote: 5 } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers/user-1?api-version=7.1`,
			method: "PUT",
			body: { vote: 5 },
		},
	]);
	assert.equal(
		result.stdout,
		"Set your vote on PR #42 to approve-with-suggestions.\n",
	);
});

test("pr vote sends each vote value and defaults to the branch's active PR", (t) => {
	const cases = [
		["approve", 10],
		["wait", -5],
		["reject", -10],
		["reset", 0],
	];
	for (const [vote, value] of cases) {
		const cwd = createRepo(t);
		const result = runPr(t, ["pr", "vote", "--vote", vote], {
			cwd,
			responses: [
				{ json: { value: [{ pullRequestId: 7, title: "Branch PR" }] } },
				{ json: { authenticatedUser: { id: "user-1" } } },
				{ json: {} },
			],
		});

		assertSucceeded(result);
		assert.deepEqual(semanticRequest(result.calls[2]), {
			url: `${apiBase}/pullRequests/7/reviewers/user-1?api-version=7.1`,
			method: "PUT",
			body: { vote: value },
		});
		assert.equal(result.stdout, `Set your vote on PR #7 to ${vote}.\n`);
	}
});

test("pr vote rejects a missing or unknown vote before any Azure request", (t) => {
	const cwd = createRepo(t);
	for (const [args, error] of [
		[["pr", "vote"], '--vote is required for "pr vote"'],
		[
			["pr", "vote", "--vote", "maybe"],
			'invalid --vote "maybe" (must be one of: approve, approve-with-suggestions, wait, reject, reset)',
		],
	]) {
		const result = runPr(t, args, { cwd, responses: [] });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.startsWith(`Error: ${error}\n`), result.stderr);
		assert.deepEqual(result.calls, []);
	}
});

test("pr abandon patches the status of an explicit PR", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "abandon", "--pr", "42"], {
		cwd,
		responses: [{ json: { pullRequestId: 42, status: "abandoned" } }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { status: "abandoned" },
		},
	]);
	assert.equal(result.stdout, "Abandoned PR #42.\n");
});

test("pr abandon resolves the branch's active PR", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "abandon"], {
		cwd,
		responses: [
			{ json: { value: [{ pullRequestId: 7, title: "Branch PR" }] } },
			{ json: { pullRequestId: 7, status: "abandoned" } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(semanticRequest(result.calls[1]), {
		url: `${apiBase}/pullRequests/7?api-version=7.1`,
		method: "PATCH",
		body: { status: "abandoned" },
	});
	assert.equal(result.stdout, "Abandoned PR #7.\n");
});

test("pr reactivate patches an abandoned PR back to active", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "reactivate", "--pr", "42"], {
		cwd,
		responses: [{ json: { pullRequestId: 42, status: "active" } }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { status: "active" },
		},
	]);
	assert.equal(result.stdout, "Reactivated PR #42.\n");
});

test("pr reactivate requires --pr before any Azure request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "reactivate"], { cwd, responses: [] });

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.ok(
		result.stderr.startsWith(
			'Error: --pr is required for "pr reactivate" (abandoned pull requests are not found from the current branch)\n',
		),
		result.stderr,
	);
	assert.deepEqual(result.calls, []);
});

test("pr abandon and reactivate report Azure's status and message", (t) => {
	const cwd = createRepo(t);
	for (const [command, message] of [
		["reactivate", "Pull request 42 is completed and cannot be reactivated."],
		["abandon", "Pull request 42 is already abandoned."],
	]) {
		const result = runPr(t, ["pr", command, "--pr", "42"], {
			cwd,
			responses: [{ status: 400, statusText: "Bad Request", body: message }],
		});

		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(
			result.stderr,
			`Azure DevOps API request (PATCH ${apiBase}/pullRequests/42?api-version=7.1) failed: 400 Bad Request\n${message}\n`,
		);
	}
});
