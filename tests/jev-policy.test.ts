import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevPolicy } from "../scripts/jev-policy";
import type {
  SolverState,
  SurfaceCell,
} from "../src/experiments/solver-contracts";

const ACTION_KEYS = Array.from({ length: 5 }, (_, lane) =>
  Array.from(
    { length: 4 },
    (_, waitQuarters) => `lane${lane}_wait${waitQuarters}`,
  ),
).flat();

function cell(count: number): SurfaceCell {
  return { count, meanHeight: count ? 0.2 : null, meanForwardSpeed: 0 };
}

function observedState(): SolverState {
  return {
    board: {
      time: 12,
      sampleSeconds: 0.25,
      phase: 0.5,
      period: 2.4,
      pusherFront: -1,
      shelfFront: 4.2,
      active: 100,
      airborne: 0,
      falling: 0,
      lanes: Array.from({ length: 5 }, (_, index) => ({
        index,
        aimX: -4 + index * 2,
        upper: cell(3),
        lowerRear: cell(5),
        lowerMiddle: cell(6),
        lowerFront: cell(4),
        nearEdge: 2,
        edgeGap: 0.3,
        recentCollected: 0,
      })),
    },
    releaseCoins: 2,
    feed: "chute",
    recent: [],
  };
}

function probabilities(): Record<string, number> {
  return Object.fromEntries(ACTION_KEYS.map((key) => [key, 0.05]));
}

function jevPayload(action: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: { action },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function jsonFetch(payload: unknown): typeof fetch {
  return async () => Response.json(payload);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createJevPolicy", () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid request cap %s before creating a policy",
    (maxRequests) => {
      expect(() =>
        createJevPolicy({ apiKey: "test-key", maxRequests }),
      ).toThrow(/positive safe integer/);
    },
  );

  it("rejects a missing key before any request", () => {
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      return new Response(null, { status: 500 });
    };

    expect(() =>
      createJevPolicy({ apiKey: " ", maxRequests: 1, fetchImpl }),
    ).toThrow(/TYPESAFE_API_KEY/);
    expect(requests).toBe(0);
  });

  it("charges an HTTP failure against the request budget", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      return new Response(null, { status: 401 });
    };
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl,
    });

    await expect(policy(observedState())).rejects.toThrow(/HTTP 401/);
    await expect(policy(observedState())).rejects.toThrow(/budget exhausted/);
    expect(requests).toBe(1);
  });

  it("reports a network failure without retrying it", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      throw new TypeError("socket failure");
    };
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 2,
      fetchImpl,
    });

    await expect(policy(observedState())).rejects.toThrow(
      /network request failed/,
    );
    expect(requests).toBe(1);
  });

  it("rejects an unreadable JSON response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl,
    });

    await expect(policy(observedState())).rejects.toThrow(/body is not JSON/);
  });

  it("rejects missing and unknown action alternatives", async () => {
    const missing = probabilities();
    delete missing[ACTION_KEYS[0]!];
    const unknown = probabilities();
    delete unknown[ACTION_KEYS[0]!];
    unknown.unexpected = 0.05;

    for (const distribution of [missing, unknown]) {
      const policy = createJevPolicy({
        apiKey: "test-key",
        maxRequests: 1,
        fetchImpl: jsonFetch(
          jevPayload({
            type: "choice",
            choice: "lane0_wait0",
            probabilities: distribution,
          }),
        ),
      });
      await expect(policy(observedState())).rejects.toThrow(
        /alternatives do not match/,
      );
    }
  });

  it.each([
    ["unknown choice", "not_an_action", probabilities()],
    [
      "negative probability",
      "lane0_wait0",
      { ...probabilities(), lane0_wait0: -0.01, lane0_wait1: 0.11 },
    ],
    ["invalid sum", "lane0_wait0", { ...probabilities(), lane0_wait0: 0.5 }],
  ])("rejects %s", async (_case, choice, distribution) => {
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl: jsonFetch(
        jevPayload({ type: "choice", choice, probabilities: distribution }),
      ),
    });

    await expect(policy(observedState())).rejects.toThrow(
      /Invalid Jev response/,
    );
  });

  it("aborts a request at the fixed timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl,
    });

    const rejection = expect(policy(observedState())).rejects.toThrow(
      /timed out after 10000 milliseconds/,
    );
    await Promise.all([rejection, vi.advanceTimersByTimeAsync(10_000)]);
  });

  it("keeps the timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
      );
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl,
    });
    const rejection = expect(policy(observedState())).rejects.toThrow(
      /timed out after 10000 milliseconds/,
    );
    await Promise.all([rejection, vi.advanceTimersByTimeAsync(10_000)]);
  });
  it("describes the actual flank centers and release layout", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        jevPayload({
          probabilities: probabilities(),
          type: "choice",
          choice: "lane2_wait0",
        }),
      );
    };
    const policy = createJevPolicy({
      apiKey: "test-key",
      maxRequests: 1,
      fetchImpl,
    });
    const state = {
      ...observedState(),
      releaseCoins: 3,
      pattern: "flanks" as const,
      candidateAimXs: [-2.9, -1.45, 0, 1.45, 2.9],
      enemyCoins: 3,
      spacing: 1.5,
    };

    await policy(state);

    expect(requestBody?.state).toContain(
      '"candidateCenterXs":[-2.9,-1.45,0,1.45,2.9]',
    );
    expect(requestBody?.state).toContain('"flankCoins":3');
    const questions = requestBody?.questions as {
      action: { criteria: Record<string, string> };
    };
    expect(questions.action.criteria.lane2_wait0).toContain(
      "chute positions -1.5, 0, 1.5",
    );
  });
});
