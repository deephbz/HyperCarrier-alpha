# Trace Viewer

Trace Viewer opens one exact local Pi Session. It shows that Session's active
branch, lets the owner inspect typed records, and downloads the exact source
JSONL. It does not scan or display a fleet.

```bash
npm start       # Trace Viewer at http://127.0.0.1:4319
npm test
npm run build
npm run start:tps  # optional per-Session pi-tps-web adapter at :4320
```

The Pi extension in `pi/view-trace.mjs` registers `/view-trace`. It opens
`/session/<current-session-id>` on the loopback Trace Viewer. The server exposes
`pi-trace/2` at `/api/trace/<id>`, exact raw JSONL at `/raw/<id>`, and SSE
invalidations at `/api/events/<id>`. Pi JSONL stays the evidence source.

The TPS adapter accepts a Session ID in the query string or referrer. It serves
that Session's telemetry, source version, and change events. It can serve the
pinned `pi-tps-web` build when `PI_TPS_WEB_DIST` points to its `dist` directory.
The external source and artifact contract live in
[`integrations/pi-tps-web.json`](integrations/pi-tps-web.json). The adapter works
without that renderer and reports its absence through `/api/health`.

Both servers bind to `127.0.0.1`. `PI_LIVE_DETAIL_PORT` and
`PI_TPS_ADAPTER_PORT` select their ports. The Session source defaults to
`~/.pi/agent/sessions`.

The trace contract and source rules are in
[`docs/SESSION-DETAIL-COMPOSITION.md`](docs/SESSION-DETAIL-COMPOSITION.md).
The UI retains the upstream interaction attribution in
[`UPSTREAM-NOTICE.md`](UPSTREAM-NOTICE.md).
