import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownFlags, unknownFlagsMessage } from "../src/commands/flags.js";

const SALON = new Set(["clair", "startup", "role"]);

test("unknownFlags: no option at all", () => {
  assert.deepEqual(unknownFlags("Mon Salon", SALON), []);
});

test("unknownFlags: every known option passes", () => {
  assert.deepEqual(
    unknownFlags('Mon Salon "Pole Tech" --clair --startup cartobio --role dev', SALON),
    [],
  );
});

test("unknownFlags: a mistyped --startip is reported, not swallowed into the name", () => {
  assert.deepEqual(unknownFlags("Mon Salon --startip cartobio", SALON), ["startip"]);
});

test("unknownFlags: reports several at once, lowercased", () => {
  assert.deepEqual(unknownFlags("Mon Salon --Clar --xyz", SALON), ["clar", "xyz"]);
});

test("unknownFlags: an option VALUE is never mistaken for an option", () => {
  assert.deepEqual(unknownFlags('Mon Salon --startup "a --b"', SALON), []);
});

test("unknownFlags: a `--` inside a quoted name is text, not an option", () => {
  assert.deepEqual(unknownFlags('"Projet --Alpha" --clair', SALON), []);
});

test("unknownFlags: a name containing a hyphen pair is left alone", () => {
  assert.deepEqual(unknownFlags("mon--salon --clair", SALON), []);
});

test("unknownFlagsMessage: names the culprit and lists what is accepted", () => {
  const msg = unknownFlagsMessage(["startip"], ["clair", "startup"], "/salon help");
  assert.match(msg, /`--startip`/);
  assert.match(msg, /`--clair`, `--startup`/);
  assert.match(msg, /`\/salon help`/);
});
