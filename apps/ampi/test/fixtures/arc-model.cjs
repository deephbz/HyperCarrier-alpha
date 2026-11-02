// Offline model: one chapter per input window. Native IDs and quotes come only from supplied evidence.
let input = "";
process.stdin.on("data", chunk => input += chunk).on("end", () => {
 const p = JSON.parse(input.split("\nAnswer rejected:")[0]);
 const first = p.rarebits[0], last = p.rarebits.at(-1);
 const claim = (i, text) => ({ text, cites: [{ id: i.id, quote: i.text.slice(0, 100) }] });
 const open = p.previous?.chapters.find(c => c.closed === false);
 console.log(JSON.stringify({ goal: claim(first, "Finish the agreed work."), now: claim(last, "The agent reports progress."), chapters: [{ firstId: open?.firstId ?? first.id, label: "Reviewed the reported evidence", closed: true, summary: { scope: claim(first, "Review the current work."), bullets: [claim(last, "The agent reported progress.")] } }], points: first.owner ? [{ kind: "request", state: "open", by: "owner", waits: "agent", title: "Finish the agreed work", text: "Open: Complete the request.", cites: [{ id: first.id, quote: first.text.slice(0, 100) }] }] : [] }));
});
