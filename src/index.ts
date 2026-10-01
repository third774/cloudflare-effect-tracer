import * as cloudflareWorkers from "cloudflare:workers";
import { Cause, Exit, Option, Predicate, Tracer } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";

type CloudflareSpan = {
  readonly isTraced: boolean;
  readonly setAttribute: (key: string, value: boolean | number | string) => unknown;
  readonly setAttributes?: (
    attributes: Record<string, boolean | number | string | undefined>,
  ) => unknown;
  readonly recordException?: (exception: Error) => void;
  readonly end: () => void;
};

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];

export type StartActiveSpan = <A>(name: string, callback: (span: CloudflareSpan) => A) => A;
export type RunInAsyncContext = <A>(callback: () => A) => A;
export type CaptureAsyncContext = () => RunInAsyncContext;

const startActiveSpan: StartActiveSpan | undefined =
  typeof cloudflareWorkers.tracing?.startActiveSpan === "function"
    ? (name, callback) => cloudflareWorkers.tracing.startActiveSpan(name, callback)
  : undefined;
// Workers snapshots include the runtime's active tracing span, not only user AsyncLocalStorage values.
const captureAsyncContext: CaptureAsyncContext = () => AsyncLocalStorage.snapshot();

class CloudflareEffectSpan extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly runInAsyncContext: RunInAsyncContext,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    super({
      ...options,
      sampled: options.sampled && (cloudflareSpan?.isTraced ?? false),
    });

    const parent = Option.getOrUndefined(this.parent);
    const attributes = {
      "scope.name": "effect",
      "effect.trace.id": this.traceId,
      "effect.span.id": this.spanId,
      "effect.span.kind": this.kind,
      "effect.parent.span.id": parent?.spanId,
    };
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) super.attribute(key, value);
    }
    if (typeof this.cloudflareSpan?.setAttributes === "function") {
      this.cloudflareSpan.setAttributes(attributes);
    } else {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) this.cloudflareSpan?.setAttribute(key, value);
      }
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") {
      return;
    }

    super.end(endTime, exit);
    this.cloudflareSpan?.setAttribute(
      "effect.exit",
      Exit.isSuccess(exit)
        ? "success"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    );
    if (Exit.isFailure(exit) && this.cloudflareSpan?.isTraced) {
      for (const reason of exit.cause.reasons) {
        const error = Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined;
        if (error instanceof Error) {
          if (typeof this.cloudflareSpan.recordException === "function") {
            this.cloudflareSpan.recordException(error);
          }
        }
      }
    }
    this.cloudflareSpan?.end();
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      this.cloudflareSpan?.setAttribute(key, value);
    }
  }
}

export const makeTracer = (
  startSpan: StartActiveSpan | undefined,
  captureContext: CaptureAsyncContext = captureAsyncContext,
): Tracer.Tracer => {
  const invocationContext = captureContext();
  let activeSpan: CloudflareEffectSpan | undefined;
  const cloudflareSpanFor = (
    span: Tracer.AnySpan | undefined,
  ): CloudflareEffectSpan | undefined => {
    while (span?._tag === "Span") {
      if (span instanceof CloudflareEffectSpan) {
        return span;
      }
      span = Option.getOrUndefined(span.parent);
    }
    return undefined;
  };

  return Tracer.make({
    span(options) {
      const parentSpan = options.root
        ? undefined
        : cloudflareSpanFor(Option.getOrUndefined(options.parent));
      const parentContext = parentSpan?.runInAsyncContext ?? invocationContext;

      if (!options.sampled || startSpan === undefined) {
        return new CloudflareEffectSpan(options, parentContext);
      }

      const start = () =>
        startSpan(
          options.name,
          (span) => new CloudflareEffectSpan(options, captureContext(), span),
        );
      return parentSpan === activeSpan ? start() : parentContext(start);
    },
    context(primitive, fiber) {
      const span = cloudflareSpanFor(fiber.cache.span);
      const evaluate = () => primitive["~effect/Effect/evaluate"](fiber);
      if (span !== undefined && span === activeSpan) {
        return evaluate();
      }
      const runInAsyncContext = span?.runInAsyncContext ?? invocationContext;
      return runInAsyncContext(() => {
        const previousSpan = activeSpan;
        activeSpan = span;
        try {
          return evaluate();
        } finally {
          activeSpan = previousSpan;
        }
      });
    },
  });
};

export const makeCloudflareTracer = (): Tracer.Tracer => makeTracer(startActiveSpan);
