import assert from "node:assert/strict";
import test from "node:test";
import {
  countCharacterNameMentions,
  matchCharacterNames,
  normalizeCharacterToken,
  parseCharacterTokens,
  recurringCharacterRoster,
} from "./character";

test("normalizes character tokens", () => {
  assert.equal(normalizeCharacterToken("ancestor"), "@ANCESTOR");
  assert.equal(normalizeCharacterToken(" @hero_02 "), "@HERO_02");
  assert.equal(normalizeCharacterToken("@"), null);
  assert.equal(normalizeCharacterToken("two words"), null);
  assert.equal(normalizeCharacterToken("bad-token"), null);
});

test("parses unique tokens in prompt order", () => {
  assert.deepEqual(
    parseCharacterTokens(
      "@ancestor walks with @HERO_02. Later @Ancestor appears again.",
    ),
    ["@ANCESTOR", "@HERO_02"],
  );
});

test("does not parse email fragments as character tokens", () => {
  assert.deepEqual(parseCharacterTokens("Send mail to user@example.com"), []);
});

test("detects recurring library characters by natural-language name", () => {
  const characters = [
    { token: "@GULLIT", name: "Gullit" },
    { token: "@LAN", name: "Lân" },
    { token: "@AN", name: "An" },
  ];
  const source = "Gullit bước vào sân. Sau đó GULLIT quay lại. Lân chỉ được nhắc một lần. Andrew đứng ngoài.";
  assert.equal(countCharacterNameMentions(source, "Gullit"), 2);
  assert.equal(countCharacterNameMentions(source, "Lân"), 1);
  assert.equal(countCharacterNameMentions(source, "An"), 0);
  assert.deepEqual(recurringCharacterRoster(source, characters), [
    { token: "@GULLIT", name: "Gullit" },
  ]);
  assert.deepEqual(
    matchCharacterNames("SUBJECT AND ACTION: Gullit raises one arm.", characters),
    ["@GULLIT"],
  );
});
