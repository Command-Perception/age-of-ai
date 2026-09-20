import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { SileroV5 } from "@ricky0123/vad-web/dist/models/v5";

/** AudioWorklet owns resampling/capture; serialize recurrent model inference. */
export const createSpeechCapture = async (options: {
  readonly signal?: AbortSignal;
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly onFrame: (samples: Float32Array, probability: number) => void;
  readonly onError: (error: Error) => void;
}) => {
  ort.env.wasm.wasmPaths = { wasm: wasmUrl };
  ort.env.wasm.numThreads = 1;
  const model = await SileroV5.new(ort, async () => {
    const response = await fetch("/vad/silero_vad_v5.onnx", options.signal ? { signal: options.signal } : {});
    if (!response.ok) throw new Error("Could not load speech detector");
    return response.arrayBuffer();
  });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  let pending = 0;
  let processing = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    if (node) { node.port.onmessage = null; node.port.postMessage("SPEECH_STOP"); node.port.close(); node.disconnect(); }
    source?.disconnect();
    void processing.finally(() => model.release()).catch(() => undefined);
  };
  try {
    await options.context.audioWorklet.addModule("/vad/vad.worklet.bundle.min.js");
    node = new AudioWorkletNode(options.context, "vad-helper-worklet", { processorOptions: { frameSamples: 512 } });
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (closed) return;
      const value = event.data;
      if (typeof value !== "object" || value === null || !("data" in value) || !(value.data instanceof ArrayBuffer)) return;
      if (++pending > 32) {
        close();
        options.onError(new Error("Speech detection fell behind microphone capture. Please restart the conversation."));
        return;
      }
      const frame = new Float32Array(value.data);
      processing = processing.then(async () => {
        if (closed) return;
        const probabilities = await model.process(frame);
        if (!closed) options.onFrame(frame, probabilities.isSpeech);
      }).catch(() => {
        close();
        options.onError(new Error("Speech detection failed. Please restart the conversation."));
      }).finally(() => { pending--; });
    };
    source = options.context.createMediaStreamSource(options.stream);
    source.connect(node);
    node.connect(options.context.destination);
    return { close };
  } catch (error) { close(); throw error; }
};
