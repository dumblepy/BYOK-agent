import { describe, expect, it } from "vitest";

import type { ProviderEvent } from "../../src/providers/provider-types";
import {
  collectProviderEvents,
  createFixtureFetch,
  type ProviderContractAdapterDefinition,
} from "./adapter-harness";

export function runProviderContractSuite(definition: ProviderContractAdapterDefinition): void {
  describe(`${definition.name} Provider Contract`, () => {
    for (const testCase of definition.cases) {
      it(testCase.id, async () => {
        const controller = new AbortController();
        if (testCase.abort === "before-request") controller.abort();
        const fixture = testCase.fixture ?? { chunks: [] };
        const { fetchImpl, observation } = createFixtureFetch(
          fixture,
          testCase.abort === "during-stream",
        );
        const adapter = definition.createAdapter(fetchImpl);
        const requestSignal = controller.signal;
        const events = await collectProviderEvents(
          adapter,
          requestSignal,
          testCase.request,
          (event) => {
            if (testCase.abort === "during-stream" && event.type === "text-delta") {
              controller.abort();
            }
          },
        );

        if (testCase.abort === "before-request") {
          expect(events).toEqual([{ type: "cancelled" }]);
          expect(observation.fetch).not.toHaveBeenCalled();
          return;
        }
        if (testCase.abort === "during-stream") {
          expect(events[events.length - 1]).toEqual({ type: "cancelled" });
          expect(events.some((event) => event.type === "completed")).toBe(false);
          expect(observation.getSignal()?.aborted).toBe(true);
          return;
        }

        expectTerminalContract(events);
        if (testCase.expectedError) {
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({ type: "error", error: testCase.expectedError });
          return;
        }
        expect(events).toEqual(testCase.expected);
      });
    }
  });
}

function expectTerminalContract(events: readonly ProviderEvent[]): void {
  const terminalIndexes = events
    .map((event, index) => (isTerminal(event) ? index : -1))
    .filter((index) => index >= 0);
  expect(terminalIndexes).toHaveLength(1);
  expect(terminalIndexes[0]).toBe(events.length - 1);
}

function isTerminal(event: ProviderEvent): boolean {
  return event.type === "completed" || event.type === "error" || event.type === "cancelled";
}
