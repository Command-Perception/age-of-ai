import { deploymentTools } from "./deployment-tools.ts"
import { toolDefinition } from "@tanstack/ai"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ClientToolError, defineClientTool, executeClientToolPromise, type AnyClientTool } from "./index.ts"

const WeatherInput = Schema.Struct({ city: Schema.String })
const WaitInput = Schema.Struct({ milliseconds: Schema.Number })
const TimeInput = Schema.Struct({ timezone: Schema.optional(Schema.String) })
const CalculateInput = Schema.Struct({
  left: Schema.Number,
  operation: Schema.Literals(["add", "subtract", "multiply", "divide"]),
  right: Schema.Number
})

const WeatherLocation = Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number, name: Schema.String, country: Schema.optional(Schema.String) });
const GeocodeResponse = Schema.Struct({ results: Schema.optional(Schema.Array(WeatherLocation)) });
const CurrentWeather = Schema.Struct({ current: Schema.Struct({ time: Schema.String, temperature_2m: Schema.Number, apparent_temperature: Schema.Number, weather_code: Schema.Number, wind_speed_10m: Schema.Number }) });
// Coordinates are stable; weather itself is always fetched fresh.
const locations = new Map<string, { location: typeof WeatherLocation.Type; expires: number }>();

const locateCity = Effect.fnUntraced(function* (city: string) {
  const key = city.trim().toLocaleLowerCase();
  const cached = locations.get(key);
  if (cached && cached.expires > Date.now()) return cached.location;
  const response = yield* Effect.tryPromise({
    try: () => fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`),
    catch: (cause) => new ClientToolError({ message: String(cause), tool: "get_weather" }),
  });
  if (!response.ok) yield* Effect.fail(new ClientToolError({ message: `Weather location lookup failed (${response.status})`, tool: "get_weather" }));
  const decoded = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new ClientToolError({ message: String(cause), tool: "get_weather" }),
  }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(GeocodeResponse)(raw)),
    Effect.mapError((cause) => cause instanceof ClientToolError ? cause : new ClientToolError({ message: String(cause), tool: "get_weather" })),
  );
  if (decoded.results === undefined || decoded.results[0] === undefined)
    return yield* Effect.fail(new ClientToolError({ message: `No weather location found for ${city}`, tool: "get_weather" }));
  const location = decoded.results[0];
  if (location === undefined) return yield* Effect.fail(new ClientToolError({ message: `No weather location found for ${city}`, tool: "get_weather" }));
  if (locations.size >= 64) { const oldest = locations.keys().next().value; if (oldest !== undefined) locations.delete(oldest); }
  locations.set(key, { location, expires: Date.now() + 24 * 60 * 60 * 1000 });
  return location;
});

const getWeather = defineClientTool({
  description: "Get the current weather for a city using a browser-side public weather request.",
  example: "What is the weather in Philadelphia?",
  inputSchema: WeatherInput,
  name: "get_weather",
  run: ({ city }) => Effect.gen(function* () {
    const location = yield* locateCity(city);
    const forecast: unknown = yield* Effect.tryPromise({
      try: () => fetch(`https://api.open-meteo.com/v1/forecast?current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto&latitude=${location.latitude}&longitude=${location.longitude}`).then((weather) => {
        if (!weather.ok) throw new Error(`Weather request failed (${weather.status})`);
        return weather.json();
      }),
      catch: (cause) => new ClientToolError({ message: String(cause), tool: "get_weather" }),
    });
    const { current } = yield* Effect.mapError(
      Schema.decodeUnknownEffect(CurrentWeather)(forecast),
      (cause) => new ClientToolError({ message: String(cause), tool: "get_weather" }),
    );
    return {
      location: `${location.name}${location.country === undefined ? "" : `, ${location.country}`}`,
      temperature_c: current.temperature_2m, feels_like_c: current.apparent_temperature,
      weather_code: current.weather_code, wind_kmh: current.wind_speed_10m, local_time: current.time,
    };
  }),
})

const wait = defineClientTool({
  description: "Resolve a small asynchronous browser promise after a requested delay between 100 and 3000 milliseconds.",
  example: "Wait 750 milliseconds, then tell me it finished.",
  inputSchema: WaitInput,
  name: "wait",
  run: ({ milliseconds }) => {
    const duration = Math.max(100, Math.min(3_000, Math.round(milliseconds)))
    return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, duration))).pipe(
      Effect.as({ elapsedMilliseconds: duration, status: "completed" })
    )
  }
})

const getCurrentTime = defineClientTool({
  description: "Get the current time in an optional IANA timezone from the user's browser.",
  example: "What time is it in Tokyo?",
  inputSchema: TimeInput,
  name: "get_current_time",
  run: ({ timezone }) => Effect.try({
    try: () => ({
      formatted: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        ...(timezone === undefined ? {} : { timeZone: timezone })
      }).format(new Date()),
      timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    }),
    catch: (cause) => new ClientToolError({ message: String(cause), tool: "get_current_time" })
  })
})

const calculate = defineClientTool({
  description: "Perform one basic arithmetic operation in the browser.",
  example: "Multiply 17 by 23.",
  inputSchema: CalculateInput,
  name: "calculate",
  run: ({ left, operation, right }) => {
    if (operation === "divide" && right === 0)
      return Effect.fail(new ClientToolError({ message: "Cannot divide by zero", tool: "calculate" }))
    const result = operation === "add" ? left + right
      : operation === "subtract" ? left - right
      : operation === "multiply" ? left * right
      : left / right
    return Effect.succeed({ result })
  }
})

export const sampleClientTools: ReadonlyArray<AnyClientTool> = [getWeather, wait, getCurrentTime, calculate, ...deploymentTools]

export const sampleTanStackTools = sampleClientTools.map((tool) =>
  toolDefinition({
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name
  }).client((input) => executeClientToolPromise(sampleClientTools, tool.name, input))
)
