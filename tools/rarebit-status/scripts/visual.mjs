import {
  rarebitOccurrencePresentation,
  rarebitSummaryPresentation,
} from "../../../packages/hc-rarebit/src/rarebit-visual-language.mjs";

function terminalStyle(tone, ansi) {
  switch (tone) {
    case "user":
      return ansi.green;
    case "continuation":
      return ansi.blue;
    case "boundary":
      return ansi.bold;
    case "attention":
      return `${ansi.yellow}${ansi.bold}`;
    case "diagnostic":
      return ansi.red;
    case "muted":
      return ansi.dim;
    default:
      return "";
  }
}

function styled(text, tone, ansi) {
  const style = terminalStyle(tone, ansi);
  return style ? `${style}${text}${ansi.reset}` : text;
}

export function terminalOccurrencePresentation(occurrence, ansi) {
  const presentation = rarebitOccurrencePresentation(occurrence);
  return {
    ...presentation,
    marker: styled(presentation.mark, presentation.tone, ansi),
  };
}

export function terminalSummaryPresentation(summary, ansi) {
  const presentation = rarebitSummaryPresentation(summary.status, {
    sourcePending: summary.sourcePending,
  });
  const text = presentation.mark
    ? `${presentation.mark} ${presentation.label}`
    : presentation.label;
  return {
    ...presentation,
    text: styled(text, presentation.tone, ansi),
  };
}
