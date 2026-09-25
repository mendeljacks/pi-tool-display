import type { ToolDisplayConfig } from "./types.js";

/**
 * Marker for the injected guideline, used to keep the injection idempotent when
 * several `before_agent_start` handlers chain the same system prompt.
 */
export const BASH_INTENT_GUIDELINE_MARKER = "Bash call intent headers";

export const BASH_INTENT_GUIDELINE = [
	`## ${BASH_INTENT_GUIDELINE_MARKER}`,
	"",
	"Start every bash command with comment lines naming what it does and why:",
	"",
	"    # intent: <what and why, at most 10 words>",
	"    # tool: <the program and subcommand this command runs>",
	"    <command>",
	"",
	"`intent` is required and is rendered as the call header instead of the raw command, so make it specific",
	'("check which files are dirty" beats "run git").',
	"",
	"`tool` is rendered as the header label and **must name the program actually being run, exactly as it is",
	"invoked** — `gh pr view`, `git status`, `npm test`, `docker compose`. Never name the shell or the tool you",
	"are calling through (`bash`, `shell`) — that says nothing about the command. For a script that runs several",
	"programs, name the one doing the work. Omit `tool` and the label falls back to the program derived from the",
	"command.",
	"",
	"Both are ordinary shell comments: the renderer strips them for display and they are never executed.",
].join("\n");

type IntentConfig = Pick<ToolDisplayConfig, "bashIntentMode" | "registerToolOverrides">;

/** Wrapper programs that should not become the displayed program name. */
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "env", "nohup", "command", "exec", "time"]);

/**
 * Flags that consume the following token as their value, per wrapper. Without
 * this, `sudo -u root systemctl restart app` would label the user name as the
 * program. Flags not listed here are assumed to be standalone (`env -i`, `sudo -n`).
 */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
	sudo: ["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-D", "--user", "--group", "--prompt", "--host"],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	time: ["-o", "-f", "-a", "--output", "--format", "--append"],
	command: ["-p", "-v"],
	exec: ["-a"],
	nohup: [],
};

/** A leading `VAR=value` assignment, which is not the program being run. */
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Shell builtins that give no hint about what a command actually does. A leading
 * `cd /srv/app && git status` should label `git status`, not `cd`.
 */
const NO_IDENTITY_PROGRAMS = new Set([
	".", ":", "alias", "cd", "declare", "export", "local", "popd", "pushd", "readonly",
	"set", "shopt", "source", "trap", "true", "ulimit", "umask", "unalias", "unset", "wait",
]);

/**
 * Index of the program token in a single pipeline segment, skipping leading
 * `VAR=value` assignments and wrapper programs (with their flags and the values
 * those flags consume). Returns `tokens.length` when there is no program.
 */
function findProgramIndex(tokens: readonly string[]): number {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as string;
		if (ENV_ASSIGNMENT_PATTERN.test(token)) {
			index += 1;
			continue;
		}
		if (!WRAPPER_COMMANDS.has(token)) {
			break;
		}

		const valueFlags = WRAPPER_VALUE_FLAGS[token] ?? [];
		index += 1;
		while (index < tokens.length && (tokens[index] as string).startsWith("-")) {
			const flag = tokens[index] as string;
			index += 1;
			// `--flag=value` is self-contained; `-u value` is not.
			if (!flag.includes("=") && valueFlags.includes(flag)) {
				index += 1;
			}
		}
	}
	return index;
}

/**
 * The program a command runs — the part that is always knowable from the command
 * itself, with no guessing: arguments, subcommands and flag values are all
 * indistinguishable from each other in a shell command, so none of them are
 * inferred here.
 *
 * When a more specific label is wanted (`git status` rather than `git`), the
 * caller supplies one via the `# tool:` comment, which the agent authors. That
 * keeps this function free of any curated list of programs.
 *
 *     git --git-dir=/srv/.git --work-tree=/srv status --short  ->  "git"
 *     sudo FOO=1 /usr/bin/apt-get install -y curl               ->  "apt-get"
 *     cd /srv/app && git status --short                         ->  "git"
 *     grep -r pattern /path                                     ->  "grep"
 *     echo "some long message"                                  ->  "echo"
 *
 * A leading segment that only sets context (`cd`, `export`, `source`, …) is
 * skipped so the label names the program that does the work. Pipelines stop at
 * the first segment, so a label never describes something merely piped into.
 */
export function extractProgramName(command: string): string {
	const firstLine =
		command
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !line.startsWith("#")) ?? "";

	for (const statement of firstLine.split(/\s*(?:\|\||&&|;)\s*/)) {
		const segment = statement.split(/\s*\|\s*/)[0]?.trim() ?? "";
		const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
		const program = tokens[findProgramIndex(tokens)];
		if (program === undefined) {
			continue;
		}

		const programLabel = program.split("/").pop() || program;
		if (NO_IDENTITY_PROGRAMS.has(programLabel)) {
			continue;
		}

		return programLabel;
	}

	return "";
}

/**
 * Whether this config wants the intent-comment convention taught to the model.
 * Requires the extension to actually own the bash renderer — otherwise the
 * comment is inert and instructing the model would only add prompt noise.
 */
export function shouldInstructBashIntent(config: IntentConfig): boolean {
	return config.bashIntentMode === "render-and-instruct" && config.registerToolOverrides.bash;
}

/**
 * Returns the system prompt with the intent guideline appended, or `undefined`
 * when no change is needed (feature off, renderer not owned, or already present).
 */
export function buildBashIntentSystemPrompt(
	systemPrompt: string,
	config: IntentConfig,
): string | undefined {
	if (!shouldInstructBashIntent(config)) {
		return undefined;
	}

	if (systemPrompt.includes(BASH_INTENT_GUIDELINE_MARKER)) {
		return undefined;
	}

	return `${systemPrompt}\n\n${BASH_INTENT_GUIDELINE}`;
}
