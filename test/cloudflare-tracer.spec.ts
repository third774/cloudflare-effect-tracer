import { Context, Data, Effect, Exit, Fiber, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CaptureAsyncContext,
  type CloudflareTracerOptions,
  makeTracer,
  type RunInAsyncContext,
  type StartActiveSpan,
} from "../src/index";

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly message: string }> {}

type CloudflareSpan = Parameters<Parameters<StartActiveSpan>[1]>[0];
type SpanContext = ReturnType<NonNullable<CloudflareSpan["spanContext"]>>;
type SpanStatus = Parameters<NonNullable<CloudflareSpan["setStatus"]>>[0];

type RecordedSpan = {
  readonly name: string;
  readonly parent: RecordedSpan | undefined;
  readonly attributes: Map<string, boolean | number | string>;
  readonly exceptions: Error[];
  readonly context: SpanContext;
  readonly statuses: SpanStatus[];
  ended: boolean;
};

const makeRecorder = (
  isTraced: (name: string) => boolean = () => true,
  supportsExceptions = true,
  supportsBulkAttributes = true,
  options: {
    readonly supportsSpanContext?: boolean;
    readonly supportsStatus?: boolean;
    readonly spanContext?: (index: number) => SpanContext;
    readonly statusError?: Error;
    readonly tracerOptions?: CloudflareTracerOptions;
  } = {},
) => {
  const invocation: RecordedSpan = {
    name: "invocation",
    parent: undefined,
    attributes: new Map(),
    exceptions: [],
    context: {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "0000000000000001",
      traceFlags: 0,
    },
    statuses: [],
    ended: false,
  };
  const spans: RecordedSpan[] = [];
  let activeSpan: RecordedSpan | undefined = invocation;
  const startActiveSpan: StartActiveSpan = (name, callback) => {
    const context = options.spanContext?.(spans.length) ?? {
      traceId: invocation.context.traceId,
      spanId: (spans.length + 2).toString(16).padStart(16, "0"),
      traceFlags: 0,
    };
    const recorded: RecordedSpan = {
      name,
      parent: activeSpan,
      attributes: new Map(),
      exceptions: [],
      context,
      statuses: [],
      ended: false,
    };
    spans.push(recorded);

    const previousSpan = activeSpan;
    activeSpan = recorded;
    try {
      return callback({
        isTraced: isTraced(name),
        setAttribute: (key, value) => recorded.attributes.set(key, value),
        ...(supportsBulkAttributes
          ? {
              setAttributes: (
                attributes: Record<string, boolean | number | string | undefined>,
              ) => {
                for (const [key, value] of Object.entries(attributes)) {
                  if (value !== undefined) recorded.attributes.set(key, value);
                }
              },
            }
          : {}),
        ...(supportsExceptions
          ? {
              recordException: (exception: Error) => {
                if (!recorded.ended) recorded.exceptions.push(exception);
              },
            }
          : {}),
        ...(options.supportsSpanContext === false ? {} : { spanContext: () => context }),
        ...(options.supportsStatus === false
          ? {}
          : {
              setStatus: (status: SpanStatus) => {
                expect(recorded.ended).toBe(false);
                if (options.statusError !== undefined) throw options.statusError;
                recorded.statuses.push(status);
              },
            }),
        end: () => {
          recorded.ended = true;
        },
      });
    } finally {
      activeSpan = previousSpan;
    }
  };
  const captureAsyncContext: CaptureAsyncContext = () => {
    const capturedSpan = activeSpan;
    const runInAsyncContext: RunInAsyncContext = (callback) => {
      const previousSpan = activeSpan;
      activeSpan = capturedSpan;
      try {
        return callback();
      } finally {
        activeSpan = previousSpan;
      }
    };
    return runInAsyncContext;
  };

  return {
    invocation,
    spans,
    get activeSpan() {
      return activeSpan;
    },
    tracer: makeTracer(startActiveSpan, captureAsyncContext, options.tracerOptions),
    makeTracer: () => makeTracer(startActiveSpan, captureAsyncContext, options.tracerOptions),
  };
};

