// Dev harness: build the app and listen on a fixed port so the conformance runner can be pointed at it.
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? '8181');
createApp().listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] listening on ${port}\n`);
});
