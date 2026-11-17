---
"cloudflare-effect-tracer": minor
---

Add a `delegate` option to mirror another Effect tracer, such as Sentry's, into Cloudflare spans, and a
`serializeAttribute` option to forward attribute values that are not strings, numbers, or booleans.
Always end the Cloudflare span, even when recording the outcome or ending the delegate's span throws.
