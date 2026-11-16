import * as cloudflareWorkers from "cloudflare:workers";
import { Cause, Exit, Option, Predicate, Tracer } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";

type CloudflareSpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
};

type CloudflareSpan = {
  readonly isTraced: boolean;
  readonly setAttribute: (key: string, value: boolean | number | string) => unknown;
  readonly setAttributes?: (
    attributes: Record<string, boolean | number | string | undefined>,
  ) => unknown;
  readonly recordException?: (exception: Error) => void;
  readonly spanContext?: () => CloudflareSpanContext;
  readonly setStatus?: (status: {
    readonly code: "unset" | "ok" | "error";
    readonly message?: string;
  }) => unknown;
  readonly end: () => void;
};

type CloudflareAttribute = boolean | number | string;

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];

export type StartActiveSpan = <A>(name: string, callback: (span: CloudflareSpan) => A) => A;
export type RunInAsyncContext = <A>(callback: () => A) => A;
export type CaptureAsyncContext = () => RunInAsyncContext;
export type SerializeAttribute = (value: unknown, key: string) => CloudflareAttribute | undefined;

export type CloudflareTracerOptions = {
  /**
   * A tracer that owns the Effect spans, such as `SentryEffectTracer` from `@sentry/effect`.
   * Its spans keep their IDs and sampling decisions, and Cloudflare spans mirror them.
   */
  readonly delegate?: Tracer.Tracer | undefined;
  /**
   * Converts an attribute value that is not a string, number, or boolean into a value that Cloudflare accepts.
   * Return `undefined` to leave the attribute off the Cloudflare span.
   */
  readonly serializeAttribute?: SerializeAttribute | undefined;
};

type SpanState = {
  readonly isTraced: boolean;
  readonly runInAsyncContext: RunInAsyncContext;
};

const startActiveSpan: StartActiveSpan | undefined =
  typeof cloudflareWorkers.tracing?.startActiveSpan === "function"
    ? (name, callback) => cloudflareWorkers.tracing.startActiveSpan(name, callback)
    : undefined;
// Workers snapshots include the runtime's active tracing span, not only user AsyncLocalStorage values.
const captureAsyncContext: CaptureAsyncContext = () => AsyncLocalStorage.snapshot();

const toCloudflareAttribute = (
  key: string,
  value: unknown,
  serializeAttribute: SerializeAttribute | undefined,
): CloudflareAttribute | undefined =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? value
    : serializeAttribute?.(value, key);

const setCloudflareAttribute = (
  cloudflareSpan: CloudflareSpan,
  key: string,
  value: unknown,
  serializeAttribute: SerializeAttribute | undefined,
): void => {
  const attribute = toCloudflareAttribute(key, value, serializeAttribute);
  if (attribute !== undefined) cloudflareSpan.setAttribute(key, attribute);
};

const effectAttributes = (span: Tracer.Span) => ({
  "scope.name": "effect",
  "effect.trace.id": span.traceId,
  "effect.span.id": span.spanId,
  "effect.span.kind": span.kind,
  "effect.parent.span.id": Option.getOrUndefined(span.parent)?.spanId,
});

const setInitialAttributes = (
  cloudflareSpan: CloudflareSpan,
  attributes: Record<string, CloudflareAttribute | undefined>,
): void => {
  if (typeof cloudflareSpan.setAttributes === "function") {
    cloudflareSpan.setAttributes(attributes);
  } else {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) cloudflareSpan.setAttribute(key, value);
    }
  }
};

// Always ends the Cloudflare span, even when recording the outcome throws.
const endCloudflareSpan = (cloudflareSpan: CloudflareSpan, exit: Exit.Exit<unknown, unknown>) => {
  try {
    cloudflareSpan.setAttribute(
      "effect.exit",
      Exit.isSuccess(exit)
        ? "success"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    );
    if (Exit.isFailure(exit) && cloudflareSpan.isTraced) {
      if (!Cause.hasInterruptsOnly(exit.cause) && typeof cloudflareSpan.setStatus === "function") {
        cloudflareSpan.setStatus({ code: "error" });
      }
      for (const reason of exit.cause.reasons) {
        const error = Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined;
        if (error instanceof Error && typeof cloudflareSpan.recordException === "function") {
          cloudflareSpan.recordException(error);
        }
      }
    }
  } finally {
    cloudflareSpan.end();
  }
};

class CloudflareEffectSpan extends Tracer.NativeSpan {
  private readonly cloudflareContext: CloudflareSpanContext | undefined;

