import { create } from "zustand";
import { persist } from "zustand/middleware";

interface State {
  __INITIAL_STATE_TYPES__;
  actions: {
    __ACTIONS_TYPES__;
  };
}

const __STORE_NAME__ = create(
  persist<State>(
    (set) => ({
      __INITIAL_STATE__,
      actions: {
        __ACTIONS__,
      },
    }),
    {
      name: "__STORE_NAME__",
    }
  )
);

export default __STORE_NAME__;
