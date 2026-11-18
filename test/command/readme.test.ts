// Holds README.md to the command: every `declarative-tab-groups` command in
// its `sh` blocks parses as the command's own parser reads it, each
// command has an example, and its table of exit statuses lists the ones
// `--help` lists.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseArguments } from "../../src/command/arguments.ts";
import { MAIN_HELP, PROGRAM } from "../../src/command/help.ts";
import { EXIT } from "../../src/command/output.ts";
import { fencedBlocks, tables } from "../markdown.ts";

const readme = readFileSync(
  new URL("../../README.md", import.meta.url),
  "utf8",
);

/** A word of a shell command, or the pipe between two commands. */
type Token =
  { readonly kind: "word"; readonly text: string } | { readonly kind: "pipe" };

type Lexer = {
  readonly tokens: readonly Token[];
  /** The word being read, or null between words. */
  readonly word: string | null;
  /** The quote the lexer is inside, if any. */
  readonly quote: "'" | '"' | null;
  readonly escaped: boolean;
};

const endWord = (lexer: Lexer): readonly Token[] =>
  lexer.word === null
    ? lexer.tokens
    : [...lexer.tokens, { kind: "word", text: lexer.word }];

const append = (lexer: Lexer, text: string): Lexer => ({
  ...lexer,
  word: (lexer.word ?? "") + text,
  escaped: false,
});

/**
 * The words and pipes of one line of POSIX shell, with its single and
 * double quotes and backslashes taken out; null for a line that expands a
 * variable or a command, or uses any operator but `|`, which a test cannot
 * hand to the parser as the shell would.
 */
const shellTokens = (line: string): readonly Token[] | null => {
  const final = Array.from(line).reduce<Lexer | null>(
    (lexer, character) => {
      if (lexer === null) {
        return null;
      }
      if (lexer.escaped) {
        return append(lexer, character);
      }
      if (lexer.quote === "'") {
        return character === "'"
          ? { ...lexer, quote: null }
          : append(lexer, character);
      }
      if (character === "\\") {
        return { ...lexer, word: lexer.word ?? "", escaped: true };
      }
      if (lexer.quote === '"') {
        return character === '"'
          ? { ...lexer, quote: null }
          : "$`".includes(character)
            ? null
            : append(lexer, character);
      }
      if (character === "'" || character === '"') {
        return { ...lexer, word: lexer.word ?? "", quote: character };
      }
      if (character === " " || character === "\t") {
        return { ...lexer, tokens: endWord(lexer), word: null };
      }
      if (character === "|") {
        return {
          ...lexer,
          tokens: [...endWord(lexer), { kind: "pipe" }],
          word: null,
        };
      }
      return "$`;&<>()#*?[]{}~".includes(character)
        ? null
        : append(lexer, character);
    },
    { tokens: [], word: null, quote: null, escaped: false },
  );
  return final === null || final.quote !== null || final.escaped
    ? null
    : endWord(final);
};

/** The commands of a pipeline, each as its words. */
const commandsOf = (tokens: readonly Token[]): readonly (readonly string[])[] =>
  tokens.reduce<readonly (readonly string[])[]>(
    (commands, token) =>
      token.kind === "pipe"
        ? [...commands, []]
        : [...commands.slice(0, -1), [...(commands.at(-1) ?? []), token.text]],
    [[]],
  );

/** Each `sh` block's lines, a line ended by a backslash joined to the next, without comments. */
const shellLines = (
  text: string,
): readonly { readonly line: number; readonly text: string }[] =>
  fencedBlocks(text)
    .filter(({ info }) => info[0] === "sh")
    .flatMap(({ line, body }) =>
      body
        .replace(/\\\n/g, " ")
        .split("\n")
        .map((text) => ({ line, text: text.trim() }))
        .filter(({ text }) => text !== "" && !text.startsWith("#")),
    );

const invocations = shellLines(readme).flatMap(({ line, text }) => {
  const tokens = shellTokens(text);
  assert.ok(
    tokens !== null,
    `the sh block at line ${line} holds ${text}, which the test cannot read as words`,
  );
  return commandsOf(tokens)
    .filter((words) => words[0] === PROGRAM)
    .map((words) => ({ line, text, args: words.slice(1) }));
});

/** The exit statuses a help text lists. */
const helpStatuses = (help: string): readonly string[] =>
  [...(help.split("\nExit statuses:\n")[1] ?? "").matchAll(/^ {2}(\d) /gm)].map(
    (match) => match[1] ?? "",
  );

describe("README.md", () => {
  it("reads shell words as the shell does", () => {
    assert.deepEqual(shellTokens(`printf '%s\\n' "a b" c\\ d | x -`), [
      { kind: "word", text: "printf" },
      { kind: "word", text: "%s\\n" },
      { kind: "word", text: "a b" },
      { kind: "word", text: "c d" },
      { kind: "pipe" },
      { kind: "word", text: "x" },
      { kind: "word", text: "-" },
    ]);
    assert.equal(shellTokens('echo "$HOME"'), null);
    assert.equal(shellTokens("a && b"), null);
    assert.equal(shellTokens("'open"), null);
  });

  it("shows every command in an example the command's parser accepts", () => {
    invocations.forEach(({ line, text, args }) => {
      const invocation = parseArguments(args);
      assert.ok(
        invocation.kind === "run" || invocation.kind === "help",
        `the sh block at line ${line} runs ${text}, which the command rejects: ${JSON.stringify(invocation)}`,
      );
    });
    const shown = new Set(
      invocations.flatMap(({ args }) => {
        const invocation = parseArguments(args);
        return invocation.kind === "run" ? [invocation.command.command] : [];
      }),
    );
    assert.deepEqual([...shown].toSorted(), [
      "get",
      "install",
      "set",
      "status",
      "uninstall",
    ]);
  });

  it("lists the exit statuses --help lists", () => {
    const table = tables(readme).find((rows) => rows[0]?.[0] === "Exit status");
    assert.ok(table !== undefined, "README.md has no table headed Exit status");
    const statuses = table.slice(1).map((row) => row[0] ?? "");
    assert.deepEqual(statuses, helpStatuses(MAIN_HELP));
    assert.deepEqual(
      statuses,
      Object.values(EXIT)
        .toSorted((a, b) => a - b)
        .map(String),
    );
  });
});
