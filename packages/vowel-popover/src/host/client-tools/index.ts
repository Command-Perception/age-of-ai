import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class ClientToolError extends Data.TaggedError("ClientToolError")<{
  readonly message: string
  readonly tool: string
}> {}

interface ClientToolDefinition<Input> {
  readonly description: string
  readonly example: string
  readonly inputSchema: Schema.Codec<Input, unknown, never, never>
  readonly name: string
  readonly run: (input: Input) => Effect.Effect<unknown, ClientToolError>
}

export interface AnyClientTool {
  readonly description: string
  readonly example: string
  readonly inputSchema: Schema.Codec<unknown, unknown, never, never>
  readonly name: string
  readonly run: (input: unknown) => Effect.Effect<unknown, ClientToolError>
}

export const defineClientTool = <Input>(tool: ClientToolDefinition<Input>): AnyClientTool => ({
  ...tool,
  inputSchema: tool.inputSchema as unknown as Schema.Codec<unknown, unknown, never, never>,
  run: (input) => Schema.decodeUnknownEffect(tool.inputSchema)(input).pipe(
    Effect.mapError((cause) => new ClientToolError({ message: cause.message, tool: tool.name })),
    Effect.flatMap(tool.run)
  )
})

export const openAiToolDefinition = (tool: AnyClientTool) => ({
  description: tool.description,
  name: tool.name,
  parameters: Schema.toJsonSchemaDocument(tool.inputSchema).schema,
  type: "function" as const
})

export const executeClientTool = Effect.fn("ClientToolRegistry.execute")(
  function*(tools: ReadonlyArray<AnyClientTool>, name: string, input: unknown) {
    const tool = tools.find((candidate) => candidate.name === name)
    if (tool === undefined)
      return yield* new ClientToolError({ message: `Unknown client tool: ${name}`, tool: name })
    return yield* tool.run(input)
  }
)

export const executeClientToolPromise = (tools: ReadonlyArray<AnyClientTool>, name: string, input: unknown) =>
  Effect.runPromise(executeClientTool(tools, name, input))

export const serializeToolOutput = (output: unknown) =>
  typeof output === "string" ? output : JSON.stringify(output)
