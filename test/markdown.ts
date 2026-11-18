// What the documentation tests read of a Markdown text: its fenced code
// blocks and its tables' rows.

export type Fence = {
  /** The fence's marker, such as "```" or "~~~~". */
  readonly marker: string;
  readonly info: readonly string[];
  readonly line: number;
  readonly body: string;
};

type Scan = {
  readonly open:
    (Omit<Fence, "body"> & { readonly lines: readonly string[] }) | null;
  readonly fences: readonly Fence[];
};

/** The run of backticks or tildes, three or more, that opens a fence on this line. */
const markerOf = (line: string): string | null => {
  const text = line.trimStart();
  const character = text[0];
  if (character !== "`" && character !== "~") {
    return null;
  }
  const length = Array.from(text).findIndex((c) => c !== character);
  const marker = length === -1 ? text : text.slice(0, length);
  return marker.length >= 3 ? marker : null;
};

/** Whether the line closes a fence opened by `marker`: the same character, at least as many, and nothing else. */
const closes = (line: string, marker: string): boolean => {
  const text = line.trim();
  return (
    text.length >= marker.length &&
    Array.from(text).every((c) => c === marker[0])
  );
};

/** The fenced code blocks of a Markdown text, with backtick or tilde fences. */
export const fencedBlocks = (text: string): readonly Fence[] =>
  text.split("\n").reduce<Scan>(
    (scan, line, index) => {
      if (scan.open === null) {
        const marker = markerOf(line);
        return marker === null
          ? scan
          : {
              ...scan,
              open: {
                marker,
                info: line.trimStart().slice(marker.length).trim().split(/\s+/),
                line: index + 1,
                lines: [],
              },
            };
      }
      return closes(line, scan.open.marker)
        ? {
            open: null,
            fences: [
              ...scan.fences,
              {
                marker: scan.open.marker,
                info: scan.open.info,
                line: scan.open.line,
                body: scan.open.lines.join("\n"),
              },
            ],
          }
        : {
            ...scan,
            open: { ...scan.open, lines: [...scan.open.lines, line] },
          };
    },
    { open: null, fences: [] },
  ).fences;

/** A table row's cells, trimmed, split at each `|` that no backslash escapes. */
const cells = (line: string): readonly string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

/** Whether a row is a table's delimiter row, such as `| --- | :-: |`. */
const isDelimiter = (row: readonly string[]): boolean =>
  row.every((cell) => /^:?-+:?$/.test(cell));

/**
 * The tables of a Markdown text outside its fenced blocks, each as its
 * header row followed by its body rows.
 */
export const tables = (text: string): readonly (readonly string[])[][] => {
  const fenced = new Set(
    fencedBlocks(text).flatMap(({ line, body }) =>
      Array.from({ length: body.split("\n").length + 2 }, (_, i) => line + i),
    ),
  );
  const found: (readonly string[])[][] = [];
  let current: (readonly string[])[] = [];
  text.split("\n").forEach((line, index) => {
    const isRow = !fenced.has(index + 1) && line.trim().startsWith("|");
    if (isRow) {
      current.push(cells(line));
    } else if (current.length > 0) {
      found.push(current);
      current = [];
    }
  });
  if (current.length > 0) {
    found.push(current);
  }
  return found.map((table) => table.filter((row) => !isDelimiter(row)));
};
