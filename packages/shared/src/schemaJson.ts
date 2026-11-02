import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const decodeJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeExit(Schema.fromJsonString(schema));
  return (input: string) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const parseLenientJsonGetter = SchemaGetter.transformEffect((input: string) => {
  // Match comments together so URLs stay inside blocks; whitespace keeps adjacent tokens apart.
  let stripped = input.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : " "),
  );

  stripped = stripped.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, stringLiteral: string | undefined, bracket: string | undefined) =>
      stringLiteral ? match : (bracket ?? ""),
  );

  return decodeJsonString(stripped).pipe(Effect.mapError((error) => error.issue));
});

const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

const prettyJsonString = SchemaGetter.parseJson<string>().pipe(
  SchemaGetter.compose(SchemaGetter.stringifyJson({ space: 2 })),
);

export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

/**
 * Escapes raw control characters inside JSON string literals. Models that write JSON as plain text
 * often put literal newlines or tabs in long strings, which `JSON.parse` rejects.
 */
export function escapeJsonStringControlCharacters(json: string): string {
  let result = "";
  let inString = false;
  let escaping = false;
  for (const char of json) {
    if (!inString) {
      if (char === '"') inString = true;
      result += char;
      continue;
    }
    if (escaping) {
      escaping = false;
      result += char;
      continue;
    }
    if (char === "\\") escaping = true;
    else if (char === '"') inString = false;
    const code = char.charCodeAt(0);
    if (code >= 0x20) {
      result += char;
      continue;
    }
    result +=
      char === "\n"
        ? "\\n"
        : char === "\r"
          ? "\\r"
          : char === "\t"
            ? "\\t"
            : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return result;
}

export const fromJsonStringPretty = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(schema).pipe(
    Schema.encode({
      decode: prettyJsonString,
      encode: prettyJsonString,
    }),
  );
