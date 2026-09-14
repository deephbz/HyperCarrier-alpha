import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContentRenderer,
  MermaidBlock,
  prepareMermaidSource,
  sanitizeMermaidSvg,
  type MermaidDiagramRenderer,
} from "./ContentRenderer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContentRenderer", () => {
  it("renders Markdown as safe React content without resource elements", () => {
    render(
      <ContentRenderer
        text={
          '# Heading\n\n**bold** [safe](https://example.com) [unsafe](javascript:alert(1))\n\n![remote](https://example.com/image.png)\n\n<script>alert(1)</script><img src="https://example.com/x" />'
        }
      />,
    );

    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
    expect(screen.getByText("bold")).toBeTruthy();
    expect(screen.getByRole("link", { name: "safe" }).getAttribute("href")).toBe(
      "https://example.com/",
    );
    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
    expect(screen.getByText(/Image omitted: remote/)).toBeTruthy();
    expect(document.querySelector("script, img, iframe, video, audio, source")).toBeNull();
  });

  it("renders GFM table cells, header roles, and column alignment", () => {
    render(<ContentRenderer text={"| Name | Status |\n| :--- | ---: |\n| alpha | **green** |"} />);

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Name", "Status"]);
    expect(headers[0].style.textAlign).toBe("left");
    expect(headers[1].style.textAlign).toBe("right");
    expect(screen.getAllByRole("cell")[0].textContent).toBe("alpha");
    expect(screen.getByText("green").tagName).toBe("STRONG");
  });

  it("memoizes on text so unchanged content keeps its DOM", () => {
    const text = "Stable prose with **emphasis**";
    const view = render(<ContentRenderer text={text} />);
    const first = view.container.querySelector("strong");

    view.rerender(<ContentRenderer text={text} />);
    expect(view.container.querySelector("strong")).toBe(first);
    // The memo wrapper is the performance contract that avoids re-lexing on
    // unrelated parent renders; a plain function component would re-run.
    expect((ContentRenderer as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("keeps escaped entities and code fences as readable evidence", () => {
    const view = render(
      <ContentRenderer text={"5 &lt; 6 &amp; &#35;\n\n```\nconst x = 1;\n```"} />,
    );

    expect(view.container.textContent).toContain("5 < 6 & #");
    expect(screen.getByText("const x = 1;").tagName).toBe("CODE");
  });

  it("keeps only explicit safe links and never auto-loads them", () => {
    render(
      <ContentRenderer
        text={"[relative](/trace) [mail](mailto:test@example.com) [bad](data:text/html,evil)"}
      />,
    );

    expect(screen.getByRole("link", { name: "relative" }).getAttribute("href")).toBe("/trace");
    expect(screen.getByRole("link", { name: "mail" }).getAttribute("href")).toBe(
      "mailto:test@example.com",
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(
      document.querySelector("[src], [srcset], [href^='javascript:'], [href^='data:']"),
    ).toBeNull();
  });
});

describe("Mermaid safety boundary", () => {
  it("removes config and click directives before Mermaid receives source", () => {
    expect(
      prepareMermaidSource(
        "%%{init: {'securityLevel': 'loose'}}%%\ngraph TD\nA --> B\nclick A \"https://evil.example\"",
      ),
    ).toBe("\ngraph TD\nA --> B");
  });

  it("keeps URL-looking label text but removes active directives", () => {
    const prepared = prepareMermaidSource(
      'graph TD\nA["https://api.example.invalid"] --> B\nclick A "https://evil.example"',
    );

    expect(prepared).toContain('A["https://api.example.invalid"] --> B');
    expect(prepared).not.toContain("click");
  });

  it("refuses SVG when sanitizing would drop visible content", () => {
    const unsafe =
      '<svg viewBox="0 0 10 10"><style>svg { background: url(https://evil.example) }</style><script>alert(1)</script><a href="https://evil.example"><text>linked label</text></a><foreignObject><div>html label</div></foreignObject><image href="https://evil.example/x" /></svg>';
    expect(sanitizeMermaidSvg(unsafe)).toBeNull();
  });

  it("shows raw fallback when a diagram is malformed", async () => {
    const renderDiagram = vi.fn<MermaidDiagramRenderer>().mockRejectedValue(new Error("bad graph"));
    render(<MermaidBlock id="bad" source="graph TD\nnot valid" renderDiagram={renderDiagram} />);

    await waitFor(() => expect(screen.getByText(/Diagram could not be rendered/)).toBeTruthy());
    expect(screen.getByText(/graph TD/)).toBeTruthy();
  });

  it("ignores a stale diagram result after the source changes", async () => {
    const pending = new Map<string, (svg: string) => void>();
    const renderDiagram: MermaidDiagramRenderer = vi.fn(
      (source: string) =>
        new Promise<string>((resolve) => {
          pending.set(source, resolve);
        }),
    );
    const view = render(<MermaidBlock id="changing" source="old" renderDiagram={renderDiagram} />);
    view.rerender(<MermaidBlock id="changing" source="new" renderDiagram={renderDiagram} />);

    pending.get("old")?.("<svg><text>old</text></svg>");
    await Promise.resolve();
    expect(screen.queryByText("old")).toBeNull();
    expect(screen.getByText("new")).toBeTruthy();
  });

  it("falls back when rendered SVG would lose visible content", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:trace-diagram"),
      revokeObjectURL: vi.fn(),
    });
    const renderDiagram = vi
      .fn<MermaidDiagramRenderer>()
      .mockResolvedValue(
        '<svg viewBox="0 0 10 10"><foreignObject width="10" height="10"><div>label</div></foreignObject></svg>',
      );
    render(<MermaidBlock id="unsafe" source="graph TD" renderDiagram={renderDiagram} />);

    await waitFor(() => expect(screen.getByText(/Diagram could not be rendered/)).toBeTruthy());
    expect(screen.getByText(/graph TD/)).toBeTruthy();
  });
});
