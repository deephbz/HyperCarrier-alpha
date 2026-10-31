import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { control } from "./pi-fixtures.ts";
import { setup } from "./pi-host-fixtures.ts";

// A returned Pi message carries text only. The image count must reach both the Stop reply and the queue view
// so the owner knows to attach the lost images again. Exercise the real agent projection and Host together.
test("Pi returned images retain their count through the remote agent, Stop reply, and queue view", async (t) => {
 const { f, browser } = await setup(t);
 const ctl = await control(f, f.sessionA, { images: true, queue: true });
 t.after(() => ctl.close());
 const threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(threads, v => v.threads["pi:sess-a"]?.images);
 const png = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", mimeType: "image/png" };
 const admitted = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "Inspect both images", images: [png, png], whenBusy: "followUp" });
 assert.equal(ctl.requests.filter(r => r.op === "submit").length, 1);
 const offered = ctl.requests.find(r => r.op === "submit")!.images as unknown[];
 assert.equal(offered.length, 2);
 // The generic control fixture predates image receipts. Model the real control's count on its retained record.
 Object.assign(ctl.submissions[0]!, { images: offered.length });
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 const stopped = await browser.req("devbox", "thread.abort", { threadId: "pi:sess-a" });
 const returned = await browser.until<any>(thread, v => v.inbox?.items.some((item: any) => item.id === admitted.submission && item.state === "returned"));
 assert.deepEqual({
  control: (ctl.submissions[0] as any).images,
  stop: stopped.submissions?.find((item: any) => item.submission === admitted.submission)?.images,
  queue: returned.inbox.items.find((item: any) => item.id === admitted.submission)?.images,
 }, { control: 2, stop: 2, queue: 2 }, "every projection must preserve the image-loss evidence");
});