const makeDelegate = (options: { readonly endError?: Error } = {}) => {
  const spans: Tracer.NativeSpan[] = [];
  let activeSpan: Tracer.AnySpan | undefined;
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      if (options.endError !== undefined) {
        const endError = options.endError;
        span.end = () => {
          throw endError;
        };
      }
      spans.push(span);
      return span;
    },
    context: (primitive, fiber) => {
      const previousSpan = activeSpan;
      activeSpan = fiber.cache.span;
      try {
        return primitive["~effect/Effect/evaluate"](fiber);
      } finally {
        activeSpan = previousSpan;
      }
    },
  });

  return {
    spans,
    tracer,
    get activeSpan() {
      return activeSpan;
    },
  };
};

const spanOptions = (
  name: string,
  parent: Option.Option<Tracer.AnySpan>,
  root: boolean,
): Parameters<Tracer.Tracer["span"]>[0] => ({
  name,
  parent,
  annotations: Context.empty(),
  links: [],
  startTime: 0n,
  kind: "internal",
  root,
  sampled: true,
});

describe("Cloudflare Effect tracer", () => {
  it("uses Cloudflare IDs for Effect spans and their attributes", () => {
    const recorder = makeRecorder();
    const parent = recorder.tracer.span(spanOptions("parent", Option.none(), true));
    const child = recorder.tracer.span(spanOptions("child", Option.some(parent), false));

    expect(parent.traceId).toBe(recorder.spans[0]?.context.traceId);
    expect(parent.spanId).toBe(recorder.spans[0]?.context.spanId);
    expect(child.traceId).toBe(recorder.spans[1]?.context.traceId);
    expect(child.spanId).toBe(recorder.spans[1]?.context.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(recorder.spans[1]?.attributes.get("effect.trace.id")).toBe(child.traceId);
    expect(recorder.spans[1]?.attributes.get("effect.span.id")).toBe(child.spanId);
    expect(recorder.spans[1]?.attributes.get("effect.parent.span.id")).toBe(parent.spanId);
    expect(child.sampled).toBe(true);

    child.end(1n, Exit.void);
    expect(child.traceId).toBe(recorder.spans[1]?.context.traceId);
    expect(child.spanId).toBe(recorder.spans[1]?.context.spanId);
  });

  it("uses Cloudflare identity even when Effect has an external parent", () => {
    const recorder = makeRecorder();
    const externalParent = Tracer.externalSpan({
      traceId: "external-trace",
      spanId: "external-span",
    });
    const span = recorder.tracer.span(spanOptions("child", Option.some(externalParent), false));

    expect(span.traceId).toBe(recorder.spans[0]?.context.traceId);
    expect(span.spanId).toBe(recorder.spans[0]?.context.spanId);
  });

  it("exposes Cloudflare IDs through Effect.currentSpan", async () => {
    const recorder = makeRecorder();
    const span = await Effect.runPromise(
      Effect.currentSpan.pipe(
        Effect.withSpan("current"),
        Effect.provideService(Tracer.Tracer, recorder.tracer),
      ),
    );

    expect(span.traceId).toBe(recorder.spans[0]?.context.traceId);
    expect(span.spanId).toBe(recorder.spans[0]?.context.spanId);
  });

  it("uses non-zero Cloudflare IDs even when tracing is disabled", () => {
    const recorder = makeRecorder(() => false);
    const span = recorder.tracer.span(spanOptions("logs-only", Option.none(), true));

    expect(span.traceId).toBe(recorder.spans[0]?.context.traceId);
    expect(span.spanId).toBe(recorder.spans[0]?.context.spanId);
    expect(span.sampled).toBe(false);
  });

  it("uses local IDs when the runtime has no span context API", () => {
    const recorder = makeRecorder(() => true, true, true, { supportsSpanContext: false });
    const parent = recorder.tracer.span(spanOptions("parent", Option.none(), true));
    const child = recorder.tracer.span(spanOptions("child", Option.some(parent), false));

    expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parent.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(recorder.spans[1]?.attributes.get("effect.trace.id")).toBe(child.traceId);
    expect(recorder.spans[1]?.attributes.get("effect.span.id")).toBe(child.spanId);
  });

  it.each([
    { traceId: "00000000000000000000000000000000", spanId: "0000000000000000" },
    { traceId: "00000000000000000000000000000000", spanId: "1234567890abcdef" },
    { traceId: "1234567890abcdef1234567890abcdef", spanId: "0000000000000000" },
  ])("uses local IDs when the context has a zero ID: %j", (context) => {
    const recorder = makeRecorder(() => false, true, true, {
      spanContext: () => ({ ...context, traceFlags: 0 }),
    });
    const span = recorder.tracer.span(spanOptions("local", Option.none(), true));

    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.traceId).not.toBe(context.traceId);
    expect(span.spanId).not.toBe(context.spanId);
    expect(recorder.spans[0]?.attributes.get("effect.trace.id")).toBe(span.traceId);
    expect(recorder.spans[0]?.attributes.get("effect.span.id")).toBe(span.spanId);
  });

  it("uses the invocation context for an explicit root", async () => {
    const recorder = makeRecorder();
    const program = Effect.succeed("value").pipe(
      Effect.withSpan("root", { root: true }),
      Effect.withSpan("parent"),
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await expect(Effect.runPromise(program)).resolves.toBe("value");

    const parent = recorder.spans[0];
    const root = recorder.spans[1];
    expect(parent?.parent).toBe(recorder.invocation);
    expect(root?.parent).toBe(recorder.invocation);
    expect(parent?.attributes.get("scope.name")).toBe("effect");
    expect(root?.attributes.get("scope.name")).toBe("effect");
  });

  it("finds the nearest Cloudflare context through a foreign span parent", () => {
    const recorder = makeRecorder();
    const cloudflareParent = recorder.tracer.span(
      spanOptions("cloudflare-parent", Option.none(), true),
    );
    const foreignParent = new Tracer.NativeSpan(
      spanOptions("foreign-parent", Option.some(cloudflareParent), false),
    );

    recorder.tracer.span(spanOptions("child", Option.some(foreignParent), false));

    expect(recorder.spans[1]?.parent).toBe(recorder.spans[0]);
  });

  it("falls back to the invocation context for an external parent", () => {
    const recorder = makeRecorder();
    const externalParent = Tracer.externalSpan({ traceId: "trace", spanId: "span" });

    recorder.tracer.span(spanOptions("child", Option.some(externalParent), false));

    expect(recorder.spans[0]?.parent).toBe(recorder.invocation);
  });

  it("keeps a parent's context when another tracer creates the child", async () => {
    const recorder = makeRecorder();
    const innerTracer = recorder.makeTracer();
    const program = Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.void.pipe(
          Effect.withSpan("child"),
          Effect.provideService(Tracer.Tracer, innerTracer),
        ),
      ),
      Effect.withSpan("parent"),
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await Effect.runPromise(program);

    expect(recorder.spans.map((span) => [span.name, span.parent?.name])).toEqual([
      ["parent", "invocation"],
      ["child", "parent"],
    ]);
  });

  it("cascades an unsampled Cloudflare decision to descendants", async () => {
    const recorder = makeRecorder((name) => name !== "parent");
    const program = Effect.succeed("value").pipe(
      Effect.withSpan("child"),
      Effect.withSpan("parent"),
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await expect(Effect.runPromise(program)).resolves.toBe("value");

    expect(recorder.spans.map((span) => span.name)).toEqual(["parent"]);
  });

  it("continues with unsampled Effect spans when the tracing API is missing", () => {
    const tracer = makeTracer(undefined, () => (callback) => callback());
    const span = tracer.span(spanOptions("local", Option.none(), true));

    expect(span.sampled).toBe(false);
  });

  it("restores nested context after suspended and forked fibers resume", async () => {
    const recorder = makeRecorder();
    const child = Effect.fn("child")(function* () {
      yield* Effect.yieldNow;
      return "value";
    });
    const parent = Effect.fn("parent")(function* () {
      yield* Effect.yieldNow;
      const childFiber = yield* Effect.forkChild(child());
      return yield* Fiber.join(childFiber);
    });

    await expect(
      Effect.runPromise(parent().pipe(Effect.provideService(Tracer.Tracer, recorder.tracer))),
    ).resolves.toBe("value");

    expect(recorder.spans.map((span) => span.name)).toEqual(["parent", "child"]);
    const parentSpan = recorder.spans[0];
    const childSpan = recorder.spans[1];
    expect(childSpan?.parent).toBe(parentSpan);
    expect(childSpan?.attributes.get("effect.parent.span.id")).toBe(
      parentSpan?.attributes.get("effect.span.id"),
    );
    expect(childSpan?.attributes.get("effect.trace.id")).toBe(
      parentSpan?.attributes.get("effect.trace.id"),
    );
  });

  it("records success, interruption, and failure outcomes", async () => {
    const recorder = makeRecorder();
    const program = Effect.all([
      Effect.void.pipe(Effect.withSpan("success")),
      Effect.fail("secret").pipe(Effect.withSpan("failure"), Effect.result),
    ]).pipe(Effect.provideService(Tracer.Tracer, recorder.tracer));

    await Effect.runPromise(program);
    const interruptedFiber = Effect.runFork(
      Effect.interrupt.pipe(
        Effect.withSpan("interrupted"),
        Effect.provideService(Tracer.Tracer, recorder.tracer),
      ),
    );
    await Effect.runPromise(Fiber.await(interruptedFiber));

    const outcomes = new Map(
      recorder.spans.map((span) => [span.name, span.attributes.get("effect.exit")]),
    );
    expect(outcomes).toEqual(
      new Map([
        ["success", "success"],
        ["failure", "failure"],
        ["interrupted", "interrupted"],
      ]),
    );
    expect(recorder.spans.flatMap((span) => [...span.attributes.values()])).not.toContain("secret");
    expect(recorder.spans.flatMap((span) => span.exceptions)).toEqual([]);
    expect(recorder.spans.map((span) => [span.name, span.statuses])).toEqual([
      ["success", []],
      ["failure", [{ code: "error" }]],
      ["interrupted", []],
    ]);
  });

  it("records Error failures and defects as exception events before the span ends", async () => {
    const recorder = makeRecorder();
    const failure = new TestFailure({ message: "failed" });
    const defect = new Error("crashed");

    await Effect.runPromise(
      Effect.all([
        Effect.fail(failure).pipe(Effect.withSpan("failure"), Effect.exit),
        Effect.die(defect).pipe(Effect.withSpan("defect"), Effect.exit),
      ]).pipe(Effect.provideService(Tracer.Tracer, recorder.tracer)),
    );

    expect(recorder.spans.map((span) => [span.name, span.exceptions])).toEqual([
      ["failure", [failure]],
      ["defect", [defect]],
    ]);
    expect(recorder.spans.every((span) => span.ended)).toBe(true);
    expect(recorder.spans.map((span) => span.statuses)).toEqual([
      [{ code: "error" }],
      [{ code: "error" }],
    ]);
  });

  it("records exceptions and ends failed spans when the runtime has no status API", async () => {
    const recorder = makeRecorder(() => true, true, true, { supportsStatus: false });
    const failure = new TestFailure({ message: "failed" });

    await Effect.runPromise(
      Effect.fail(failure).pipe(
        Effect.withSpan("failure"),
        Effect.exit,
        Effect.provideService(Tracer.Tracer, recorder.tracer),
      ),
    );

    expect(recorder.spans[0]?.attributes.get("effect.exit")).toBe("failure");
    expect(recorder.spans[0]?.exceptions).toEqual([failure]);
    expect(recorder.spans[0]?.ended).toBe(true);
  });

  it("sets failure status only once when a span ends more than once", () => {
    const recorder = makeRecorder();
    const span = recorder.tracer.span(spanOptions("failure", Option.none(), true));
    span.end(1n, Exit.fail("secret"));
    span.end(2n, Exit.void);

    expect(recorder.spans[0]?.statuses).toEqual([{ code: "error" }]);
    expect(recorder.spans[0]?.attributes.get("effect.exit")).toBe("failure");
  });

  it("still ends failed spans when the runtime has no exception API", async () => {
    const recorder = makeRecorder(() => true, false);
    const program = Effect.die(new Error("failed")).pipe(
      Effect.withSpan("failure"),
      Effect.exit,
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await Effect.runPromise(program);

    expect(recorder.spans[0]?.attributes.get("effect.exit")).toBe("failure");
    expect(recorder.spans[0]?.ended).toBe(true);
  });

  it("sets initial attributes one at a time when the runtime has no bulk attribute API", () => {
    const recorder = makeRecorder(() => true, true, false);
    const span = recorder.tracer.span(spanOptions("attributes", Option.none(), true));

    expect(recorder.spans[0]?.attributes.get("scope.name")).toBe("effect");
    expect(recorder.spans[0]?.attributes.get("effect.trace.id")).toBe(span.traceId);
    expect(recorder.spans[0]?.attributes.get("effect.span.id")).toBe(span.spanId);
  });

  it("does not record exceptions on unsampled spans", async () => {
    const recorder = makeRecorder(() => false);
    const program = Effect.fail(new TestFailure({ message: "failed" })).pipe(
      Effect.withSpan("unsampled"),
      Effect.exit,
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await Effect.runPromise(program);

    expect(recorder.spans[0]?.exceptions).toEqual([]);
    expect(recorder.spans[0]?.ended).toBe(true);
  });

  it("forwards only Cloudflare scalar attributes", async () => {
    const recorder = makeRecorder();
    const program = Effect.void.pipe(
      Effect.withSpan("attributes", {
        attributes: {
          string: "value",
          number: 1,
          boolean: true,
          bigint: 1n,
          object: { value: true },
          null: null,
        },
      }),
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    await Effect.runPromise(program);

    const attributes = recorder.spans[0]?.attributes;
    expect(attributes?.get("string")).toBe("value");
    expect(attributes?.get("number")).toBe(1);
    expect(attributes?.get("boolean")).toBe(true);
    expect(attributes?.has("bigint")).toBe(false);
    expect(attributes?.has("object")).toBe(false);
    expect(attributes?.has("null")).toBe(false);
  });

  it("forwards serialized attributes and keeps the original values in Effect", async () => {
    const recorder = makeRecorder(() => true, true, true, {
      tracerOptions: {
        serializeAttribute: (value, key) => (key === "object" ? JSON.stringify(value) : undefined),
      },
    });
    const program = Effect.currentSpan.pipe(
      Effect.withSpan("attributes", { attributes: { object: { value: true }, null: null } }),
      Effect.provideService(Tracer.Tracer, recorder.tracer),
    );

    const span = await Effect.runPromise(program);

    expect(recorder.spans[0]?.attributes.get("object")).toBe('{"value":true}');
    expect(recorder.spans[0]?.attributes.has("null")).toBe(false);
    expect(span instanceof Tracer.NativeSpan && span.attributes.get("object")).toEqual({
      value: true,
    });
  });

  it("ends the Cloudflare span when recording the outcome throws", () => {
    const statusError = new Error("status failed");
    const recorder = makeRecorder(() => true, true, true, { statusError });
    const span = recorder.tracer.span(spanOptions("failure", Option.none(), true));

    expect(() => span.end(1n, Exit.fail("secret"))).toThrow(statusError);
    expect(recorder.spans[0]?.ended).toBe(true);
  });

  describe("with a delegate", () => {
    it("mirrors delegate spans across suspended and forked fibers", async () => {
      const delegate = makeDelegate();
      const recorder = makeRecorder(() => true, true, true, {
        tracerOptions: { delegate: delegate.tracer },
      });
      let currentSpan: Tracer.AnySpan | undefined;
      const child = Effect.fn("child")(function* () {
        yield* Effect.yieldNow;
        currentSpan = yield* Effect.currentSpan;
        return "value";
      });
      const parent = Effect.fn("parent")(function* () {
        yield* Effect.yieldNow;
        const childFiber = yield* Effect.forkChild(child());
        return yield* Fiber.join(childFiber);
      });

      await expect(
        Effect.runPromise(
          parent().pipe(
            Effect.withSpan("outer", { attributes: { "app.id": "id" } }),
            Effect.provideService(Tracer.Tracer, recorder.tracer),
          ),
        ),
      ).resolves.toBe("value");

      expect(recorder.spans.map((span) => [span.name, span.parent?.name])).toEqual([
        ["outer", "invocation"],
        ["parent", "outer"],
        ["child", "parent"],
      ]);
      expect(delegate.spans.map((span) => span.name)).toEqual(["outer", "parent", "child"]);
      expect(currentSpan).toBe(delegate.spans[2]);
      for (const [index, span] of recorder.spans.entries()) {
        const delegateSpan = delegate.spans[index];
        expect(span.attributes.get("scope.name")).toBe("effect");
        expect(span.attributes.get("effect.trace.id")).toBe(delegateSpan?.traceId);
        expect(span.attributes.get("effect.span.id")).toBe(delegateSpan?.spanId);
        expect(span.attributes.get("effect.exit")).toBe("success");
        expect(span.ended).toBe(true);
      }
      expect(recorder.spans[0]?.attributes.get("app.id")).toBe("id");
      expect(delegate.spans[0]?.attributes.get("app.id")).toBe("id");
      expect(recorder.activeSpan).toBe(recorder.invocation);
    });

    it("runs the delegate's context hook inside the restored Cloudflare context", async () => {
      const delegate = makeDelegate();
      const recorder = makeRecorder(() => true, true, true, {
        tracerOptions: { delegate: delegate.tracer },
      });
      let observed: [string | undefined, Tracer.AnySpan | undefined] | undefined;
      const program = Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            observed = [recorder.activeSpan?.name, delegate.activeSpan];
          }),
        ),
        Effect.withSpan("span"),
        Effect.provideService(Tracer.Tracer, recorder.tracer),
      );

      await Effect.runPromise(program);

      expect(delegate.spans.map((span) => span.name)).toEqual(["span"]);
      expect(observed).toEqual(["span", delegate.spans[0]]);
    });

    it("keeps delegate sampling when a Cloudflare span is not traced", async () => {
      const delegate = makeDelegate();
      const recorder = makeRecorder((name) => name !== "parent", true, true, {
        tracerOptions: { delegate: delegate.tracer },
      });
      const program = Effect.void.pipe(
        Effect.withSpan("child"),
        Effect.withSpan("parent"),
        Effect.provideService(Tracer.Tracer, recorder.tracer),
      );

      await Effect.runPromise(program);

      expect(recorder.spans.map((span) => span.name)).toEqual(["parent"]);
      expect(delegate.spans.map((span) => [span.name, span.sampled])).toEqual([
        ["parent", true],
        ["child", true],
      ]);
    });

    it("records failures and ends the Cloudflare span when the delegate fails to end", () => {
      const endError = new Error("end failed");
      const delegate = makeDelegate({ endError });
      const recorder = makeRecorder(() => true, true, true, {
        tracerOptions: { delegate: delegate.tracer },
      });
      const failure = new TestFailure({ message: "failed" });
      const span = recorder.tracer.span(spanOptions("failure", Option.none(), true));

      expect(() => span.end(1n, Exit.fail(failure))).toThrow(endError);
      expect(recorder.spans[0]?.attributes.get("effect.exit")).toBe("failure");
      expect(recorder.spans[0]?.statuses).toEqual([{ code: "error" }]);
      expect(recorder.spans[0]?.exceptions).toEqual([failure]);
      expect(recorder.spans[0]?.ended).toBe(true);
    });
  });
});
