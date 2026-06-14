import assert from "node:assert/strict";
import test from "node:test";

import { chooseIdea, rolesForSeats } from "../src/catalog.ts";

test("idea shuffle is deterministic and compatible with the room size", () => {
  const idea = chooseIdea("room-123", 3);
  assert.ok(idea.minPeople <= 3);
  assert.ok(idea.maxPeople >= 3);
  assert.equal(chooseIdea("room-123", 3).id, idea.id);
});

test("role assignment fills every seat", () => {
  const roles = rolesForSeats(6);
  assert.equal(roles.length, 6);
  assert.equal(roles[0]?.id, "product-integration");
  assert.equal(roles[5]?.id, "product-integration");
});
