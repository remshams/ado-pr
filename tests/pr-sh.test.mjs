import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnTestProcess } from "./test-helpers.mjs";

const sourceLauncher = fileURLToPath(new URL("../pr.sh", import.meta.url));
const launcherTest = process.platform === "win32" ? test.skip : test;

function createFixture(t, envContents) {
	const path = mkdtempSync(join(tmpdir(), "ado-pr-launcher-test-"));
	const launcherPath = join(path, "pr.sh");
	const prPath = join(path, "src", "pr.ts");
	const capturePath = join(path, "capture.json");
	const envPath = join(path, ".env");
	const shellMarkerPath = join(path, "shell-code-ran");
	const binPath = join(path, "bin");

	t.after(() => rmSync(path, { recursive: true, force: true }));
	copyFileSync(sourceLauncher, launcherPath);
	mkdirSync(join(path, "src"));
	writeFileSync(
		prPath,
		`require("node:fs").writeFileSync(process.env.ADO_PR_LAUNCH_CAPTURE, JSON.stringify({ pat: process.env.AZURE_DEVOPS_PAT, marker: process.env.ADO_PR_ENV_MARKER, args: process.argv.slice(2) }));\n`,
	);
	if (envContents !== undefined) writeFileSync(envPath, envContents);

	mkdirSync(binPath);
	symlinkSync(process.execPath, join(binPath, "node"));
	symlinkSync("/usr/bin/dirname", join(binPath, "dirname"));
	symlinkSync("/usr/bin/readlink", join(binPath, "readlink"));

	return {
		binPath,
		capturePath,
		envPath,
		launcherPath,
		prPath,
		shellMarkerPath,
	};
}

function runLauncher(fixture, args = [], env = {}) {
	return spawnTestProcess("/bin/bash", [fixture.launcherPath, ...args], {
		description: "pr.sh launcher test",
		encoding: "utf8",
		env: {
			PATH: fixture.binPath,
			ADO_PR_LAUNCH_CAPTURE: fixture.capturePath,
			...env,
		},
	});
}

function readCapture(fixture) {
	return JSON.parse(readFileSync(fixture.capturePath, "utf8"));
}

function installFakeOp(fixture) {
	const argsPath = join(dirname(fixture.capturePath), "op-args.txt");
	writeFileSync(
		join(fixture.binPath, "op"),
		`#!/bin/bash\nset -eu\nprintf '%s\\n' "$@" > ${JSON.stringify(argsPath)}\n[[ "$1" == run ]] || exit 90\nshift\nif [[ "\${1:-}" == --env-file=* ]]; then shift; fi\n[[ "$1" == -- ]] || exit 91\nshift\nexport AZURE_DEVOPS_PAT=resolved-by-op\nexec "$@"\n`,
	);
	chmodSync(join(fixture.binPath, "op"), 0o755);
	return argsPath;
}

function readLines(path) {
	return readFileSync(path, "utf8").trimEnd().split("\n");
}

launcherTest("loads dotenv beside the real script through a symlink", (t) => {
	const fixture = createFixture(t, "AZURE_DEVOPS_PAT=real-script-pat\n");
	const launcherPath = join(fixture.binPath, "pr.sh");
	symlinkSync(fixture.launcherPath, launcherPath);
	writeFileSync(join(fixture.binPath, ".env"), "AZURE_DEVOPS_PAT=link-pat\n");

	const result = runLauncher({ ...fixture, launcherPath }, ["pr", "show"]);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readCapture(fixture), {
		pat: "real-script-pat",
		args: ["pr", "show"],
	});
});

launcherTest(
	"prefers an exported literal PAT and forwards arguments without shell evaluation",
	(t) => {
		const fixture = createFixture(t, "AZURE_DEVOPS_PAT=dotenv-must-not-win\n");
		const args = [
			"value with spaces",
			"*.ts",
			`$(touch ${fixture.shellMarkerPath})`,
			"line\nbreak",
		];
		const result = runLauncher(fixture, args, {
			AZURE_DEVOPS_PAT: "exported-literal-pat",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readCapture(fixture), {
			pat: "exported-literal-pat",
			args,
		});
		assert.equal(existsSync(fixture.shellMarkerPath), false);
	},
);

launcherTest(
	"loads a literal dotenv file without invoking an installed op command or shell syntax",
	(t) => {
		const fixture = createFixture(t);
		writeFileSync(
			fixture.envPath,
			`AZURE_DEVOPS_PAT=dotenv-literal-pat\nADO_PR_ENV_MARKER=loaded-from-dotenv\nIGNORED=$(touch ${fixture.shellMarkerPath})\n`,
		);
		const opMarkerPath = join(dirname(fixture.capturePath), "op-called");
		writeFileSync(
			join(fixture.binPath, "op"),
			`#!/bin/sh\nprintf called > ${JSON.stringify(opMarkerPath)}\nexit 97\n`,
		);
		chmodSync(join(fixture.binPath, "op"), 0o755);

		const result = runLauncher(fixture, ["--help"], { AZURE_DEVOPS_PAT: "" });

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readCapture(fixture), {
			pat: "dotenv-literal-pat",
			marker: "loaded-from-dotenv",
			args: ["--help"],
		});
		assert.equal(existsSync(opMarkerPath), false);
		assert.equal(existsSync(fixture.shellMarkerPath), false);
	},
);

