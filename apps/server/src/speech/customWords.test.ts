import { describe, expect, it } from "vite-plus/test";

import {
  applySpeechCustomWords,
  applySpeechAliases,
  normalizeSpeechCustomWords,
} from "./customWords.ts";

describe("speech custom words", () => {
  it.each([
    ["hello handee", ["Handy"], "hello Handy"],
    ["use Chat G P T today", ["ChatGPT"], "use ChatGPT today"],
    ["CHARGE B is ready", ["ChargeBee"], "CHARGEBEE is ready"],
    ["send it to R and D.", ["R&D"], "send it to R&D."],
    ["「Handee。」", ["Handy"], "「Handy。」"],
  ])("corrects %s", (text, words, expected) => {
    expect(applySpeechCustomWords(text, words)).toBe(expected);
  });

  it("does not fuzzily replace CJK terms", () => {
    expect(applySpeechCustomWords("你好。", ["你号"])).toBe("你好。");
  });

  it("preserves whitespace around fuzzy corrections", () => {
    expect(applySpeechCustomWords("  hello\n\nhandee   friend\t", ["Handy"])).toBe(
      "  hello\n\nHandy   friend\t",
    );
    expect(applySpeechCustomWords("first line\nsecond line", ["Handy"])).toBe(
      "first line\nsecond line",
    );
    expect(applySpeechCustomWords("Chat\nG P T", ["ChatGPT"])).toBe("Chat\nG P T");
  });

  it("normalizes and deduplicates terms and aliases", () => {
    expect(
      normalizeSpeechCustomWords([
        { term: "  T3   Code ", aliases: ["T three code"] },
        { term: "T3 Code", aliases: [] },
        { term: " Effect ", aliases: ["T three code"] },
      ]),
    ).toEqual([
      { term: "T3 Code", aliases: ["T three code"] },
      { term: "Effect", aliases: [] },
    ]);
  });

  it("replaces aliases as complete phrases without changing punctuation", () => {
    const words = [{ term: "MiniMax", aliases: ["mini max", "minimum max"] }];
    expect(applySpeechAliases("Use mini max, not mini maximum.", words)).toBe(
      "Use MiniMax, not mini maximum.",
    );
    expect(applySpeechAliases("Use minimum max!", words)).toBe("Use MiniMax!");
  });
});
