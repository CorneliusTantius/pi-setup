import test from "node:test";
import assert from "node:assert/strict";
import piRetry from "../extensions/pi-retry.ts";

test("stall abort requests one supported pre-settlement continuation", () => {
  const handlers = new Map();
  const timers = [];
  const statuses = [];
  let aborts = 0;
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    abort() { aborts++; },
  };
  const ctx = { ui: { setStatus: (...args) => statuses.push(args) } };
  piRetry(pi);

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = () => {};

  try {
    handlers.get("agent_start")({}, ctx);
    handlers.get("before_provider_request")();
    timers.at(-1).callback();
    assert.equal(aborts, 1);

    const first = handlers.get("agent_before_settle")({ outcome: "aborted" }, ctx);
    assert.deepEqual(first, { continue: true });

    handlers.get("before_provider_request")();
    timers.at(-1).callback();
    assert.equal(aborts, 2);
    assert.equal(handlers.get("agent_before_settle")({ outcome: "aborted" }, ctx), undefined);

    handlers.get("agent_settled")({}, ctx);
    handlers.get("before_provider_request")();
    timers.at(-1).callback();
    assert.deepEqual(handlers.get("agent_before_settle")({ outcome: "aborted" }, ctx), { continue: true });
    assert.ok(statuses.some(([, status]) => status?.includes("[stall-retry] retrying")));
    assert.equal(handlers.get("agent_end")({}, ctx), undefined);
    handlers.get("agent_settled")({}, ctx);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("a new agent run discards an unconsumed stall retry", () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    abort() {},
  };
  piRetry(pi);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let callback;
  globalThis.setTimeout = (fn) => { callback = fn; return {}; };
  globalThis.clearTimeout = () => {};
  try {
    handlers.get("before_provider_request")();
    callback();
    const ctx = { ui: { setStatus() {} } };
    handlers.get("agent_start")({}, ctx);
    assert.equal(handlers.get("agent_before_settle")({ outcome: "aborted" }, ctx), undefined);
    handlers.get("agent_settled")({}, ctx);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("stall abort does not continue a non-aborted outcome", () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    abort() {},
  };
  piRetry(pi);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let callback;
  globalThis.setTimeout = (fn) => { callback = fn; return {}; };
  globalThis.clearTimeout = () => {};
  try {
    handlers.get("before_provider_request")();
    callback();
    assert.equal(handlers.get("agent_before_settle")({ outcome: "completed" }, { ui: { setStatus() {} } }), undefined);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
