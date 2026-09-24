import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";
import "@testing-library/jest-dom/vitest";

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});

// jsdom does not implement smooth-scroll navigation; the portal calls it on profile open.
if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}
