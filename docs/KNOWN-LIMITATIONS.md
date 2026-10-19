# Known limitations

- Node.js 22.19 or newer is required.
- AmPi is an experimental midway snapshot with live Herdr integration paths.
  Full UX acceptance remains open.
- Arc cache, boundary, model, command, and performance work remains open in
  AmPi.
- AmPi's pi-durable node backend remains deferred. Its current live Session
  path uses the Pi backend.
- Live Session discovery depends on the local operating system, Pi, and
  optional Herdr configuration. Remote access also depends on SSH setup.
- Trace Viewer shows evidence present in Pi Session JSONL. It cannot recover
  request timing, stream chunks, call-time tool schemas, or information the
  source Session did not record.
- The application schemas, HTTP interfaces, and UI are Alpha contracts. They
  may change without migration guarantees.
- Rarebit model synthesis sends selected user and assistant text to the
  configured provider. Leave synthesis disabled for sensitive Sessions or use
  a trusted local provider.
