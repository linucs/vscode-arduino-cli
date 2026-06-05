import * as assert from "assert";
import { applyBuildMessage, type BuildStreamSinks } from "../buildStream";
import type { BuildStreamResponse } from "../proto/types";

function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  const progress: number[] = [];
  const s: BuildStreamSinks = {
    out: (c) => out.push(c),
    err: (c) => err.push(c),
    progress: (t) => progress.push(t.percent),
  };
  return { s, out, err, progress };
}

suite("applyBuildMessage", () => {
  test("decodes out_stream / err_stream Buffers as UTF-8", () => {
    const { s, out, err } = sinks();
    applyBuildMessage(
      { message: "out_stream", out_stream: Buffer.from("hello") } as BuildStreamResponse,
      s,
    );
    applyBuildMessage(
      { message: "err_stream", err_stream: Buffer.from("oops") } as BuildStreamResponse,
      s,
    );
    assert.deepStrictEqual(out, ["hello"]);
    assert.deepStrictEqual(err, ["oops"]);
  });

  test("an empty (falsy-but-present) out_stream Buffer still routes to out", () => {
    const { s, out } = sinks();
    const r = applyBuildMessage(
      { message: "out_stream", out_stream: Buffer.alloc(0) } as BuildStreamResponse,
      s,
    );
    assert.strictEqual(r, undefined);
    assert.deepStrictEqual(out, [""]);
  });

  test("reports progress and returns no result", () => {
    const { s, progress } = sinks();
    const r = applyBuildMessage(
      {
        message: "progress",
        progress: { name: "x", message: "", completed: false, percent: 42 },
      } as BuildStreamResponse,
      s,
    );
    assert.strictEqual(r, undefined);
    assert.deepStrictEqual(progress, [42]);
  });

  test("returns the result payload on the result branch", () => {
    const { s } = sinks();
    const result = { build_path: "/tmp/b", diagnostics: [] };
    const r = applyBuildMessage(
      { message: "result", result } as BuildStreamResponse,
      s,
    );
    assert.deepStrictEqual(r, result);
  });
});
