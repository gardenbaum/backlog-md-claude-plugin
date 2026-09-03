import { test } from "node:test";
import assert from "node:assert/strict";
import { compoundCriteria, compoundNotice, criteriaInCommand } from "../../lib/criteria.mjs";

test("a criterion carrying two assertions is named, whichever way it joins them", () => {
  assert.deepEqual(
    compoundCriteria([
      "The file exists.",
      "The file exists and the build passes.",
      "Der Pfad folgt der Konvention; die Datei wird spaeter befuellt.",
      "The frontmatter has title, description, publishedAt, status, register.",
      "Es gibt vier Abschnitte sowie ein Glossar.",
    ]),
    [2, 3, 4, 5],
  );
});

test("a parenthetical clarifies one assertion rather than adding three", () => {
  assert.deepEqual(
    compoundCriteria(["Register is business (not engineering, not gesellschaft, not beobachtung)."]),
    [],
  );
});

// The criterion this check exists for, verbatim from the run that wrote it by
// hand after the create-time check had already passed (BCC-10, edgemaker).
test("the criterion that slipped through as a hand-written edit is caught", () => {
  assert.deepEqual(
    compoundCriteria([
      "Der Pfad im Frontmatter folgt der Konvention /images/posts/slug-exklusiv.jpg; die Datei selbst wird spaeter ausserhalb dieser Aufgabe befuellt (Keystatic-Upload).",
    ]),
    [1],
  );
});

test("criteria are read out of the commands that write them", () => {
  assert.deepEqual(criteriaInCommand("backlog task edit BCC-1 --ac 'one and two' --ac \"three\""), [
    "one and two",
    "three",
  ]);
  assert.deepEqual(criteriaInCommand("backlog task create 'T' --acceptance-criteria 'a' --acceptance-criteria 'b'"), [
    "a",
    "b",
  ]);
});

test("criteria are read only out of a command that writes them", () => {
  assert.deepEqual(criteriaInCommand("echo --ac 'one and two'"), []);
  assert.deepEqual(criteriaInCommand("backlog task list --plain"), []);
  assert.deepEqual(criteriaInCommand("backlog task edit BCC-1 --check-ac 3"), []);
  assert.deepEqual(criteriaInCommand(undefined), []);
});

// Both ways out of a compound criterion have a cost the CLI does not mention,
// and a notice that names neither sends the reader to the one that silently
// clears their checkmarks (BCC-10).
test("one flagged criterion is a criterion, not criteria", () => {
  assert.match(compoundNotice([1], { id: "BCC-1" }), /^Criterion #1 carries/);
  assert.match(compoundNotice([1, 3], { id: "BCC-1" }), /^Criteria #1, #3 carry/);
});

// The check reads "und" as a join, so a bound written with one gets flagged. A
// run split "mindestens 80 und höchstens 200 Zeichen" into two criteria and
// measured the same string twice (BCC-11).
test("the notice says a bound is one assertion however many numbers it names", () => {
  assert.match(compoundNotice([1], { id: "BCC-1" }), /One measurement is one assertion/);
  assert.match(compoundNotice([1], { id: "BCC-1" }), /a range, a span, a minimum with a maximum/);
});

test("the notice names the native call, the CLI form, and what each of them costs", () => {
  const text = compoundNotice([2, 4], { id: "BCC-1" });
  assert.match(text, /Criteria #2, #4 carry/);
  assert.match(text, /backlog_edit_ac/);
  assert.match(text, /backlog task edit BCC-1 --remove-ac/);
  assert.match(text, /work from the highest index down/);
  assert.match(text, /land at the end of the list/);
  assert.match(text, /clears every checkmark/);
});

test("a warning fired before the command runs does not pretend to know the indices", () => {
  assert.match(compoundNotice([1], { id: "BCC-1", inTask: false }), /One of the criteria in this command carries/);
  assert.match(compoundNotice([1, 2], { id: "BCC-1", inTask: false }), /2 of the criteria in this command carry/);
});
