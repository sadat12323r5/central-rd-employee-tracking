import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});

// jsdom does not implement smooth-scroll navigation; the portal calls it on profile open.
if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}
