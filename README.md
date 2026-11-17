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
    "traces": { "enabled": true },
  },
}
```

Then create the tracer for each request and provide it to the Effect that handles the request.

```ts
import { Effect, Tracer } from "effect";
import { makeCloudflareTracer } from "cloudflare-effect-tracer";

export default {
  fetch() {
    const program = Effect.succeed(new Response("ok")).pipe(Effect.withSpan("request"));

    return Effect.runPromise(
      program.pipe(Effect.provideService(Tracer.Tracer, makeCloudflareTracer())),
    );
  },
};
```

Spans created with `Effect.withSpan` become child spans of the active Cloudflare Workers trace.
When `spanContext()` is available and returns non-zero IDs, Effect spans use Cloudflare's trace and span IDs.
IDs read through `Effect.currentSpan` then match Workers Observability and exported traces. Otherwise, the
tracer uses local Effect IDs. A non-zero ID does not guarantee that a trace was sampled or stored.

The tracer records `Error` failures and defects as exception events before each span ends. It does not record
non-`Error` failures or interruptions as exceptions. Cloudflare exports the error name, message, and stack,
so do not put secrets in errors that you send to tracing.

When `setStatus()` is available, failures and defects also set the span status to `error`, including non-`Error`
failures. The tracer does not add failure values to the status message. Success and interruption-only exits
leave the status unchanged. The `effect.exit` attribute records `success`, `failure`, or `interrupted` for all
Cloudflare spans. Span status is included in OpenTelemetry exports, but the Workers Observability dashboard
does not yet display it or support filtering by it.

## Span attributes

Use Effect's tracing APIs to add attributes. With the tracer provided as shown above, these attributes are
forwarded to Cloudflare:

```ts
import { Effect } from "effect";

const program = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan("user.plan", "enterprise");
  return new Response("ok");
}).pipe(
  Effect.withSpan("request", {
    attributes: { "http.request.method": "GET" },
  }),
);
```

- `Effect.annotateCurrentSpan(key, value)` updates the current Effect span. It also accepts an object with
  multiple attributes. If no Effect span is active, it does nothing.
- `Effect.withSpan(name, { attributes: ... })` sets initial attributes on the new span.
- `Effect.annotateSpans(...)` supplies attributes to spans created within its scope.

The tracer forwards string, number, and boolean values to Cloudflare. Other values remain local to Effect,
unless you pass `serializeAttribute` to convert them:

```ts
makeCloudflareTracer({
  serializeAttribute: (value: unknown, key: string) =>
    key.startsWith("app.") ? JSON.stringify(value) : undefined,
});
```

`serializeAttribute` receives the attribute value and its key, and returns a string, number, boolean, or
`undefined`. Return `undefined`, or throw, to leave the attribute off the Cloudflare span. Effect still keeps
the original value. These APIs do not annotate the invocation's root span; use the Workers API below for that.

## Use with another tracer

Effect uses one tracer at a time. To send Effect spans to another tracer as well as to Cloudflare, pass that
tracer as `delegate`. For example, with Sentry:

```ts
import { SentryEffectTracer } from "@sentry/effect";
import { makeCloudflareTracer } from "cloudflare-effect-tracer";
import { Effect, Tracer } from "effect";

program.pipe(
  Effect.provideService(Tracer.Tracer, makeCloudflareTracer({ delegate: SentryEffectTracer })),
);
```

With a delegate:

- The delegate creates and owns each Effect span. `Effect.currentSpan` returns the delegate's span, with its
  trace and span IDs. The `effect.*` ID attributes on the Cloudflare span hold the delegate's IDs, so you can
  look up the same span in both systems.
- Each sampled Effect span still gets a Cloudflare span with the same nesting, attributes, exit, status, and
  exceptions.
- The delegate keeps its own sampling decision. Effect passes the delegate span's `sampled` value to its
  children, so spans below a span the delegate does not sample get no Cloudflare spans. When Cloudflare reports
  that a span is not traced, its descendants get no Cloudflare spans, but the delegate still receives them.
- The delegate's `context` hook, if it has one, runs inside the restored Cloudflare context. Delegates that
  restore their own active span when a fiber resumes, such as Sentry, keep doing so.
- If the delegate throws while ending a span, the Cloudflare span still ends.
- The delegate must return a new span for each call. A span that is already ended gets no Cloudflare span.
  Returning a span again throws an error to prevent use of the first span's async context.

## Compatibility

The `setAttributes` and `recordException` span APIs require a Workers compatibility date of `2026-09-25` or
later. The tracer detects each API at runtime: on earlier compatibility dates, it writes its initial attributes
with `setAttribute` and skips exception events. `startActiveSpan` is also checked, so the tracer continues with
unsampled local spans when custom tracing is unavailable.

The tracer checks `spanContext` and `setStatus` at runtime too. If either API is unavailable, it uses local IDs
or skips status updates, respectively. It does not use `traceFlags` to determine sampling or build downstream
`traceparent` headers: Cloudflare's flags do not currently reflect sampling.

The tracer uses `startActiveSpan` to keep Effect child spans and Worker operations under their correct parent.
`startSpan` does not make a span active and cannot replace it.

## Root span attributes

To add attributes to the invocation's root span, use the Workers tracing API inside the request handler,
before entering a custom span. Check for `getActiveSpan` first when your Worker may use an earlier
compatibility date:

```ts
import { tracing } from "cloudflare:workers";

const root = typeof tracing.getActiveSpan === "function" ? tracing.getActiveSpan() : undefined;
root?.setAttribute("user.plan", "enterprise");
```

`getActiveSpan` also requires compatibility date `2026-09-25` or later. If your Worker types do not include it,
update `@cloudflare/workers-types` to version `5.20260925.1` or later before using this helper.

## Root span names

To name the invocation's root span after a matched route, call `updateName` before running the Effect program,
while no custom span is active. Use the route pattern, such as `GET /users/:id`, rather than a URL with user IDs.
This requires Worker types that include `updateName`; update `@cloudflare/workers-types` if needed.

```ts
import { tracing } from "cloudflare:workers";

const root = typeof tracing.getActiveSpan === "function" ? tracing.getActiveSpan() : undefined;
if (typeof root?.updateName === "function") {
  root.updateName("GET /users/:id");
}
```

This code must run inside the request handler, after the route is matched. The runtime check lets it skip
renaming on older runtimes.