  constructor(
    options: SpanOptions,
    readonly cloudflareSpan?: CloudflareSpan,
    private readonly serializeAttribute?: SerializeAttribute,
  ) {
    super({
      ...options,
      sampled: options.sampled && (cloudflareSpan?.isTraced ?? false),
    });

    const context =
      typeof cloudflareSpan?.spanContext === "function" ? cloudflareSpan.spanContext() : undefined;
    this.cloudflareContext =
      context !== undefined &&
      context.traceId !== "00000000000000000000000000000000" &&
      context.spanId !== "0000000000000000"
        ? context
        : undefined;

    const attributes = effectAttributes(this);
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) super.attribute(key, value);
    }
    if (this.cloudflareSpan !== undefined) setInitialAttributes(this.cloudflareSpan, attributes);
  }

  override get traceId(): string {
    return this.cloudflareContext?.traceId ?? super.traceId;
  }

  override get spanId(): string {
    return this.cloudflareContext?.spanId ?? super.spanId;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") {
      return;
    }

    super.end(endTime, exit);
    if (this.cloudflareSpan !== undefined) endCloudflareSpan(this.cloudflareSpan, exit);
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    if (this.cloudflareSpan !== undefined) {
      setCloudflareAttribute(this.cloudflareSpan, key, value, this.serializeAttribute);
    }
  }
}

// Returns the delegate's span itself, because the delegate may identify its own spans when they become parents.
const mirrorDelegateSpan = (
  span: Tracer.Span,
  cloudflareSpan: CloudflareSpan,
  serializeAttribute: SerializeAttribute | undefined,
): Tracer.Span => {
  setInitialAttributes(cloudflareSpan, effectAttributes(span));

  const delegateAttribute = span.attribute.bind(span);
  span.attribute = (key, value) => {
    delegateAttribute(key, value);
    setCloudflareAttribute(cloudflareSpan, key, value, serializeAttribute);
  };

  const delegateEnd = span.end.bind(span);
  span.end = (endTime, exit) => {
    if (span.status._tag === "Ended") {
      return;
    }

    try {
      delegateEnd(endTime, exit);
    } finally {
      endCloudflareSpan(cloudflareSpan, exit);
    }
  };

  return span;
};

export const makeTracer = (
  startSpan: StartActiveSpan | undefined,
  captureContext: CaptureAsyncContext = captureAsyncContext,
  options: CloudflareTracerOptions = {},
): Tracer.Tracer => {
  const { delegate, serializeAttribute } = options;
  const invocationContext = captureContext();
  const spanStates = new WeakMap<Tracer.Span, SpanState>();
  let activeState: SpanState | undefined;
  const stateFor = (span: Tracer.AnySpan | undefined): SpanState | undefined => {
    while (span?._tag === "Span") {
      const state = spanStates.get(span);
      if (state !== undefined) {
        return state;
      }
      span = Option.getOrUndefined(span.parent);
    }
    return undefined;
  };

  return Tracer.make({
    span(spanOptions) {
      const parentState = spanOptions.root
        ? undefined
        : stateFor(Option.getOrUndefined(spanOptions.parent));
      const parentContext = parentState?.runInAsyncContext ?? invocationContext;

      // A delegate keeps its own sampling, so an untraced Cloudflare parent is checked here too.
      if (!spanOptions.sampled || startSpan === undefined || parentState?.isTraced === false) {
        const span =
          delegate === undefined
            ? new CloudflareEffectSpan(spanOptions, undefined, serializeAttribute)
            : delegate.span(spanOptions);
        spanStates.set(span, { isTraced: false, runInAsyncContext: parentContext });
        return span;
      }

      const start = () =>
        startSpan(spanOptions.name, (cloudflareSpan) => {
          const span =
            delegate === undefined
              ? new CloudflareEffectSpan(spanOptions, cloudflareSpan, serializeAttribute)
              : mirrorDelegateSpan(delegate.span(spanOptions), cloudflareSpan, serializeAttribute);
          spanStates.set(span, {
            isTraced: cloudflareSpan.isTraced,
            runInAsyncContext: captureContext(),
          });
          return span;
        });
      return parentState === activeState ? start() : parentContext(start);
    },
    context(primitive, fiber) {
      const state = stateFor(fiber.cache.span);
      const evaluate = () =>
        delegate?.context === undefined
          ? primitive["~effect/Effect/evaluate"](fiber)
          : delegate.context(primitive, fiber);
      if (state !== undefined && state === activeState) {
        return evaluate();
      }
      const runInAsyncContext = state?.runInAsyncContext ?? invocationContext;
      return runInAsyncContext(() => {
        const previousState = activeState;
        activeState = state;
        try {
          return evaluate();
        } finally {
          activeState = previousState;
        }
      });
    },
  });
};

export const makeCloudflareTracer = (options?: CloudflareTracerOptions): Tracer.Tracer =>
  makeTracer(startActiveSpan, captureAsyncContext, options);
