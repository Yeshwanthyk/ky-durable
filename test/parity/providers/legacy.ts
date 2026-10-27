import { pollDevice, refreshLogin, startDevice } from "../../../src/providers/legacy/chatgpt";
import { Models } from "../../../src/providers/legacy/models";
import type { Side } from "./world";

export const legacy: Side = {
  models: (storage, boundary, vault, machines, pipe) => new Models(storage, boundary, vault, machines, pipe),
  startDevice,
  pollDevice,
  refreshLogin,
  timed: async (clock, work) => {
    const real = Date.now;

    Date.now = () => clock.now();

    try {
      return await work();
    } finally {
      Date.now = real;
    }
  }
};
