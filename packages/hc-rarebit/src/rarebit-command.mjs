const literal = (value, description) => ({
  kind: "literal",
  value,
  description,
});

const number = (usage, validate) => ({
  kind: "number",
  usage,
  validate,
});

const rest = (usage) => ({
  kind: "rest",
  usage,
});

export const RAREBIT_COMMAND_GRAMMAR = Object.freeze({
  name: "rarebit",
  defaultSubcommand: "status",
  subcommands: Object.freeze([
    {
      name: "status",
      description: "Show effective Rarebit configuration",
      forms: [[]],
    },
    {
      name: "dump",
      description: "Recall active-branch Rarebit messages with a prompt",
      forms: [
        [literal("messages", "Recall selected messages"), rest("<prompt...>")],
      ],
    },
    {
      name: "config",
      description: "Show or override summary policy for this process",
      forms: [
        [],
        [
          literal(
            "max_rarebit_ratio",
            "Override the maximum selected-prose ratio",
          ),
          number("<0..1>", (value) => value >= 0 && value <= 1),
        ],
        [
          literal(
            "min_total_length",
            "Override the minimum estimated token count",
          ),
          number("<nonnegative estimated tokens>", (value) => value >= 0),
        ],
      ],
    },
    {
      name: "auto-title",
      description: "Show or override automatic Session titles",
      forms: [
        [],
        [literal("on", "Enable automatic Session titles")],
        [literal("off", "Disable automatic Session titles")],
      ],
    },
    {
      name: "title",
      description: "Generate a title for the active Session",
      usageNote: "use Pi's native /name for a literal title",
      forms: [[]],
    },
    {
      name: "summarize",
      description: "Force a Rarebit Summary materialization",
      forms: [[]],
    },
  ]),
});

const renderToken = (token) =>
  token.kind === "literal" ? token.value : token.usage;

const renderForms = (forms) => {
  const hasEmptyForm = forms.some((form) => form.length === 0);
  const alternatives = forms
    .filter((form) => form.length > 0)
    .map((form) => form.map(renderToken).join(" "));
  if (alternatives.length === 0) return "";
  const rendered = alternatives.join("|");
  return hasEmptyForm ? ` [${rendered}]` : ` ${rendered}`;
};

export function rarebitCommandDescription(grammar = RAREBIT_COMMAND_GRAMMAR) {
  return `Rarebit ${grammar.subcommands.map(({ name }) => name).join("/")}`;
}

export function rarebitCommandUsage(
  subcommand,
  grammar = RAREBIT_COMMAND_GRAMMAR,
) {
  if (!subcommand) {
    return `Usage: /${grammar.name} [${grammar.subcommands
      .map(({ name }) => name)
      .join("|")}]`;
  }
  const definition = grammar.subcommands.find(
    ({ name }) => name === subcommand,
  );
  if (!definition) return rarebitCommandUsage(undefined, grammar);
  const note = definition.usageNote ? ` (${definition.usageNote})` : "";
  return `Usage: /${grammar.name} ${definition.name}${renderForms(definition.forms)}${note}`;
}

const matchToken = (definition, rawValue) => {
  if (definition.kind === "literal") return rawValue === definition.value;
  if (definition.kind === "rest") return String(rawValue).trim().length > 0;
  const value = Number(rawValue);
  return Number.isFinite(value) && definition.validate(value);
};

