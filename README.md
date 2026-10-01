# cloudflare-effect-tracer

Use Cloudflare Workers tracing for Effect spans.

## Install

```bash
npm install cloudflare-effect-tracer
```

## Use

Enable tracing and the Node.js compatibility flag in `wrangler.jsonc`:

```jsonc
{
  "compatibility_date": "2026-09-25",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "traces": { "enabled": true }
  }
}
```

Then create the tracer for each request and provide it to the Effect that handles the request.

```ts
import { Effect, Tracer } from 'effect';
import { makeCloudflareTracer } from 'cloudflare-effect-tracer';

export default {
  fetch() {
    const program = Effect.succeed(new Response('ok')).pipe(Effect.withSpan('request'));

    return Effect.runPromise(program.pipe(Effect.provideService(Tracer.Tracer, makeCloudflareTracer())));
  },
};
```

Spans created with `Effect.withSpan` become child spans of the active Cloudflare Workers trace.
The tracer records `Error` failures and defects as exception events before each span ends. It does not record
non-`Error` failures or interruptions as exceptions. Cloudflare exports the error name, message, and stack,
so do not put secrets in errors that you send to tracing.

## Compatibility

The `setAttributes` and `recordException` span APIs require a Workers compatibility date of `2026-09-25` or
later. The tracer detects each API at runtime: on earlier compatibility dates, it writes its initial attributes
with `setAttribute` and skips exception events. `startActiveSpan` is also checked, so the tracer continues with
unsampled local spans when custom tracing is unavailable.

To add attributes to the active span from a helper, use the Workers tracing API directly. Outside a custom
span, this annotates the request's root span. Check for `getActiveSpan` first when your Worker may use an
earlier compatibility date:

```ts
import { tracing } from 'cloudflare:workers';

const activeSpan = typeof tracing.getActiveSpan === 'function' ? tracing.getActiveSpan() : undefined;
activeSpan?.setAttribute('user.plan', 'enterprise');
```

`getActiveSpan` also requires compatibility date `2026-09-25` or later. If your Worker types do not include it,
update `@cloudflare/workers-types` to version `5.20260925.1` or later before using this helper.

The tracer uses `startActiveSpan` to keep Effect child spans and Worker operations under their correct parent.
`startSpan` does not make a span active and cannot replace it.
