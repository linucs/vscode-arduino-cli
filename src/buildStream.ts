import type {
  BuilderResult,
  BuildStreamResponse,
  TaskProgress,
  UploadResult,
} from "./proto/types";

/** Sinks for the Compile/Upload `out_stream | err_stream | progress | result` oneof. */
export interface BuildStreamSinks {
  out: (chunk: string) => void;
  err: (chunk: string) => void;
  progress?: (task: TaskProgress) => void;
}

/**
 * Demux one Compile/Upload stream message. Branches on the `message`
 * discriminator (oneofs:true), not truthiness — empty Buffers are
 * falsy-but-present. Returns the `result` payload on the final message,
 * otherwise undefined.
 *
 * Pure and grpc-free so it can be unit-tested against canned messages.
 */
export function applyBuildMessage<R = BuilderResult | UploadResult>(
  msg: BuildStreamResponse,
  sinks: BuildStreamSinks,
): R | undefined {
  switch (msg.message) {
    case "out_stream":
      sinks.out(Buffer.from(msg.out_stream ?? []).toString("utf8"));
      return undefined;
    case "err_stream":
      sinks.err(Buffer.from(msg.err_stream ?? []).toString("utf8"));
      return undefined;
    case "progress":
      if (msg.progress) {
        sinks.progress?.(msg.progress);
      }
      return undefined;
    case "result":
      return msg.result as unknown as R;
    default:
      return undefined;
  }
}
