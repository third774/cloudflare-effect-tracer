# cloudflare-effect-tracer

## 0.3.0

### Minor Changes

- 51631b1: Add a `delegate` option to mirror another Effect tracer, such as Sentry's, into Cloudflare spans, and a
  `serializeAttribute` option to forward attribute values that are not strings, numbers, or booleans.
  Always end the Cloudflare span, even when recording the outcome or ending the delegate's span throws.

## 0.2.0

### Minor Changes

- d420f6e: Use Cloudflare trace and span IDs for Effect spans when available, with local IDs as a fallback.
  Set standard error status for failures and defects, and document Effect span attributes and Cloudflare root-span APIs.
