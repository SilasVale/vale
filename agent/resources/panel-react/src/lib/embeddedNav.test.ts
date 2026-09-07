import { describe, expect, it } from "vitest";
import { shouldAcceptNavPush } from "./embeddedNav";

describe("shouldAcceptNavPush (focus-trap merge rule)", () => {
  it("follows pushes when not editing", () => {
    expect(
      shouldAcceptNavPush({
        editing: false,
        inputValue: "https://a.example/",
        valueAtFocus: "",
        lastPushedUrl: "https://a.example/",
      }),
    ).toBe(true);
  });

  it("follows pushes when focused but nothing typed", () => {
    // Clicked the bar, then clicked the native view (blur never fires):
    // value still equals what it was at focus time — must not freeze.
    expect(
      shouldAcceptNavPush({
        editing: true,
        inputValue: "https://a.example/",
        valueAtFocus: "https://a.example/",
        lastPushedUrl: "https://a.example/",
      }),
    ).toBe(true);
  });

  it("follows pushes when already in sync with last push", () => {
    expect(
      shouldAcceptNavPush({
        editing: true,
        inputValue: "https://b.example/",
        valueAtFocus: "https://a.example/",
        lastPushedUrl: "https://b.example/",
      }),
    ).toBe(true);
  });

  it("keeps unsent user edits (no clobber while typing)", () => {
    expect(
      shouldAcceptNavPush({
        editing: true,
        inputValue: "https://user-typing",
        valueAtFocus: "https://a.example/",
        lastPushedUrl: "https://b.example/",
      }),
    ).toBe(false);
  });
});