launcherTest(
	"loads a literal PAT from a 1Password Environment-style named pipe",
	(t) => {
		const fixture = createFixture(t);
		execFileSync("mkfifo", [fixture.envPath]);

		const writer = spawn(
			process.execPath,
			[
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(fixture.envPath)}, "AZURE_DEVOPS_PAT=mounted-literal-pat\\nADO_PR_ENV_MARKER=loaded-from-mount\\n")`,
			],
			{ stdio: "ignore" },
		);
		t.after(() => writer.kill());

		const result = runLauncher(fixture, ["list"]);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readCapture(fixture), {
			pat: "mounted-literal-pat",
			marker: "loaded-from-mount",
			args: ["list"],
		});
	},
);

launcherTest(
	"resolves a quoted dotenv op reference through the 1Password CLI",
	(t) => {
		const fixture = createFixture(
			t,
			'export AZURE_DEVOPS_PAT="op://Private/Azure/PAT"\r\n',
		);
		const opArgsPath = installFakeOp(fixture);

		const result = runLauncher(fixture, ["list"]);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readCapture(fixture), {
			pat: "resolved-by-op",
			args: ["list"],
		});
		assert.deepEqual(readLines(opArgsPath), [
			"run",
			`--env-file=${fixture.envPath}`,
			"--",
			"node",
			"--disable-warning=ExperimentalWarning",
			"--experimental-strip-types",
			fixture.prPath,
			"list",
		]);
	},
);

launcherTest(
	"resolves an exported op reference without passing a dotenv file",
	(t) => {
		const fixture = createFixture(
			t,
			"AZURE_DEVOPS_PAT=dotenv-must-not-be-used\n",
		);
		const opArgsPath = installFakeOp(fixture);

		const result = runLauncher(fixture, ["reply", "two words"], {
			AZURE_DEVOPS_PAT: "op://Private/Azure/PAT",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readCapture(fixture), {
			pat: "resolved-by-op",
			args: ["reply", "two words"],
		});
		assert.deepEqual(readLines(opArgsPath), [
			"run",
			"--",
			"node",
			"--disable-warning=ExperimentalWarning",
			"--experimental-strip-types",
			fixture.prPath,
			"reply",
			"two words",
		]);
	},
);

launcherTest(
	"rejects an exported op reference when the 1Password CLI is unavailable",
	(t) => {
		const fixture = createFixture(t);
		const result = runLauncher(fixture, [], {
			AZURE_DEVOPS_PAT: "op://Private/Azure/PAT",
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /AZURE_DEVOPS_PAT is an op:\/\/ reference/);
		assert.match(result.stderr, /1Password CLI \('op'\) was not found on PATH/);
		assert.equal(existsSync(fixture.capturePath), false);
	},
);

launcherTest(
	"rejects a dotenv op reference when the 1Password CLI is unavailable",
	(t) => {
		const fixture = createFixture(
			t,
			"AZURE_DEVOPS_PAT=op://Private/Azure/PAT\n",
		);
		const result = runLauncher(fixture);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /AZURE_DEVOPS_PAT .* is an op:\/\/ reference/);
		assert.match(result.stderr, /1Password CLI \('op'\) was not found on PATH/);
		assert.equal(existsSync(fixture.capturePath), false);
	},
);

launcherTest(
	"reports how to configure authentication when neither source is available",
	(t) => {
		const fixture = createFixture(t);
		const result = runLauncher(fixture);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /AZURE_DEVOPS_PAT is not set/);
		assert.match(
			result.stderr,
			/Export AZURE_DEVOPS_PAT, or copy .*\.env\.tpl/,
		);
		assert.equal(existsSync(fixture.capturePath), false);
	},
);
