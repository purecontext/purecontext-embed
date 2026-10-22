export interface Embedder {
  embed(text: string): Promise<Float32Array>
}

export type ModelLoader = (dir: string) => Promise<Embedder>

// fastembed is imported on first load, so a process that only uses the client
// never brings in the ONNX runtime.
export const loadFastembed: ModelLoader = async (dir) => {
  const { EmbeddingModel, FlagEmbedding } = await import('fastembed')
  const model = await FlagEmbedding.init({
    model: EmbeddingModel.CUSTOM,
    modelAbsoluteDirPath: dir,
    modelName: 'model.onnx',
    showDownloadProgress: false,
  })
  // fastembed pads every input to 512 tokens, so a ten-word text costs as much
  // as a full chunk. Unpadded vectors are the same; without padding a batch's
  // rows differ in length, so texts go in one at a time.
  ;(model as unknown as { tokenizer: { disablePadding(): void } }).tokenizer.disablePadding()
  return {
    async embed(text) {
      for await (const batch of model.embed([text], 1)) {
        const vector = batch[0]
        if (vector) return Float32Array.from(vector)
      }
      throw new Error('the model returned no vector')
    },
  }
}