export function parseRarebitCommand(input, grammar = RAREBIT_COMMAND_GRAMMAR) {
  const rawInput = String(input ?? "");
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean);
  const subcommandName = tokens[0] ?? grammar.defaultSubcommand;
  const definition = grammar.subcommands.find(
    ({ name }) => name === subcommandName,
  );
  if (!definition) {
    return {
      ok: false,
      error: "unknown_subcommand",
      usage: rarebitCommandUsage(undefined, grammar),
    };
  }

  const freeform = definition.forms.find(
    (form) => form.at(-1)?.kind === "rest",
  );
  if (freeform) {
    const prefix = freeform.slice(0, -1);
    const leading = rawInput.trimStart();
    const subcommandEnd = leading.search(/\s/);
    const rawArguments = subcommandEnd < 0 ? "" : leading.slice(subcommandEnd);
    let remaining = rawArguments;
    const parsed = [];
    let prefixMatches = true;
    for (const token of prefix) {
      const separator = remaining.match(/^\s+/)?.[0] ?? "";
      remaining = remaining.slice(separator.length);
      const value = remaining.match(/^\S+/)?.[0];
      if (!value || !matchToken(token, value)) {
        prefixMatches = false;
        break;
      }
      parsed.push(value);
      remaining = remaining.slice(value.length);
    }
    if (prefixMatches && /^\s/.test(remaining)) {
      const prompt = remaining.slice(1);
      if (matchToken(freeform.at(-1), prompt)) {
        return {
          ok: true,
          subcommand: definition.name,
          arguments: [...parsed, prompt],
        };
      }
    }
    return {
      ok: false,
      error: "invalid_arguments",
      subcommand: definition.name,
      usage: rarebitCommandUsage(definition.name, grammar),
    };
  }

  const argumentTokens = tokens.slice(1);
  const form = definition.forms.find(
    (candidate) =>
      candidate.length === argumentTokens.length &&
      candidate.every((token, index) =>
        matchToken(token, argumentTokens[index]),
      ),
  );
  if (!form) {
    const hasMatchingShape = definition.forms.some(
      (candidate) =>
        candidate.length === argumentTokens.length &&
        candidate.every(
          (token, index) =>
            token.kind !== "literal" || token.value === argumentTokens[index],
        ),
    );
    return {
      ok: false,
      error: hasMatchingShape ? "invalid_value" : "invalid_arguments",
      subcommand: definition.name,
      usage: rarebitCommandUsage(definition.name, grammar),
    };
  }

  return {
    ok: true,
    subcommand: definition.name,
    arguments: argumentTokens,
  };
}

const completionItem = ({ value, label, description }) => ({
  value,
  label,
  ...(description ? { description } : {}),
});

export function getRarebitArgumentCompletions(
  prefix,
  grammar = RAREBIT_COMMAND_GRAMMAR,
) {
  const input = String(prefix ?? "").trimStart();
  const trailingWhitespace = /\s$/.test(input);
  const tokens = input.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return grammar.subcommands.map((subcommand) =>
      completionItem({
        value: subcommand.name,
        label: subcommand.name,
        description: subcommand.description,
      }),
    );
  }

  if (tokens.length === 1 && !trailingWhitespace) {
    const partial = tokens[0];
    const matches = grammar.subcommands
      .filter(({ name }) => name.startsWith(partial))
      .map((subcommand) =>
        completionItem({
          value: subcommand.name,
          label: subcommand.name,
          description: subcommand.description,
        }),
      );
    return matches.length > 0 ? matches : null;
  }

  const definition = grammar.subcommands.find(({ name }) => name === tokens[0]);
  if (!definition) return null;

  const argumentTokens = tokens.slice(1);
  const completionIndex = trailingWhitespace
    ? argumentTokens.length
    : argumentTokens.length - 1;
  const partial = trailingWhitespace ? "" : argumentTokens.at(-1);
  const priorArguments = argumentTokens.slice(0, completionIndex);
  const matches = [];
  const seen = new Set();

  for (const form of definition.forms) {
    const priorMatches = priorArguments.every(
      (value, index) => form[index] && matchToken(form[index], value),
    );
    const token = form[completionIndex];
    if (
      !priorMatches ||
      token?.kind !== "literal" ||
      !token.value.startsWith(partial)
    )
      continue;

    const needsFollowingArgument = form.length > completionIndex + 1;
    const value = [definition.name, ...priorArguments, token.value].join(" ");
    const completedValue = needsFollowingArgument ? `${value} ` : value;
    if (seen.has(completedValue)) continue;
    seen.add(completedValue);
    matches.push(
      completionItem({
        value: completedValue,
        label: token.value,
        description: token.description,
      }),
    );
  }

  return matches.length > 0 ? matches : null;
}
