import assert from "node:assert/strict";
import test from "node:test";
import {
  createNavigationHistory,
  mouseNavigationDirection,
  navigationTarget,
  recordNavigation,
} from "./navigationHistory.ts";

test("maps the browser-style side mouse buttons to back and forward", () => {
  assert.equal(mouseNavigationDirection(3), -1);
  assert.equal(mouseNavigationDirection(4), 1);
  assert.equal(mouseNavigationDirection(0), null);
  assert.equal(mouseNavigationDirection(2), null);
});

test("moves backward and forward through visited files", () => {
  let history = createNavigationHistory();
  history = recordNavigation(history, "A.ts");
  history = recordNavigation(history, "B.ts");
  history = recordNavigation(history, "C.ts");

  assert.deepEqual(navigationTarget(history, -1), { path: "B.ts", index: 1 });

  history = { ...history, index: 1 };
  assert.deepEqual(navigationTarget(history, 1), { path: "C.ts", index: 2 });
});

test("does not duplicate consecutive activations", () => {
  let history = recordNavigation(createNavigationHistory(), "A.ts");
  const same = recordNavigation(history, "A.ts");

  assert.deepEqual(same, history);
});

test("opening a file after going back replaces the forward branch", () => {
  let history = createNavigationHistory();
  history = recordNavigation(history, "A.ts");
  history = recordNavigation(history, "B.ts");
  history = recordNavigation(history, "C.ts");
  history = { ...history, index: 1 };
  history = recordNavigation(history, "D.ts");

  assert.deepEqual(history, {
    entries: ["A.ts", "B.ts", "D.ts"],
    index: 2,
  });
  assert.equal(navigationTarget(history, 1), null);
});
