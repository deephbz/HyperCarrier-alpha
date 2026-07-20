import { Marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer,
});

/** Render a derived display projection. The raw Rarebit text remains authority. */
export function renderRarebitMarkdown(text) {
  const rendered = markdown.parse(String(text ?? ""));
  return sanitizeHtml(rendered, {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: {
      a: ["href", "title", "rel"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" },
      }),
    },
  });
}
